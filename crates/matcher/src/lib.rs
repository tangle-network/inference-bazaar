//! Deterministic epoch-batch matcher — the heart of the shared CLOB.
//!
//! Given the canonical-ordered set of signed orders an epoch matcher sequenced
//! (an order's index in the slice IS its time priority — the matcher reads no
//! clock), produce the epoch's crossed fills as the on-chain `BatchFill[]` plus
//! the `fillsHash` the settlement contract recomputes from that calldata.
//!
//! The match reuses the very same [`NativeBook`] engine the venue runs, so it is
//! deterministic and integer-only. That is the whole point: independent peers
//! re-execute this to co-sign a batch (`settleBatchAttested`) and an SP1 circuit
//! reproduces it (`settleBatchProven`), and all of them must converge on the
//! identical `fillsHash`. A throughput-first concurrent engine could not give
//! that guarantee (see `surplus_orderbook::MatchingEngine`).

use std::collections::HashMap;

use surplus_orderbook::{MatchingEngine, NativeBook, Order as BookOrder, Side as BookSide};
use surplus_settlement_core::{
    alloy_primitives::B256, fills_hash, instrument_hash, BatchFill, Order as SignedOrder, SIDE_BUY,
};

/// The deterministic result of matching one epoch's order set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EpochBatch {
    /// Crossed fills in production order — the contract's `BatchFill[]` calldata.
    pub fills: Vec<BatchFill>,
    /// `keccak256(abi.encode(fills))` — what `settleBatch*` recomputes and what
    /// the SP1 program commits. Bit-identical across any correct re-execution.
    pub fills_hash: B256,
}

/// Match a canonical-ordered set of signed orders for one instrument.
///
/// `orders` MUST already be in the matcher's canonical sequence; index order is
/// the sole time-priority signal (the matcher reads no wall clock — that is what
/// lets peers and the circuit reproduce the result). Orders for a different
/// instrument, or that fail the book's tick/min/price validity, are skipped: they
/// produce no fill and the contract would reject them anyway. Self-matches (same
/// `trader` on both sides) are dropped by the engine, never washed.
pub fn match_epoch(
    instrument_id: &str,
    tick_size: i64,
    min_qty: i64,
    orders: &[SignedOrder],
) -> EpochBatch {
    let want_instrument = instrument_hash(instrument_id);
    let mut book = NativeBook::new(instrument_id, tick_size, min_qty);
    // book-order id (canonical index) -> the signed order it stands for, so a
    // book fill (which carries ids) can be lifted back to the two signed orders.
    let mut by_id: HashMap<String, SignedOrder> = HashMap::new();
    let mut fills: Vec<BatchFill> = Vec::new();

    for (i, so) in orders.iter().enumerate() {
        if so.instrument != want_instrument {
            continue;
        }
        let (Ok(price), Ok(qty)) = (
            i64::try_from(so.priceMicroPerM),
            i64::try_from(so.qtyTokens),
        ) else {
            continue; // value outside the integer book domain — unmatchable
        };
        let id = format!("o{i}");
        let book_order = BookOrder {
            id: id.clone(),
            instrument_id: instrument_id.to_string(),
            side: if so.side == SIDE_BUY {
                BookSide::Buy
            } else {
                BookSide::Sell
            },
            price,
            qty,
            owner: format!("{:#x}", so.trader),
            ts: i as i64,
        };
        let outcome = match book.place(book_order) {
            Ok(o) => o,
            Err(_) => continue, // off-tick / below-min / duplicate
        };
        // Register the taker (this order) before reading its fills; the maker on
        // the other side was registered in an earlier iteration.
        by_id.insert(id, so.clone());
        for f in &outcome.fills {
            let (Some(maker), Some(taker)) =
                (by_id.get(&f.maker_order_id), by_id.get(&f.taker_order_id))
            else {
                continue; // unreachable: every printed fill names two known orders
            };
            let (buy, sell) = if taker.side == SIDE_BUY {
                (taker, maker)
            } else {
                (maker, taker)
            };
            fills.push(BatchFill {
                buy: buy.clone(),
                sell: sell.clone(),
                qtyTokens: f.qty as u64,
                execPriceMicroPerM: f.price as u64,
            });
        }
    }

    let fills_hash = fills_hash(&fills);
    EpochBatch { fills, fills_hash }
}

#[cfg(test)]
mod tests {
    use super::*;
    use surplus_settlement_core::alloy_primitives::Address;
    use surplus_settlement_core::SIDE_SELL;

    fn order(side: u8, price: u64, qty: u64, trader: u8) -> SignedOrder {
        SignedOrder {
            instrument: instrument_hash("m"),
            side,
            priceMicroPerM: price,
            qtyTokens: qty,
            lotId: B256::ZERO,
            trader: Address::with_last_byte(trader),
            expiry: u64::MAX,
            salt: B256::ZERO,
        }
    }

    /// A resting sell lifted by a crossing buy → one BatchFill at the maker's
    /// (resting sell's) price, buy/sell sides assigned from the signed orders.
    #[test]
    fn crossing_orders_produce_one_batchfill() {
        let orders = [
            order(SIDE_SELL, 100, 10, 2), // rests first
            order(SIDE_BUY, 100, 10, 1),  // crosses
        ];
        let batch = match_epoch("m", 1, 1, &orders);
        assert_eq!(batch.fills.len(), 1);
        let f = &batch.fills[0];
        assert_eq!(f.buy.trader, Address::with_last_byte(1));
        assert_eq!(f.sell.trader, Address::with_last_byte(2));
        assert_eq!(f.qtyTokens, 10);
        assert_eq!(f.execPriceMicroPerM, 100); // maker price
    }

    /// The load-bearing property: the same order set yields a bit-identical
    /// fillsHash on every run. This is what makes Attested/Proven possible.
    #[test]
    fn fills_hash_is_deterministic() {
        let orders = [
            order(SIDE_SELL, 100, 10, 2),
            order(SIDE_SELL, 102, 10, 3),
            order(SIDE_BUY, 103, 15, 1),
        ];
        let a = match_epoch("m", 1, 1, &orders);
        let b = match_epoch("m", 1, 1, &orders);
        assert_eq!(a.fills_hash, b.fills_hash);
        assert_eq!(a, b);
        // And it equals the contract's recompute over the produced fills.
        assert_eq!(a.fills_hash, fills_hash(&a.fills));
    }

    /// Price-time priority across two resting sells: the buy fills the better/
    /// earlier maker first, FIFO.
    #[test]
    fn price_time_priority_fifo() {
        let orders = [
            order(SIDE_SELL, 100, 10, 2), // ts 0
            order(SIDE_SELL, 100, 10, 3), // ts 1, same price → behind 2
            order(SIDE_BUY, 100, 15, 1),  // takes 10 from #2, 5 from #3
        ];
        let batch = match_epoch("m", 1, 1, &orders);
        assert_eq!(batch.fills.len(), 2);
        assert_eq!(batch.fills[0].sell.trader, Address::with_last_byte(2));
        assert_eq!(batch.fills[0].qtyTokens, 10);
        assert_eq!(batch.fills[1].sell.trader, Address::with_last_byte(3));
        assert_eq!(batch.fills[1].qtyTokens, 5);
    }

    #[test]
    fn no_cross_no_fill() {
        let orders = [order(SIDE_BUY, 99, 10, 1), order(SIDE_SELL, 101, 10, 2)];
        let batch = match_epoch("m", 1, 1, &orders);
        assert!(batch.fills.is_empty());
        assert_eq!(batch.fills_hash, fills_hash(&[]));
    }

    /// Same trader on both sides must not wash-trade.
    #[test]
    fn self_match_is_not_washed() {
        let orders = [
            order(SIDE_SELL, 100, 10, 7),
            order(SIDE_BUY, 100, 10, 7), // same trader
        ];
        let batch = match_epoch("m", 1, 1, &orders);
        assert!(batch.fills.is_empty());
    }

    /// Orders for another instrument are ignored, not matched.
    #[test]
    fn foreign_instrument_skipped() {
        let mut foreign = order(SIDE_SELL, 100, 10, 2);
        foreign.instrument = instrument_hash("other");
        let orders = [foreign, order(SIDE_BUY, 100, 10, 1)];
        let batch = match_epoch("m", 1, 1, &orders);
        assert!(batch.fills.is_empty());
    }
}
