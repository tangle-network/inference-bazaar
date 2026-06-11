//! The venue — the "main thing". Hosts the open orderbook per instrument,
//! delegates quoting to the mm-sidecar, tracks inventory from fills, and emits
//! settlement intents. Both the lite HTTP bin and the blueprint bin
//! (BlueprintRunner) drive THIS — the lib is the single source of the market.

use crate::config::{Instrument, OperatorConfig};
use crate::sidecar::SidecarClient;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use surplus_orderbook::{Fill, MatchingEngine, NativeBook, Order, Side};

/// The operator's own market-making orders carry this owner so it can
/// cancel-replace them each tick and attribute fills to its inventory.
pub const MM_OWNER: &str = "operator-mm";

#[derive(Debug)]
pub enum VenueError {
    NotFound(String),
    Rejected(String),
    NoReference,
    Sidecar(String),
}

impl std::fmt::Display for VenueError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VenueError::NotFound(s) => write!(f, "unknown instrument: {s}"),
            VenueError::Rejected(s) => write!(f, "order rejected: {s}"),
            VenueError::NoReference => write!(f, "no reference price set"),
            VenueError::Sidecar(s) => write!(f, "sidecar error: {s}"),
        }
    }
}

impl std::error::Error for VenueError {}

struct InstrumentVenue {
    book: NativeBook,
    ref_mid: f64,
    inventory_tokens: i64,
    drawdown_micro: f64,
}

pub struct Venue {
    pub cfg: OperatorConfig,
    sidecar: SidecarClient,
    venues: Mutex<HashMap<String, InstrumentVenue>>,
    seq: AtomicU64,
}

impl Venue {
    pub fn new(cfg: OperatorConfig) -> Self {
        let sidecar = SidecarClient::new(cfg.sidecar_url.clone());
        let mut venues = HashMap::new();
        for inst in &cfg.instruments {
            venues.insert(inst.id.clone(), InstrumentVenue::from(inst));
        }
        Venue {
            cfg,
            sidecar,
            venues: Mutex::new(venues),
            seq: AtomicU64::new(1),
        }
    }

    pub fn from_env() -> Self {
        Venue::new(OperatorConfig::from_env())
    }

    fn next_id(&self, prefix: &str) -> String {
        format!("{prefix}-{}", self.seq.fetch_add(1, Ordering::Relaxed))
    }

    fn next_ts(&self) -> i64 {
        self.seq.fetch_add(1, Ordering::Relaxed) as i64
    }

    pub fn instruments(&self) -> Vec<Instrument> {
        self.cfg.instruments.clone()
    }

    /// Register a new instrument at runtime (the `list_instrument` job).
    pub fn register_instrument(&self, inst: Instrument) -> Value {
        let mut venues = self.venues.lock().unwrap();
        venues
            .entry(inst.id.clone())
            .or_insert_with(|| InstrumentVenue::from(&inst));
        json!({ "ok": true, "instrumentId": inst.id })
    }

    pub fn set_ref(&self, instrument_id: &str, ref_mid: f64) -> Result<Value, VenueError> {
        let mut venues = self.venues.lock().unwrap();
        let v = venues
            .get_mut(instrument_id)
            .ok_or_else(|| VenueError::NotFound(instrument_id.to_string()))?;
        v.ref_mid = ref_mid;
        Ok(json!({ "ok": true, "refMid": ref_mid }))
    }

    pub fn snapshot(&self, instrument_id: &str) -> Result<Value, VenueError> {
        let venues = self.venues.lock().unwrap();
        let v = venues
            .get(instrument_id)
            .ok_or_else(|| VenueError::NotFound(instrument_id.to_string()))?;
        Ok(json!({
            "book": v.book.snapshot(10),
            "refMid": v.ref_mid,
            "inventoryTokens": v.inventory_tokens,
        }))
    }

    pub fn status(&self) -> Value {
        let venues = self.venues.lock().unwrap();
        let instruments: Vec<Value> = venues
            .iter()
            .map(|(id, v)| {
                json!({
                    "instrumentId": id,
                    "refMid": v.ref_mid,
                    "inventoryTokens": v.inventory_tokens,
                    "bestBid": v.book.best_bid(),
                    "bestAsk": v.book.best_ask(),
                })
            })
            .collect();
        json!({ "ok": true, "instruments": instruments })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn place(
        &self,
        instrument_id: &str,
        side: Side,
        price: i64,
        qty_tokens: i64,
        owner: &str,
        rail: &str,
    ) -> Result<Value, VenueError> {
        let id = self.next_id("ord");
        let order = Order {
            id: id.clone(),
            instrument_id: instrument_id.to_string(),
            side,
            price,
            qty: qty_tokens,
            owner: owner.to_string(),
            ts: self.next_ts(),
        };
        let mut venues = self.venues.lock().unwrap();
        let v = venues
            .get_mut(instrument_id)
            .ok_or_else(|| VenueError::NotFound(instrument_id.to_string()))?;
        let out = v
            .book
            .place(order)
            .map_err(|e| VenueError::Rejected(e.to_string()))?;
        apply_inventory(v, &out.fills);
        let settlements = settlement_intents(&out.fills, rail);
        Ok(json!({
            "orderId": id,
            "fills": out.fills,
            "resting": out.resting,
            "settlements": settlements,
            "inventoryTokens": v.inventory_tokens,
        }))
    }

    pub fn cancel(&self, instrument_id: &str, order_id: &str) -> Result<bool, VenueError> {
        let mut venues = self.venues.lock().unwrap();
        let v = venues
            .get_mut(instrument_id)
            .ok_or_else(|| VenueError::NotFound(instrument_id.to_string()))?;
        Ok(v.book.cancel(order_id))
    }

    /// One market-making tick: pull risk-gated quotes from the sidecar for the
    /// current inventory + reference, cancel the operator's stale quotes, and
    /// post the new bid/ask. The sidecar's verdict is the safety boundary.
    pub async fn mm_tick(&self, instrument_id: &str) -> Result<Value, VenueError> {
        let (ref_mid, inventory, drawdown) = {
            let venues = self.venues.lock().unwrap();
            let v = venues
                .get(instrument_id)
                .ok_or_else(|| VenueError::NotFound(instrument_id.to_string()))?;
            (v.ref_mid, v.inventory_tokens, v.drawdown_micro)
        };
        if ref_mid <= 0.0 {
            return Err(VenueError::NoReference);
        }
        let quote = self
            .sidecar
            .quote(&self.cfg, instrument_id, ref_mid, inventory as f64, drawdown)
            .await
            .map_err(|e| VenueError::Sidecar(e.to_string()))?;

        let mut venues = self.venues.lock().unwrap();
        let v = venues
            .get_mut(instrument_id)
            .ok_or_else(|| VenueError::NotFound(instrument_id.to_string()))?;
        for o in v.book.open_orders(MM_OWNER) {
            v.book.cancel(&o.id);
        }
        if !quote.valid {
            return Ok(json!({
                "quoting": false,
                "reasons": quote.reasons,
                "killSwitch": quote.kill_switch,
            }));
        }

        let mut placed = Vec::new();
        let mut all_fills: Vec<Fill> = Vec::new();
        for (side, q) in [(Side::Buy, &quote.bid), (Side::Sell, &quote.ask)] {
            let Some(q) = q else { continue };
            let order = Order {
                id: self.next_id("mm"),
                instrument_id: instrument_id.to_string(),
                side,
                price: q.price.round() as i64,
                qty: q.qty.round() as i64,
                owner: MM_OWNER.to_string(),
                ts: self.next_ts(),
            };
            let price = order.price;
            let qty = order.qty;
            let out = v
                .book
                .place(order)
                .map_err(|e| VenueError::Rejected(e.to_string()))?;
            all_fills.extend(out.fills.iter().cloned());
            placed.push(json!({
                "side": side, "price": price, "qty": qty, "resting": out.resting.is_some(),
            }));
        }
        apply_inventory(v, &all_fills);
        Ok(json!({
            "quoting": true,
            "placed": placed,
            "fills": all_fills,
            "rationale": quote.rationale,
            "inventoryTokens": v.inventory_tokens,
        }))
    }
}

impl InstrumentVenue {
    fn from(inst: &Instrument) -> Self {
        InstrumentVenue {
            book: NativeBook::new(inst.id.clone(), inst.tick_size, inst.min_qty),
            ref_mid: 0.0,
            inventory_tokens: 0,
            drawdown_micro: 0.0,
        }
    }
}

/// Adjust the operator's inventory for every fill it was a party to. When the MM
/// is maker, its side is the opposite of the taker's; when taker, the same.
fn apply_inventory(v: &mut InstrumentVenue, fills: &[Fill]) {
    for f in fills {
        let mm_side = if f.maker_owner == MM_OWNER {
            Some(f.taker_side.opposite())
        } else if f.taker_owner == MM_OWNER {
            Some(f.taker_side)
        } else {
            None
        };
        if let Some(side) = mm_side {
            v.inventory_tokens += if side == Side::Buy { f.qty } else { -f.qty };
        }
    }
}

/// A settlement intent for each fill where a real buyer traded (not MM-vs-MM).
fn settlement_intents(fills: &[Fill], rail: &str) -> Vec<Value> {
    fills
        .iter()
        .filter_map(|f| {
            let (buyer, operator) = if f.taker_owner != MM_OWNER && f.maker_owner == MM_OWNER {
                (f.taker_owner.clone(), f.maker_owner.clone())
            } else if f.maker_owner != MM_OWNER && f.taker_owner == MM_OWNER {
                (f.maker_owner.clone(), f.taker_owner.clone())
            } else if f.maker_owner != MM_OWNER && f.taker_owner != MM_OWNER {
                (f.taker_owner.clone(), f.maker_owner.clone())
            } else {
                return None;
            };
            Some(json!({
                "orderId": f.taker_order_id,
                "rail": rail,
                "buyer": buyer,
                "operator": operator,
                "qtyTokens": f.qty,
                "price": f.price,
                "notionalMicro": f.notional_micro(),
            }))
        })
        .collect()
}
