//! Pool state: order/cancel admission, the settled/cancelled finality sets and
//! their restart-durable journal, the epoch snapshot, and the prune/evict that
//! make settlement final. Everything that mutates `Clob`'s shared maps lives
//! here; the proposer ([`super::driver`]) and verifier ([`super::peer`]) only
//! read through these entry points.

use axum::http::StatusCode;
use serde_json::{json, Value};
use inference_bazaar_settlement::core::alloy_primitives::B256;
use inference_bazaar_settlement::core::{order_digest, recover_signer, BatchFill};

use super::{
    cancel_digest, Clob, FinalityJournal, PoolEntry, WireCancel, WireOrder, CANCEL_TTL_SECS,
    EXPIRY_MARGIN_SECS, MAX_POOL,
};
use crate::market::{now_unix, SignedOrderBody};

impl Clob {
    /// Where the finality sets are journaled. The pool is NOT persisted — peers
    /// re-gossip it on restart — but `settled` and `cancelled` are the finality
    /// record: losing them re-opens a settled or cancelled order for re-admission
    /// and a batch-reverting re-match (audit H1). They grow only on settlement /
    /// cancel events, so persist-on-mutation is cheap.
    fn finality_path() -> Option<std::path::PathBuf> {
        std::env::var("DATA_DIR")
            .ok()
            .map(|d| std::path::Path::new(&d).join("clob-finality.json"))
    }

    pub(crate) fn load_finality(&self) {
        let Some(path) = Self::finality_path() else {
            return;
        };
        let Ok(raw) = std::fs::read(&path) else {
            return;
        };
        let Ok(j) = serde_json::from_slice::<FinalityJournal>(&raw) else {
            tracing::error!("clob finality journal unreadable (keeping file)");
            return;
        };
        let now = now_unix();
        let mut settled = self.settled.lock().unwrap();
        let mut cancelled = self.cancelled.lock().unwrap();
        for (d, exp) in j.settled {
            if exp >= now {
                settled.insert(d, exp);
            }
        }
        for (h, (t, exp)) in j.cancelled {
            if exp >= now {
                cancelled.insert(h, (t, exp));
            }
        }
        tracing::info!(
            settled = settled.len(),
            cancelled = cancelled.len(),
            "restored CLOB finality sets from journal"
        );
    }

    fn persist_finality(&self) {
        let Some(path) = Self::finality_path() else {
            return;
        };
        let j = FinalityJournal {
            settled: self.settled.lock().unwrap().clone(),
            cancelled: self.cancelled.lock().unwrap().clone(),
        };
        if let Ok(bytes) = serde_json::to_vec(&j) {
            if let Err(e) = std::fs::write(&path, bytes) {
                tracing::error!("clob finality journal write failed: {e}");
            }
        }
    }

    /// Admit an order locally and fan it out to peers — the one entry point for
    /// client order flow, used by the HTTP handler and the mesh alike.
    pub fn submit_order(&self, w: WireOrder) -> Result<Value, (StatusCode, String)> {
        let out = self.admit(w.clone().into())?;
        self.net.gossip_order(&w);
        Ok(out)
    }

    /// Cancel an order locally and fan the signed cancel out to peers. The one
    /// entry point for client cancel flow.
    pub fn submit_cancel(&self, c: WireCancel) -> Result<Value, (StatusCode, String)> {
        let out = self.admit_cancel(c.clone())?;
        self.net.gossip_cancel(&c);
        Ok(out)
    }

    /// Verify a signed cancel (recovers to the order's trader), record it, and
    /// drop the order from the pool if held. Idempotent. A cancel for an order
    /// not yet seen is remembered so the order is refused on arrival.
    pub(crate) fn admit_cancel(&self, c: WireCancel) -> Result<Value, (StatusCode, String)> {
        let sig = inference_bazaar_settlement::core::hex::decode(c.signature.trim_start_matches("0x"))
            .map_err(|_| {
                (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "signature is not hex".into(),
                )
            })?;
        let (chain_id, contract) = self.cancel_ctx();
        let digest = cancel_digest(chain_id, contract, c.order_hash);
        let signer = recover_signer(digest, &sig).ok_or((
            StatusCode::UNPROCESSABLE_ENTITY,
            "unrecoverable cancel signature".to_string(),
        ))?;
        if signer != c.trader {
            return Err((
                StatusCode::UNPROCESSABLE_ENTITY,
                "cancel is not signed by the order's trader".into(),
            ));
        }

        let mut pool = self.pool.lock().unwrap();
        // If the order is in hand, the cancel only binds when it really is this
        // trader's order; extend the TTL to the order's own expiry.
        let (removed, ttl) = match pool.get(&c.order_hash) {
            Some(e) if e.signed.order.trader == c.trader => (true, e.signed.order.expiry),
            Some(_) => {
                return Err((
                    StatusCode::FORBIDDEN,
                    "cancel trader does not own this order".into(),
                ))
            }
            None => (false, now_unix() + CANCEL_TTL_SECS),
        };
        if removed {
            pool.remove(&c.order_hash);
        }
        self.cancelled
            .lock()
            .unwrap()
            .insert(c.order_hash, (c.trader, ttl));
        drop(pool);
        self.persist_finality();
        Ok(json!({
            "orderHash": format!("{:#x}", c.order_hash),
            "cancelled": true,
            "removedFromPool": removed,
        }))
    }

    /// Is this order known-cancelled by THIS node? Used as the co-sign safety
    /// net so a batch can never include a cancelled order.
    pub(crate) fn is_cancelled(
        &self,
        order_hash: B256,
        trader: inference_bazaar_settlement::core::alloy_primitives::Address,
    ) -> bool {
        let now = now_unix();
        let mut cancelled = self.cancelled.lock().unwrap();
        cancelled.retain(|_, (_, exp)| *exp >= now);
        cancelled
            .get(&order_hash)
            .map(|(t, _)| *t == trader)
            .unwrap_or(false)
    }

    /// Validate and admit a gossiped order into the pool. Idempotent by digest.
    pub(crate) fn admit(&self, body: SignedOrderBody) -> Result<Value, (StatusCode, String)> {
        let (instrument_id, signed) = body
            .into_signed()
            .map_err(|e| (StatusCode::UNPROCESSABLE_ENTITY, e.to_string()))?;
        if self.instrument(&instrument_id).is_none() {
            return Err((
                StatusCode::NOT_FOUND,
                format!("unknown instrument {instrument_id}"),
            ));
        }
        if !signed.verify(self.domain()) {
            return Err((
                StatusCode::UNPROCESSABLE_ENTITY,
                "signature does not recover to trader".into(),
            ));
        }
        if signed.order.expiry < now_unix() + EXPIRY_MARGIN_SECS {
            return Err((
                StatusCode::UNPROCESSABLE_ENTITY,
                "order expires too soon to batch".into(),
            ));
        }
        // The integer matching book is i64-domained; an order whose price or qty
        // exceeds i64::MAX is settleable via settleFills but `match_epoch` would
        // silently drop it (audit L2). Reject it here with a clear reason rather
        // than admit an order the CLOB can never match.
        if i64::try_from(signed.order.priceMicroPerM).is_err()
            || i64::try_from(signed.order.qtyTokens).is_err()
        {
            return Err((
                StatusCode::UNPROCESSABLE_ENTITY,
                "price/qty exceeds the matchable range (use the RFQ rail)".into(),
            ));
        }
        let digest = signed.digest(self.domain());
        // Settlement is final: an order a co-signed batch touched can never
        // re-enter the pool, however many times its bytes are replayed.
        {
            let now = now_unix();
            let mut settled = self.settled.lock().unwrap();
            settled.retain(|_, expiry| *expiry >= now);
            if settled.contains_key(&digest) {
                return Err((
                    StatusCode::CONFLICT,
                    "order was settled in a prior batch".into(),
                ));
            }
        }
        // A cancelled order can never (re-)enter the pool — a cancel may have
        // arrived before the order, or be replayed after it.
        if self.is_cancelled(digest, signed.order.trader) {
            return Err((StatusCode::CONFLICT, "order was cancelled".into()));
        }
        let mut pool = self.pool.lock().unwrap();
        if pool.len() >= MAX_POOL && !pool.contains_key(&digest) {
            return Err((StatusCode::TOO_MANY_REQUESTS, "order pool full".into()));
        }
        pool.insert(
            digest,
            PoolEntry {
                instrument_id: instrument_id.clone(),
                signed,
            },
        );
        crate::metrics::set_gauge(crate::metrics::names::POOL_SIZE, pool.len() as i64);
        Ok(json!({
            "digest": format!("{digest:#x}"),
            "instrumentId": instrument_id,
            "epoch": self.current_epoch(),
            "poolSize": pool.len(),
        }))
    }

    /// Snapshot the pool for one instrument for the given epoch, dropping orders
    /// that won't survive to this epoch's settlement (the contract reverts the
    /// whole batch on one `OrderExpired`). The cutoff is epoch-deterministic so
    /// every verifier drops exactly the same orders.
    pub(crate) fn snapshot(
        &self,
        instrument_id: &str,
        epoch: u64,
    ) -> Vec<inference_bazaar_settlement::SignedOrder> {
        let deadline = self.settlement_deadline(epoch);
        let mut pool = self.pool.lock().unwrap();
        // Hygiene: evict anything already past its own absolute expiry.
        let now = now_unix();
        pool.retain(|_, e| e.signed.order.expiry >= now);
        pool.values()
            .filter(|e| e.instrument_id == instrument_id && e.signed.order.expiry >= deadline)
            .map(|e| e.signed.clone())
            .collect()
    }

    /// Remove every order touched by a fill AND remember it as settled, so a
    /// replay can never re-admit it. Mandatory after co-signing or submitting a
    /// batch: an order that filled (even partially) would overfill on re-match
    /// and revert the next batch.
    pub(crate) fn prune_filled(&self, fills: &[BatchFill]) {
        let domain = self.domain().clone();
        let mut pool = self.pool.lock().unwrap();
        let mut settled = self.settled.lock().unwrap();
        for f in fills {
            for o in [&f.buy, &f.sell] {
                let digest = order_digest(o, &domain);
                pool.remove(&digest);
                settled.insert(digest, o.expiry);
            }
        }
        crate::metrics::set_gauge(crate::metrics::names::POOL_SIZE, pool.len() as i64);
        drop(pool);
        drop(settled);
        self.persist_finality();
    }

    /// Evict orders from the pool by EIP-712 digest (the pool key). Used to drop
    /// orders the pre-match simulation proved unsettleable, so they neither
    /// re-match this epoch nor recur next epoch.
    #[cfg(feature = "chain")]
    pub(crate) fn evict(&self, doomed: &std::collections::HashSet<B256>) {
        let mut pool = self.pool.lock().unwrap();
        pool.retain(|d, _| !doomed.contains(d));
        crate::metrics::set_gauge(crate::metrics::names::POOL_SIZE, pool.len() as i64);
    }
}
