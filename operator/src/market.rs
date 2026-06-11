//! The firm-quote market surface: signed CLOB orders, RFQ, and the settlement
//! outbox. An RFQ response and a signed book order are the SAME EIP-712 `Order`
//! — the only difference is whether it rests in the book or is returned
//! directly to the requester. Every cross of two signed orders becomes a
//! [`SignedFill`] queued for on-chain settlement, where the SurplusSettlement
//! contract re-verifies everything; the venue is a relayer, not an authority.

use crate::config::SettlementConfig;
use crate::venue::{apply_inventory, Venue, VenueError};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};
use surplus_orderbook::{Fill, MatchingEngine, Order as BookOrder, Side};
use surplus_settlement::core::alloy_primitives::{keccak256, Address, B256};
use surplus_settlement::{
    domain, instrument_hash, Batch, Eip712Domain, Order, SignedFill, SignedOrder, Signer,
    SIDE_BUY, SIDE_SELL,
};

pub(crate) fn now_unix() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).expect("clock before epoch").as_secs()
}

fn side_to_book(side: u8) -> Option<Side> {
    match side {
        SIDE_BUY => Some(Side::Buy),
        SIDE_SELL => Some(Side::Sell),
        _ => None,
    }
}

// ─────────────────────────────── Settlement context ──────────────────────────

pub(crate) struct SettleCtx {
    pub domain: Eip712Domain,
    pub signer: Option<Signer>,
    pub contract: Address,
    pub rpc_url: Option<String>,
    pub operator_key: Option<String>,
    pub rfq_ttl_secs: u64,
}

impl SettleCtx {
    pub fn from_config(cfg: Option<&SettlementConfig>) -> Option<SettleCtx> {
        let cfg = cfg?;
        let contract: Address = cfg.contract.parse().ok()?;
        let signer = cfg.operator_key.as_deref().and_then(|k| Signer::from_hex(k).ok());
        Some(SettleCtx {
            domain: domain(cfg.chain_id, contract),
            signer,
            contract,
            rpc_url: cfg.rpc_url.clone(),
            operator_key: cfg.operator_key.clone(),
            rfq_ttl_secs: cfg.rfq_ttl_secs,
        })
    }

    pub fn operator_address_hex(&self) -> Option<String> {
        self.signer.as_ref().map(|s| format!("{:#x}", s.address()))
    }
}

// ─────────────────────────────── Signed-order state ──────────────────────────

pub(crate) struct SignedEntry {
    pub instrument_id: String,
    pub signed: SignedOrder,
}

/// Signed firm orders known to the venue, the venue's view of how much of each
/// has filled (the contract's `filled` map is authoritative), and the outbox of
/// fills awaiting submission. Lock AFTER `Venue::venues`, never before.
#[derive(Default)]
pub(crate) struct SignedState {
    pub orders: HashMap<String, SignedEntry>,
    pub filled: HashMap<String, u64>,
    pub outbox: Vec<SignedFill>,
}

impl SignedState {
    /// Join book fills back to their signed orders; fills involving an unsigned
    /// (legacy) party are skipped — they settle on the legacy rails.
    pub fn pair_book_fills(&mut self, fills: &[Fill], domain: &Eip712Domain, now: u64) -> usize {
        let mut paired = 0;
        for f in fills {
            let (Some(maker), Some(taker)) =
                (self.orders.get(&f.maker_order_id), self.orders.get(&f.taker_order_id))
            else {
                continue;
            };
            match SignedFill::pair(maker.signed.clone(), taker.signed.clone(), f.qty as u64, now, domain)
            {
                Ok(fill) => {
                    *self.filled.entry(f.maker_order_id.clone()).or_insert(0) += f.qty as u64;
                    *self.filled.entry(f.taker_order_id.clone()).or_insert(0) += f.qty as u64;
                    self.outbox.push(fill);
                    paired += 1;
                }
                Err(e) => {
                    // Both signatures were verified at intake and expiry was
                    // pruned before matching, so this indicates a venue bug.
                    tracing::error!(maker = %f.maker_order_id, taker = %f.taker_order_id, "unsettleable fill: {e}");
                }
            }
        }
        paired
    }

    pub fn remaining(&self, digest_hex: &str, order: &Order) -> u64 {
        order.qtyTokens.saturating_sub(self.filled.get(digest_hex).copied().unwrap_or(0))
    }
}

// ─────────────────────────────── HTTP wire types ─────────────────────────────

/// A signed firm order as submitted over HTTP: the exact struct that was
/// signed, plus the instrument's string id (validated against the hash).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedOrderBody {
    pub instrument_id: String,
    pub order: Order,
    pub signature: String,
}

impl SignedOrderBody {
    pub fn into_signed(self) -> Result<(String, SignedOrder), VenueError> {
        if self.order.instrument != instrument_hash(&self.instrument_id) {
            return Err(VenueError::Rejected(format!(
                "order.instrument is not keccak256({})",
                self.instrument_id
            )));
        }
        let signature = surplus_settlement::core::hex::decode(self.signature.trim_start_matches("0x"))
            .map_err(|_| VenueError::Rejected("signature is not hex".into()))?;
        Ok((self.instrument_id, SignedOrder { order: self.order, signature }))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RfqRequestBody {
    pub instrument_id: String,
    /// The requester's side: "buy" crosses the operator's ask, "sell" its bid.
    pub side: Side,
    pub qty_tokens: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RfqFillBody {
    pub maker: SignedOrderBody,
    pub taker: SignedOrderBody,
}

// ─────────────────────────────── Venue: market ops ───────────────────────────

impl Venue {
    fn settle_ctx(&self) -> Result<&SettleCtx, VenueError> {
        self.settle
            .as_ref()
            .ok_or(VenueError::SettlementUnconfigured("set SURPLUS_CHAIN_ID and SURPLUS_SETTLEMENT_ADDR"))
    }

    fn salt(&self) -> B256 {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock before epoch")
            .as_nanos();
        let seq = self.next_ts();
        let mut buf = [0u8; 24];
        buf[..16].copy_from_slice(&nanos.to_be_bytes());
        buf[16..].copy_from_slice(&seq.to_be_bytes());
        keccak256(buf)
    }

    /// Place a signed firm order into the open book. The order's digest is its
    /// book id; its signer is its owner. Crossing fills against other signed
    /// orders are queued in the settlement outbox.
    pub fn place_signed(&self, body: SignedOrderBody) -> Result<Value, VenueError> {
        let ctx = self.settle_ctx()?;
        let (instrument_id, signed) = body.into_signed()?;
        let now = now_unix();
        if !signed.verify(&ctx.domain) {
            return Err(VenueError::Rejected("bad order signature".into()));
        }
        if signed.order.expiry < now {
            return Err(VenueError::Rejected("order expired".into()));
        }
        if side_to_book(signed.order.side).is_none() {
            return Err(VenueError::Rejected(format!("bad side {}", signed.order.side)));
        }
        let digest_hex = format!("{:#x}", signed.digest(&ctx.domain));

        let mut venues = self.venues.lock().unwrap();
        let v = venues
            .get_mut(&instrument_id)
            .ok_or_else(|| VenueError::NotFound(instrument_id.clone()))?;
        let mut signed_state = self.signed.lock().unwrap();
        prune_expired(&mut signed_state, v, &instrument_id, now);

        let book_order = BookOrder {
            id: digest_hex.clone(),
            instrument_id: instrument_id.clone(),
            side: side_to_book(signed.order.side).expect("validated above"),
            price: signed.order.priceMicroPerM as i64,
            qty: signed_state.remaining(&digest_hex, &signed.order) as i64,
            owner: format!("{:#x}", signed.order.trader),
            ts: self.next_ts(),
        };
        if book_order.qty == 0 {
            return Err(VenueError::Rejected("order fully filled".into()));
        }
        let out = v
            .book
            .place(book_order)
            .map_err(|e| VenueError::Rejected(e.to_string()))?;
        signed_state.orders.insert(
            digest_hex.clone(),
            SignedEntry { instrument_id: instrument_id.clone(), signed },
        );
        let paired = signed_state.pair_book_fills(&out.fills, &ctx.domain, now);
        apply_inventory(v, &out.fills, self.mm_owner());
        Ok(json!({
            "orderDigest": digest_hex,
            "fills": out.fills,
            "signedFills": paired,
            "resting": out.resting,
            "outboxLen": signed_state.outbox.len(),
            "inventoryTokens": v.inventory_tokens,
        }))
    }

    /// Sign one MM quote as a firm order (used by `mm_tick` when a signer is
    /// configured). Returns (digest hex, signed order) or None in legacy mode.
    pub(crate) fn signed_mm_quote(
        &self,
        instrument_id: &str,
        side: Side,
        q: &crate::sidecar::Quote,
    ) -> Option<(String, SignedEntry)> {
        let ctx = self.settle.as_ref()?;
        let signer = ctx.signer.as_ref()?;
        let order = Order {
            instrument: instrument_hash(instrument_id),
            side: match side {
                Side::Buy => SIDE_BUY,
                Side::Sell => SIDE_SELL,
            },
            priceMicroPerM: q.price.round() as u64,
            qtyTokens: q.qty.round() as u64,
            lotId: B256::ZERO,
            trader: signer.address(),
            expiry: now_unix() + ctx.rfq_ttl_secs,
            salt: self.salt(),
        };
        let signed = signer.sign_order(&order, &ctx.domain);
        let digest_hex = format!("{:#x}", signed.digest(&ctx.domain));
        Some((digest_hex, SignedEntry { instrument_id: instrument_id.to_string(), signed }))
    }

    /// RFQ: a firm, signed, short-TTL quote for exactly the requested size,
    /// priced by the risk-gated sidecar. The response is settleable as-is —
    /// the requester countersigns and submits to `/rfq/fill` (or straight to
    /// the contract).
    pub async fn rfq_quote(
        &self,
        instrument_id: &str,
        taker_side: Side,
        qty_tokens: u64,
    ) -> Result<Value, VenueError> {
        let ctx = self.settle_ctx()?;
        let signer = ctx
            .signer
            .as_ref()
            .ok_or(VenueError::SettlementUnconfigured("set SURPLUS_OPERATOR_KEY to quote"))?;

        let (ref_mid, inventory, drawdown, tick, min_qty) = {
            let venues = self.venues.lock().unwrap();
            let v = venues
                .get(instrument_id)
                .ok_or_else(|| VenueError::NotFound(instrument_id.to_string()))?;
            let inst = self
                .cfg
                .instruments
                .iter()
                .find(|i| i.id == instrument_id)
                .map(|i| (i.tick_size, i.min_qty))
                .unwrap_or((1, 1));
            (v.ref_mid, v.inventory_tokens, v.drawdown_micro, inst.0, inst.1)
        };
        if ref_mid <= 0.0 {
            return Err(VenueError::NoReference);
        }
        let quote = self
            .sidecar
            .quote(&self.cfg, instrument_id, ref_mid, inventory as f64, drawdown)
            .await
            .map_err(|e| VenueError::Sidecar(e.to_string()))?;
        if !quote.valid {
            return Ok(json!({
                "quoting": false,
                "reasons": quote.reasons,
                "killSwitch": quote.kill_switch,
            }));
        }
        // The maker quotes the opposite side of the taker's request, at the
        // sidecar's risk-gated price aligned to tick AGAINST the maker (ask
        // rounds up, bid rounds down) so the firm price is never better for
        // the taker than the risk gate allowed.
        let maker_side = taker_side.opposite();
        let q = match maker_side {
            Side::Sell => quote.ask.as_ref(),
            Side::Buy => quote.bid.as_ref(),
        }
        .ok_or_else(|| VenueError::Rejected("no liquidity on that side".into()))?;
        let tick = tick.max(1) as u64;
        let raw = q.price.max(0.0) as u64; // saturating f64->u64 cast
        let price = match maker_side {
            // Round AGAINST the taker; checked so an absurd sidecar price fails
            // closed instead of panicking (debug) or wrapping (release).
            Side::Sell => raw
                .div_ceil(tick)
                .checked_mul(tick)
                .ok_or_else(|| VenueError::Rejected("quote price out of range".into()))?,
            Side::Buy => (raw / tick) * tick, // <= raw, cannot overflow
        };
        if price == 0 {
            return Err(VenueError::Rejected("quote price rounds to zero".into()));
        }
        let qty = qty_tokens.min(q.qty.round() as u64);
        if qty < min_qty as u64 {
            return Err(VenueError::Rejected(format!("qty {qty} below min {min_qty}")));
        }
        let order = Order {
            instrument: instrument_hash(instrument_id),
            side: match maker_side {
                Side::Buy => SIDE_BUY,
                Side::Sell => SIDE_SELL,
            },
            priceMicroPerM: price,
            qtyTokens: qty,
            lotId: B256::ZERO,
            trader: signer.address(),
            expiry: now_unix() + ctx.rfq_ttl_secs,
            salt: self.salt(),
        };
        let signed = signer.sign_order(&order, &ctx.domain);
        Ok(json!({
            "quoting": true,
            "instrumentId": instrument_id,
            "order": signed.order,
            "signature": surplus_settlement::core::hex::encode_prefixed(&signed.signature),
            "digest": format!("{:#x}", signed.digest(&ctx.domain)),
            "validUntil": order.expiry,
            "rationale": quote.rationale,
        }))
    }

    /// Cross a firm quote with a countersigned taker order. Stateless beyond
    /// the venue's fill bookkeeping: both signed orders travel in the request,
    /// so any maker's quote can clear here — the contract is the authority.
    pub fn rfq_fill(&self, body: RfqFillBody) -> Result<Value, VenueError> {
        let ctx = self.settle_ctx()?;
        let now = now_unix();
        let (maker_inst, maker) = body.maker.into_signed()?;
        let (taker_inst, taker) = body.taker.into_signed()?;
        if maker_inst != taker_inst {
            return Err(VenueError::Rejected("instrument mismatch".into()));
        }
        let maker_digest = format!("{:#x}", maker.digest(&ctx.domain));
        let taker_digest = format!("{:#x}", taker.digest(&ctx.domain));

        let mut venues = self.venues.lock().unwrap();
        let mut signed_state = self.signed.lock().unwrap();
        let qty = signed_state
            .remaining(&maker_digest, &maker.order)
            .min(signed_state.remaining(&taker_digest, &taker.order));
        if qty == 0 {
            return Err(VenueError::Rejected("no remaining quantity".into()));
        }
        let fill = SignedFill::pair(maker, taker, qty, now, &ctx.domain)
            .map_err(|e| VenueError::Rejected(e.to_string()))?;
        *signed_state.filled.entry(maker_digest.clone()).or_insert(0) += qty;
        *signed_state.filled.entry(taker_digest.clone()).or_insert(0) += qty;

        // RFQ fills bypass the book; attribute operator inventory directly from
        // the fill's buy/sell traders — whichever side the operator is on (the
        // operator can be maker OR taker; a self-fill is already rejected by
        // SignedFill::pair, so at most one branch fires).
        let op = self.settle.as_ref().and_then(|c| c.signer.as_ref().map(Signer::address));
        if let (Some(op), Some(v)) = (op, venues.get_mut(&maker_inst)) {
            if fill.buy.order.trader == op {
                v.inventory_tokens += qty as i64;
            } else if fill.sell.order.trader == op {
                v.inventory_tokens -= qty as i64;
            }
        }
        signed_state.outbox.push(fill.clone());
        Ok(json!({
            "filled": true,
            "qtyTokens": qty,
            "execPriceMicroPerM": fill.exec_price_micro_per_m,
            "costMicro": fill.cost_micro(),
            "makerDigest": maker_digest,
            "takerDigest": taker_digest,
            "outboxLen": signed_state.outbox.len(),
        }))
    }

    pub fn outbox_json(&self) -> Value {
        let signed_state = self.signed.lock().unwrap();
        let batch = Batch { fills: signed_state.outbox.clone() };
        json!({
            "count": batch.len(),
            "fillsHash": format!("{:#x}", batch.fills_hash()),
            "fills": batch.fills,
        })
    }

    /// Submit the outbox to the settlement contract (`settleFills`, the
    /// trustless path). Without the `chain` feature or RPC config this is a
    /// dry run: it reports what would be submitted and keeps the outbox.
    ///
    /// A single unsettleable fill must never wedge the whole queue. `settleFills`
    /// is atomic, so one revert (an order expired in the outbox, already filled
    /// out-of-band, cancelled, or off-canonical) reverts the entire batch. Two
    /// guards: (1) drop fills whose orders have expired before submitting —
    /// those can never settle on any rail; (2) on a batch revert, fall back to
    /// submitting each remaining fill individually, dropping the ones that
    /// revert (their failure states — Overfill, OrderExpired, cancellation — are
    /// terminal) so honest fills still clear. Nothing is silently lost: drops
    /// are logged and counted.
    pub async fn flush_settlement(&self) -> Result<Value, VenueError> {
        let _ctx = self.settle_ctx()?;
        let now = now_unix();
        let (mut fills, expired): (Vec<SignedFill>, Vec<SignedFill>) = {
            let mut signed_state = self.signed.lock().unwrap();
            std::mem::take(&mut signed_state.outbox)
                .into_iter()
                .partition(|f| f.buy.order.expiry >= now && f.sell.order.expiry >= now)
        };
        for f in &expired {
            tracing::error!(
                buyer = %f.buy.order.trader,
                seller = %f.sell.order.trader,
                "dropping expired fill from outbox — executed trade can never settle on-chain"
            );
        }
        if fills.is_empty() {
            return Ok(json!({ "mode": "noop", "submitted": 0, "droppedExpired": expired.len() }));
        }

        #[cfg(feature = "chain")]
        if let (Some(rpc), Some(key)) = (_ctx.rpc_url.as_deref(), _ctx.operator_key.as_deref()) {
            let client = match surplus_settlement::chain::SettlementClient::connect(
                rpc, key, _ctx.contract,
            )
            .await
            {
                Ok(c) => c,
                Err(e) => {
                    // Couldn't even connect: re-queue everything (transient).
                    self.requeue(fills);
                    return Err(VenueError::Chain(e.to_string()));
                }
            };
            if let Err(e) = client.assert_domain().await {
                self.requeue(fills);
                return Err(VenueError::Chain(e.to_string()));
            }
            // Fast path: one atomic batch.
            if let Ok(tx) = client.settle_fills(&fills).await {
                return Ok(json!({
                    "mode": "direct",
                    "submitted": fills.len(),
                    "droppedExpired": expired.len(),
                    "tx": format!("{tx:#x}"),
                }));
            }
            // A fill in the batch is unsettleable; isolate it. Submit each fill
            // on its own — terminal failures are dropped, successes clear.
            let mut submitted = 0usize;
            let mut dropped = 0usize;
            for fill in std::mem::take(&mut fills) {
                match client.settle_fills(std::slice::from_ref(&fill)).await {
                    Ok(_) => submitted += 1,
                    Err(e) => {
                        dropped += 1;
                        tracing::error!(
                            buyer = %fill.buy.order.trader,
                            seller = %fill.sell.order.trader,
                            "dropping unsettleable fill: {e}"
                        );
                    }
                }
            }
            return Ok(json!({
                "mode": "direct-isolated",
                "submitted": submitted,
                "droppedUnsettleable": dropped,
                "droppedExpired": expired.len(),
            }));
        }

        // Dry mode: report and restore (live fills only; expired are dropped).
        let report = json!({
            "mode": "dry",
            "wouldSubmit": fills.len(),
            "droppedExpired": expired.len(),
            "fillsHash": format!("{:#x}", Batch { fills: fills.clone() }.fills_hash()),
            "hint": "build with --features chain and set SURPLUS_RPC_URL + SURPLUS_OPERATOR_KEY to submit",
        });
        self.requeue(fills);
        Ok(report)
    }

    /// Put fills back at the FRONT of the outbox (they predate anything newly
    /// queued during the flush attempt).
    fn requeue(&self, fills: Vec<SignedFill>) {
        let mut signed_state = self.signed.lock().unwrap();
        let mut restored = fills;
        restored.extend(std::mem::take(&mut signed_state.outbox));
        signed_state.outbox = restored;
    }
}

/// Drop expired signed orders for one instrument from the book and the map.
fn prune_expired(
    signed_state: &mut SignedState,
    v: &mut crate::venue::InstrumentVenue,
    instrument_id: &str,
    now: u64,
) {
    let expired: Vec<String> = signed_state
        .orders
        .iter()
        .filter(|(_, e)| e.instrument_id == instrument_id && e.signed.order.expiry < now)
        .map(|(digest, _)| digest.clone())
        .collect();
    for digest in expired {
        v.book.cancel(&digest);
        signed_state.orders.remove(&digest);
        // The order is rejected by both intake and the contract once expired,
        // so its venue-side fill counter is dead weight.
        signed_state.filled.remove(&digest);
    }
}
