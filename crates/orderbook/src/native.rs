use alloc::string::String;
use alloc::vec::Vec;

use crate::engine::MatchingEngine;
use crate::types::{BookLevel, BookSnapshot, Fill, MatchError, Order, PlaceOutcome, Side};

/// Native price-time-priority orderbook for a single instrument.
///
/// A faithful port of the tested `@inference-bazaar/market-core` `OrderBook`: bids kept
/// descending, asks ascending, FIFO within a price level; match on insert at the
/// maker's price; self-match prevention cancels the resting maker rather than
/// printing a wash trade. Depth in this market is operator quotes, not HFT flow,
/// so linear inserts are deliberate — correctness and auditability first.
pub struct NativeBook {
    instrument_id: String,
    tick_size: i64,
    min_qty: i64,
    bids: Vec<Order>,
    asks: Vec<Order>,
    last_trade_price: Option<i64>,
}

impl NativeBook {
    pub fn new(instrument_id: impl Into<String>, tick_size: i64, min_qty: i64) -> Self {
        NativeBook {
            instrument_id: instrument_id.into(),
            tick_size,
            min_qty,
            bids: Vec::new(),
            asks: Vec::new(),
            last_trade_price: None,
        }
    }

    pub fn last_trade_price(&self) -> Option<i64> {
        self.last_trade_price
    }

    /// Mid of best bid/ask, falling back to the last trade.
    pub fn mid(&self) -> Option<i64> {
        match (self.best_bid(), self.best_ask()) {
            (Some(b), Some(a)) => Some((b + a) / 2),
            _ => self.last_trade_price,
        }
    }

    fn validate(&self, o: &Order) -> Result<(), MatchError> {
        if o.instrument_id != self.instrument_id {
            return Err(MatchError::WrongInstrument {
                expected: self.instrument_id.clone(),
                got: o.instrument_id.clone(),
            });
        }
        if o.price <= 0 {
            return Err(MatchError::InvalidPrice(o.price));
        }
        if o.price % self.tick_size != 0 {
            return Err(MatchError::OffTick {
                price: o.price,
                tick: self.tick_size,
            });
        }
        if o.qty < self.min_qty {
            return Err(MatchError::BelowMinQty {
                qty: o.qty,
                min: self.min_qty,
            });
        }
        Ok(())
    }

    fn id_exists(&self, id: &str) -> bool {
        self.bids.iter().chain(self.asks.iter()).any(|o| o.id == id)
    }

    fn insert(&mut self, order: Order) {
        let book = match order.side {
            Side::Buy => &mut self.bids,
            Side::Sell => &mut self.asks,
        };
        // bids: highest price first; asks: lowest price first; FIFO within a level.
        let mut i = 0;
        while i < book.len() {
            let cur = &book[i];
            let cur_before = match order.side {
                Side::Buy => {
                    cur.price > order.price || (cur.price == order.price && cur.ts <= order.ts)
                }
                Side::Sell => {
                    cur.price < order.price || (cur.price == order.price && cur.ts <= order.ts)
                }
            };
            if !cur_before {
                break;
            }
            i += 1;
        }
        book.insert(i, order);
    }

    fn remove(book: &mut Vec<Order>, id: &str) -> bool {
        if let Some(pos) = book.iter().position(|o| o.id == id) {
            book.remove(pos);
            true
        } else {
            false
        }
    }

    fn levels(book: &[Order], depth: usize) -> Vec<BookLevel> {
        let mut out: Vec<BookLevel> = Vec::new();
        for o in book {
            if let Some(top) = out.last_mut() {
                if top.price == o.price {
                    top.qty += o.qty;
                    top.orders += 1;
                    continue;
                }
            }
            if out.len() == depth {
                break;
            }
            out.push(BookLevel {
                price: o.price,
                qty: o.qty,
                orders: 1,
            });
        }
        out
    }
}

impl MatchingEngine for NativeBook {
    fn instrument_id(&self) -> &str {
        &self.instrument_id
    }

    fn place(&mut self, incoming: Order) -> Result<PlaceOutcome, MatchError> {
        self.validate(&incoming)?;
        if self.id_exists(&incoming.id) {
            return Err(MatchError::DuplicateId(incoming.id));
        }
        let mut taker = incoming;
        let mut fills: Vec<Fill> = Vec::new();

        loop {
            if taker.qty == 0 {
                break;
            }
            // Best opposing maker.
            let maker_book = match taker.side {
                Side::Buy => &mut self.asks,
                Side::Sell => &mut self.bids,
            };
            let Some(maker) = maker_book.first() else {
                break;
            };
            let crosses = match taker.side {
                Side::Buy => maker.price <= taker.price,
                Side::Sell => maker.price >= taker.price,
            };
            if !crosses {
                break;
            }
            // Self-match prevention: cancel the resting maker rather than wash.
            if maker.owner == taker.owner {
                maker_book.remove(0);
                continue;
            }
            let maker = maker_book.first().unwrap();
            let qty = taker.qty.min(maker.qty);
            fills.push(Fill {
                instrument_id: self.instrument_id.clone(),
                maker_order_id: maker.id.clone(),
                taker_order_id: taker.id.clone(),
                maker_owner: maker.owner.clone(),
                taker_owner: taker.owner.clone(),
                price: maker.price,
                qty,
                taker_side: taker.side,
                ts: taker.ts,
            });
            self.last_trade_price = Some(maker.price);
            taker.qty -= qty;
            let maker_mut = maker_book.first_mut().unwrap();
            maker_mut.qty -= qty;
            if maker_mut.qty == 0 {
                maker_book.remove(0);
            }
        }

        if taker.qty > 0 {
            let resting = taker.clone();
            self.insert(taker);
            Ok(PlaceOutcome {
                fills,
                resting: Some(resting),
            })
        } else {
            Ok(PlaceOutcome {
                fills,
                resting: None,
            })
        }
    }

    fn cancel(&mut self, order_id: &str) -> bool {
        Self::remove(&mut self.bids, order_id) || Self::remove(&mut self.asks, order_id)
    }

    fn best_bid(&self) -> Option<i64> {
        self.bids.first().map(|o| o.price)
    }

    fn best_ask(&self) -> Option<i64> {
        self.asks.first().map(|o| o.price)
    }

    fn snapshot(&self, depth: usize) -> BookSnapshot {
        BookSnapshot {
            instrument_id: self.instrument_id.clone(),
            bids: Self::levels(&self.bids, depth),
            asks: Self::levels(&self.asks, depth),
            last_trade_price: self.last_trade_price,
        }
    }

    fn open_orders(&self, owner: &str) -> Vec<Order> {
        self.bids
            .iter()
            .chain(self.asks.iter())
            .filter(|o| o.owner == owner)
            .cloned()
            .collect()
    }
}
