//! The venue — the "main thing". Hosts the open orderbook per instrument,
//! delegates quoting to the mm-sidecar, tracks inventory from fills, and emits
//! settlement intents. Both the lite HTTP bin and the blueprint bin
//! (BlueprintRunner) drive THIS — the lib is the single source of the market.

use crate::config::{Instrument, OperatorConfig};
use crate::market::{SettleCtx, SignedState};
use crate::sidecar::SidecarClient;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use surplus_orderbook::{Fill, MatchingEngine, NativeBook, Order, Side};

/// The operator's own market-making orders carry this owner so it can
/// cancel-replace them each tick and attribute fills to its inventory. When a
/// settlement signer is configured the owner is the operator's EVM address
/// instead (see [`Venue::mm_owner`]).
pub const MM_OWNER: &str = "operator-mm";

#[derive(Debug)]
pub enum VenueError {
    NotFound(String),
    Rejected(String),
    NoReference,
    Sidecar(String),
    /// Signed-order / RFQ surface used without SURPLUS_CHAIN_ID +
    /// SURPLUS_SETTLEMENT_ADDR (and a key, where signing is required).
    SettlementUnconfigured(&'static str),
    /// On-chain submission failed; the outbox was restored.
    Chain(String),
}

impl std::fmt::Display for VenueError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VenueError::NotFound(s) => write!(f, "unknown instrument: {s}"),
            VenueError::Rejected(s) => write!(f, "order rejected: {s}"),
            VenueError::NoReference => write!(f, "no reference price set"),
            VenueError::Sidecar(s) => write!(f, "sidecar error: {s}"),
            VenueError::SettlementUnconfigured(what) => {
                write!(f, "settlement not configured: {what}")
            }
            VenueError::Chain(e) => write!(f, "chain submission failed: {e}"),
        }
    }
}

impl std::error::Error for VenueError {}

pub(crate) struct InstrumentVenue {
    pub(crate) book: NativeBook,
    pub(crate) ref_mid: f64,
    pub(crate) inventory_tokens: i64,
    pub(crate) drawdown_micro: f64,
}

pub struct Venue {
    pub cfg: OperatorConfig,
    pub(crate) sidecar: SidecarClient,
    pub(crate) venues: Mutex<HashMap<String, InstrumentVenue>>,
    seq: AtomicU64,
    /// Settlement binding (EIP-712 domain, optional signer). None => legacy-only venue.
    pub(crate) settle: Option<SettleCtx>,
    /// Signed firm orders + the settlement outbox. Lock AFTER `venues`, never before.
    pub(crate) signed: Mutex<SignedState>,
    /// Owner string for the operator's own quotes in the book.
    pub(crate) mm_owner: String,
}

impl Venue {
    pub fn new(cfg: OperatorConfig) -> Self {
        let sidecar = SidecarClient::new(cfg.sidecar_url.clone());
        let mut venues = HashMap::new();
        for inst in &cfg.instruments {
            venues.insert(inst.id.clone(), InstrumentVenue::from(inst));
        }
        let settle = SettleCtx::from_config(cfg.settlement.as_ref());
        let mm_owner = settle
            .as_ref()
            .and_then(SettleCtx::operator_address_hex)
            .unwrap_or_else(|| MM_OWNER.to_string());
        Venue {
            cfg,
            sidecar,
            venues: Mutex::new(venues),
            seq: AtomicU64::new(1),
            settle,
            signed: Mutex::new(SignedState::default()),
            mm_owner,
        }
    }

    /// Owner string the operator's own quotes carry in the book.
    pub fn mm_owner(&self) -> &str {
        &self.mm_owner
    }

    pub fn from_env() -> Self {
        Venue::new(OperatorConfig::from_env())
    }

    pub(crate) fn next_id(&self, prefix: &str) -> String {
        format!("{prefix}-{}", self.seq.fetch_add(1, Ordering::Relaxed))
    }

    pub(crate) fn next_ts(&self) -> i64 {
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
        apply_inventory(v, &out.fills, &self.mm_owner);
        let settlements = settlement_intents(&out.fills, rail, &self.mm_owner);
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
        // Cancel the operator's stale quotes. When they were signed firm orders,
        // also drop them from the signed-order state — their digests carry a
        // fresh salt every tick and never recur, and their signatures are never
        // exposed over HTTP, so nothing can reference them again. Without this
        // the maps would grow ~2 entries/tick forever on a quoted instrument.
        {
            let mut signed = self.signed.lock().unwrap();
            for o in v.book.open_orders(&self.mm_owner) {
                v.book.cancel(&o.id);
                signed.orders.remove(&o.id);
                signed.filled.remove(&o.id);
            }
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
        let mut signed_fill_count = 0usize;
        for (side, q) in [(Side::Buy, &quote.bid), (Side::Sell, &quote.ask)] {
            let Some(q) = q else { continue };
            // When a settlement signer is configured, the MM quote is a signed
            // firm order: its book id is the EIP-712 digest, and any cross
            // against another signed order yields a settleable fill.
            let (id, owner) = match self.signed_mm_quote(instrument_id, side, q) {
                Some((digest_hex, signed)) => {
                    self.signed.lock().unwrap().orders.insert(digest_hex.clone(), signed);
                    (digest_hex, self.mm_owner.clone())
                }
                None => (self.next_id("mm"), self.mm_owner.clone()),
            };
            let order = Order {
                id,
                instrument_id: instrument_id.to_string(),
                side,
                price: q.price.round() as i64,
                qty: q.qty.round() as i64,
                owner,
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
        apply_inventory(v, &all_fills, &self.mm_owner);
        if let Some(ctx) = &self.settle {
            let mut signed = self.signed.lock().unwrap();
            signed_fill_count =
                signed.pair_book_fills(&all_fills, &ctx.domain, crate::market::now_unix());
        }
        Ok(json!({
            "quoting": true,
            "placed": placed,
            "fills": all_fills,
            "signedFills": signed_fill_count,
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
pub(crate) fn apply_inventory(v: &mut InstrumentVenue, fills: &[Fill], mm_owner: &str) {
    for f in fills {
        let mm_side = if f.maker_owner == mm_owner {
            Some(f.taker_side.opposite())
        } else if f.taker_owner == mm_owner {
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
fn settlement_intents(fills: &[Fill], rail: &str, mm_owner: &str) -> Vec<Value> {
    fills
        .iter()
        .filter_map(|f| {
            let (buyer, operator) = if f.taker_owner != mm_owner && f.maker_owner == mm_owner {
                (f.taker_owner.clone(), f.maker_owner.clone())
            } else if f.maker_owner != mm_owner && f.taker_owner == mm_owner {
                (f.maker_owner.clone(), f.taker_owner.clone())
            } else if f.maker_owner != mm_owner && f.taker_owner != mm_owner {
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
