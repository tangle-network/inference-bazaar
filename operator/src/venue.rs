//! The venue — the "main thing". Hosts the open orderbook per instrument,
//! delegates quoting to the mm-sidecar, tracks inventory from fills, and emits
//! settlement intents. Both the lite HTTP bin and the blueprint bin
//! (BlueprintRunner) drive THIS — the lib is the single source of the market.

use crate::config::{Instrument, OperatorConfig};
use crate::market::{SettleCtx, SignedState};
use crate::sidecar::SidecarClient;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use inference_bazaar_orderbook::{Fill, MatchingEngine, NativeBook, Order, Side};

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
    /// Signed-order / RFQ surface used without INFERENCE_BAZAAR_CHAIN_ID +
    /// INFERENCE_BAZAAR_SETTLEMENT_ADDR (and a key, where signing is required).
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
    pub(crate) instrument: Instrument,
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
    /// Per-redemption serve progress, pending the holder's receipt.
    pub(crate) redeem: Mutex<HashMap<String, RedeemProgress>>,
    /// Last-known on-chain funding of the operator (collateral headroom for
    /// minting sells, cash balance for buys). Refreshed by the auto-flush loop
    /// and on demand by the RFQ path; `fetched_at == 0` means never fetched —
    /// quoting is then unbounded (legacy / chainless mode).
    pub(crate) chain_cache: Mutex<ChainCache>,
    /// Where redemptions get their tokens: managed vLLM, any OpenAI-compat
    /// URL, or the Tangle Router (legacy default). See `inference.rs`.
    pub(crate) inference: crate::inference::InferenceBackend,
    /// `INFERENCE_BAZAAR_ATTESTER_ONLY=1`: this node participates in CLOB quorum (gossip +
    /// co-sign) but NEVER issues — it signs no maker quotes, so it mints no lots.
    /// An attester that cannot issue cannot resell, so the "issuer must serve its
    /// own model" rule does not apply to it (it serves nothing). This is the
    /// honest model for an independent-DC quorum member like op5.
    pub(crate) attester_only: bool,
}

/// Serve-side state of one open redemption: how much has been served (pending
/// the holder's signed receipt) and which serve authorizations were already
/// consumed — a captured `ServeRequest` signature cannot be replayed to burn
/// the holder's quota twice. Persisted to DATA_DIR/redeem.json so a restart does
/// NOT reset `served` to 0 (which would re-open the full quota) nor forget the
/// consumed authorizations.
#[derive(Default, Clone, serde::Serialize, serde::Deserialize)]
pub(crate) struct RedeemProgress {
    pub served: u64,
    pub used_auths: HashSet<inference_bazaar_settlement::core::alloy_primitives::B256>,
    /// The latest work commitment served (the one the holder's receipt covers).
    /// `Some` once anything has been served; the attestation pump needs it to
    /// vouch service when the holder won't sign.
    #[serde(default)]
    pub work: Option<inference_bazaar_settlement::core::alloy_primitives::B256>,
    /// Unix time of the last serve. The attestation pump waits a grace past this
    /// for the holder's receipt before vouching service via the quorum.
    #[serde(default)]
    pub served_at: u64,
}

#[derive(Default, Clone, Copy)]
pub(crate) struct ChainCache {
    pub free_collateral_micro: u128,
    pub balance_micro: u128,
    pub penalty_bps: u16,
    pub fetched_at: u64,
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
        let inference = crate::inference::InferenceBackend::from_env(&cfg.router_url);

        // Fail closed: a BONDED ISSUER (it can sign sell orders that mint lots AND
        // participates in a CLOB book) must serve the model it sold from its own
        // backend — managed vLLM or a configured OpenAI-compat URL. Router-proxy
        // mode resells a third party's inference, which the lot does not bond, so
        // a node that can issue must never boot in "router" mode. Dev/chainless
        // venues (no signer, no book) keep the router fallback.
        // An attester-only node co-signs the book's batches but issues nothing
        // (see the `attester_only` field + the guards in `signed_mm_quote` /
        // `rfq_quote`), so the own-model requirement does not bind it.
        let attester_only = std::env::var("INFERENCE_BAZAAR_ATTESTER_ONLY")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        let is_bonded_issuer = !attester_only
            && settle
                .as_ref()
                .and_then(|s| s.operator_address_hex())
                .is_some()
            && std::env::var("INFERENCE_BAZAAR_CLOB_OPERATORS")
                .map(|v| !v.trim().is_empty())
                .unwrap_or(false);
        if is_bonded_issuer && inference.mode() == "router" {
            panic!(
                "bonded issuer must serve its own model: set INFERENCE_BAZAAR_VLLM_MODEL or \
                 INFERENCE_BAZAAR_INFERENCE_URL (or INFERENCE_BAZAAR_ATTESTER_ONLY=1 for a quorum member \
                 that does not issue). router-proxy mode is forbidden on an issuing \
                 rail (a lot must be backed by inference this operator runs, not resold)."
            );
        }
        if attester_only {
            tracing::info!(
                "INFERENCE_BAZAAR_ATTESTER_ONLY: this node co-signs CLOB batches but will not \
                 quote or issue (no maker orders signed)"
            );
        }
        let venue = Venue {
            cfg,
            sidecar,
            venues: Mutex::new(venues),
            seq: AtomicU64::new(1),
            settle,
            signed: Mutex::new(SignedState::default()),
            mm_owner,
            redeem: Mutex::new(HashMap::new()),
            chain_cache: Mutex::new(ChainCache::default()),
            inference,
            attester_only,
        };
        venue.load_outbox();
        venue.load_refs();
        venue.load_redeem();
        venue
    }

    /// Restore per-redemption serve progress (served counter + consumed serve
    /// authorizations) from the journal. Without this, a restart resets `served`
    /// to 0 — re-opening the full quota — and forgets used authorizations,
    /// letting a holder re-consume the redemption for free.
    fn load_redeem(&self) {
        let Some(path) = redeem_path() else { return };
        let Ok(raw) = std::fs::read(&path) else {
            return;
        };
        let Ok(saved) = serde_json::from_slice::<HashMap<String, RedeemProgress>>(&raw) else {
            tracing::warn!("redeem journal unreadable; starting empty");
            return;
        };
        let n = saved.len();
        *self.redeem.lock().unwrap() = saved;
        if n > 0 {
            tracing::info!(redemptions = n, "restored serve progress from journal");
        }
    }

    /// Atomically journal the redeem map (tmp + rename). Called after every
    /// mutation that must survive a restart (served update, receipt removal).
    pub(crate) fn persist_redeem(&self) {
        let Some(path) = redeem_path() else { return };
        let snapshot = { self.redeem.lock().unwrap().clone() };
        let tmp = path.with_extension("json.tmp");
        let Ok(bytes) = serde_json::to_vec(&snapshot) else {
            return;
        };
        if let Err(e) = std::fs::write(&tmp, &bytes).and_then(|()| std::fs::rename(&tmp, &path)) {
            tracing::warn!("redeem journal write failed: {e}");
        }
    }

    /// Restore journaled reference prices (see `set_ref`). Stale-by-a-restart
    /// refs are acceptable: the quoter refreshes them within a minute, and the
    /// risk gate bounds deviation regardless.
    fn load_refs(&self) {
        let Some(path) = refs_path() else { return };
        let Ok(raw) = std::fs::read(&path) else {
            return;
        };
        let Ok(saved) = serde_json::from_slice::<HashMap<String, f64>>(&raw) else {
            return;
        };
        let mut venues = self.venues.lock().unwrap();
        let mut restored = 0;
        for (id, ref_mid) in saved {
            if let Some(v) = venues.get_mut(&id) {
                if v.ref_mid <= 0.0 && ref_mid > 0.0 {
                    v.ref_mid = ref_mid;
                    restored += 1;
                }
            }
        }
        if restored > 0 {
            tracing::info!(restored, "restored reference prices from journal");
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

    /// All live instruments — config defaults plus runtime `list_instrument`
    /// registrations (the on-chain job), sorted for stable output.
    pub fn instruments(&self) -> Vec<Instrument> {
        let venues = self.venues.lock().unwrap();
        let mut out: Vec<Instrument> = venues.values().map(|v| v.instrument.clone()).collect();
        out.sort_by(|a, b| a.id.cmp(&b.id));
        out
    }

    /// Register a new instrument at runtime (the `list_instrument` job or the
    /// boot replay of the instrument journal — hence the ref restore here).
    pub fn register_instrument(&self, inst: Instrument) -> Value {
        let mut venues = self.venues.lock().unwrap();
        let v = venues
            .entry(inst.id.clone())
            .or_insert_with(|| InstrumentVenue::from(&inst));
        if v.ref_mid <= 0.0 {
            if let Some(saved) = load_saved_ref(&inst.id) {
                v.ref_mid = saved;
            }
        }
        json!({ "ok": true, "instrumentId": inst.id })
    }

    pub fn set_ref(&self, instrument_id: &str, ref_mid: f64) -> Result<Value, VenueError> {
        let mut venues = self.venues.lock().unwrap();
        let v = venues
            .get_mut(instrument_id)
            .ok_or_else(|| VenueError::NotFound(instrument_id.to_string()))?;
        v.ref_mid = ref_mid;
        // Journal refs so a restarted venue quotes immediately instead of
        // erroring NoReference until the next quoter pass (an on-chain tick
        // landing in that window would burn the job for nothing).
        let snapshot: HashMap<String, f64> = venues
            .iter()
            .filter(|(_, v)| v.ref_mid > 0.0)
            .map(|(k, v)| (k.clone(), v.ref_mid))
            .collect();
        persist_refs(&snapshot);
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
        json!({ "ok": true, "instruments": instruments, "inference": self.inference.target() })
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
            .quote(
                &self.cfg,
                instrument_id,
                ref_mid,
                inventory as f64,
                drawdown,
            )
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

        // Quote a ladder: INFERENCE_BAZAAR_MM_LEVELS price levels per side stepping away
        // from the A–S touch, sizes growing with distance — the operator's
        // committed depth, not decoration. Level spacing is ~30bps of the
        // reference (at least one tick).
        let ladder_levels: i64 = std::env::var("INFERENCE_BAZAAR_MM_LEVELS")
            .ok()
            .and_then(|v| v.parse().ok())
            .filter(|v| (1..=10).contains(v))
            .unwrap_or(1);
        let inst_tick = v.instrument.tick_size.max(1);
        let level_step = (((ref_mid * 0.003) / inst_tick as f64).round() as i64).max(1) * inst_tick;

        let mut placed = Vec::new();
        let mut all_fills: Vec<Fill> = Vec::new();
        let mut signed_fill_count = 0usize;
        // Ladder depth is a signed commitment too: spend the same funding
        // budgets the RFQ path enforces, deepest levels dropped first.
        let mut budgets = self.quote_budgets(crate::market::now_unix());
        let min_qty = v.instrument.min_qty.max(1) as u64;
        for (side, touch) in [(Side::Buy, &quote.bid), (Side::Sell, &quote.ask)] {
            let Some(touch) = touch else { continue };
            for lvl in 0..ladder_levels {
                let mut q = crate::sidecar::Quote {
                    price: match side {
                        Side::Buy => touch.price - (lvl * level_step) as f64,
                        Side::Sell => touch.price + (lvl * level_step) as f64,
                    },
                    qty: touch.qty * (1.0 + lvl as f64 * 0.75),
                };
                if q.price <= 0.0 {
                    continue;
                }
                if let Some((sell_budget, buy_budget)) = &mut budgets {
                    let budget: &mut u128 = match side {
                        Side::Sell => sell_budget,
                        Side::Buy => buy_budget,
                    };
                    let price = q.price.round() as u64;
                    let max_qty = budget
                        .saturating_mul(1_000_000)
                        .saturating_sub(500_000)
                        .checked_div(price.max(1) as u128)
                        .unwrap_or(0)
                        .min(u64::MAX as u128) as u64;
                    let qty = (q.qty.round() as u64).min(max_qty);
                    if qty < min_qty {
                        continue;
                    }
                    q.qty = qty as f64;
                    *budget = budget.saturating_sub(
                        inference_bazaar_settlement::core::cost_micro(price, qty).to::<u128>(),
                    );
                }
                let q = &q;
                // When a settlement signer is configured, the MM quote is a signed
                // firm order: its book id is the EIP-712 digest, and any cross
                // against another signed order yields a settleable fill.
                let (id, owner) = match self.signed_mm_quote(instrument_id, side, q) {
                    Some((digest_hex, signed)) => {
                        self.signed
                            .lock()
                            .unwrap()
                            .orders
                            .insert(digest_hex.clone(), signed);
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
        }
        apply_inventory(v, &all_fills, &self.mm_owner);
        if let Some(ctx) = &self.settle {
            let mut signed = self.signed.lock().unwrap();
            signed_fill_count =
                signed.pair_book_fills(&all_fills, &ctx.domain, crate::market::now_unix());
            if signed_fill_count > 0 {
                crate::market::persist_outbox(&signed.outbox);
            }
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
            instrument: inst.clone(),
            book: NativeBook::new(inst.id.clone(), inst.tick_size, inst.min_qty),
            ref_mid: 0.0,
            inventory_tokens: 0,
            drawdown_micro: 0.0,
        }
    }
}

fn refs_path() -> Option<std::path::PathBuf> {
    std::env::var("DATA_DIR")
        .ok()
        .map(|d| std::path::Path::new(&d).join("refs.json"))
}

fn redeem_path() -> Option<std::path::PathBuf> {
    std::env::var("DATA_DIR")
        .ok()
        .map(|d| std::path::Path::new(&d).join("redeem.json"))
}

fn persist_refs(refs: &HashMap<String, f64>) {
    let Some(path) = refs_path() else { return };
    let tmp = path.with_extension("json.tmp");
    let Ok(bytes) = serde_json::to_vec(refs) else {
        return;
    };
    if let Err(e) = std::fs::write(&tmp, &bytes).and_then(|()| std::fs::rename(&tmp, &path)) {
        tracing::warn!("refs journal write failed: {e}");
    }
}

fn load_saved_ref(instrument_id: &str) -> Option<f64> {
    let raw = std::fs::read(refs_path()?).ok()?;
    let saved: HashMap<String, f64> = serde_json::from_slice(&raw).ok()?;
    saved.get(instrument_id).copied().filter(|r| *r > 0.0)
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
