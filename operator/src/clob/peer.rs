//! Verifier side: a peer authenticates the proposal, enforces election + epoch
//! freshness + book scope, then delegates every trust decision to
//! `verify_proposal` and co-signs only an honest batch. Plus `status` (the ops
//! view of this node's pool and election state).

use axum::http::StatusCode;
use serde_json::{json, Value};
use surplus_matcher::{elect_proposer, verify_proposal, BatchProposal, Verdict};
use surplus_settlement::core::alloy_primitives::B256;
use surplus_settlement::core::{batch_digest, recover_signer};

use super::{Clob, WireAttestation, WireProposal};

impl Clob {
    /// Verify a proposal and, if honest, co-sign it. The peer enforces election
    /// (only the epoch's elected proposer gets signatures) and epoch freshness,
    /// then delegates every trust decision to `verify_proposal`.
    pub(crate) fn attest(
        &self,
        wire: WireProposal,
    ) -> Result<WireAttestation, (StatusCode, Value)> {
        let current = self.current_epoch();
        if wire.epoch.abs_diff(current) > 1 {
            return Err((
                StatusCode::CONFLICT,
                json!({ "verdict": "stale-epoch", "current": current, "proposed": wire.epoch }),
            ));
        }
        if wire.book_id != self.cfg.book_id {
            return Err((
                StatusCode::FORBIDDEN,
                json!({
                    "verdict": "foreign-book",
                    "ours": format!("{:#x}", self.cfg.book_id),
                    "proposed": format!("{:#x}", wire.book_id),
                }),
            ));
        }
        let elected = elect_proposer(&self.cfg.addresses(), wire.epoch);
        if elected != Some(wire.proposer) {
            return Err((
                StatusCode::FORBIDDEN,
                json!({
                    "verdict": "not-elected",
                    "elected": elected.map(|a| format!("{a:#x}")),
                }),
            ));
        }
        // Transport authentication: the proposal must carry the elected
        // proposer's signature over the batch digest it claims. Without this,
        // anyone could replay public gossip data as a "proposal" and trigger
        // this node's co-sign side effects (pool prune + settled marking) —
        // stranding orders with no key — and burn a full match_epoch per
        // request. One ecrecover, before any expensive work.
        let domain = self.domain().clone();
        let claimed_digest = batch_digest(wire.book_id, wire.batch_nonce, wire.fills_hash, &domain);
        let proposer_sig =
            surplus_settlement::core::hex::decode(wire.proposer_sig.trim_start_matches("0x"))
                .unwrap_or_default();
        if recover_signer(claimed_digest, &proposer_sig) != Some(wire.proposer) {
            return Err((
                StatusCode::UNAUTHORIZED,
                json!({ "verdict": "unauthenticated-proposer" }),
            ));
        }
        let Some(inst) = self.instrument(&wire.instrument_id) else {
            return Err((
                StatusCode::NOT_FOUND,
                json!({ "verdict": "unknown-instrument", "instrumentId": wire.instrument_id }),
            ));
        };

        // Never co-sign a batch containing an order that won't survive to this
        // epoch's settlement — it would revert OrderExpired on-chain and grief
        // the whole batch. The cutoff is epoch-deterministic, so an honest
        // proposer's snapshot already excludes these and only a malicious one
        // includes them (audit M3). match_epoch is expiry-blind by design (it
        // must stay a pure function of the order set for the zk guest), so this
        // chain-state-free temporal check lives here, at the consensus layer.
        let deadline = self.settlement_deadline(wire.epoch);
        if let Some(o) = wire.orders.iter().find(|o| o.order.expiry < deadline) {
            return Err((
                StatusCode::CONFLICT,
                json!({ "verdict": "expires-before-settlement", "order": format!("{:#x}", o.digest(&domain)) }),
            ));
        }

        let my_orders = self.snapshot(&wire.instrument_id, wire.epoch);
        let proposal = BatchProposal {
            epoch: wire.epoch,
            book_id: wire.book_id,
            batch_nonce: wire.batch_nonce,
            instrument_id: wire.instrument_id,
            proposer: wire.proposer,
            orders: wire.orders,
            fills_hash: wire.fills_hash,
        };
        match verify_proposal(&proposal, &my_orders, inst.tick_size, inst.min_qty, &domain) {
            Verdict::Sign { digest, batch } => {
                // Co-sign safety net: never vouch for a batch that includes an
                // order this node knows is cancelled — the contract would revert
                // OrderIsCancelled and grief the whole batch. (verify_proposal is
                // pure and chain-unaware; the cancel set is this node's view.)
                if let Some(o) = proposal
                    .orders
                    .iter()
                    .find(|o| self.is_cancelled(o.digest(&domain), o.order.trader))
                {
                    crate::metrics::inc_labeled(crate::metrics::names::ATTEST_REFUSED, "cancelled");
                    return Err((
                        StatusCode::CONFLICT,
                        json!({ "verdict": "cancelled", "order": format!("{:#x}", o.digest(&domain)) }),
                    ));
                }
                // Final for this node: prune what the batch fills so the next
                // epoch cannot re-match (and overfill) settled orders. The
                // verified batch came back with the verdict — no second
                // match_epoch run.
                self.prune_filled(&batch.fills);
                crate::metrics::inc(crate::metrics::names::ATTEST_SIGNED);
                Ok(WireAttestation {
                    attester: self.me,
                    signature: format!(
                        "0x{}",
                        surplus_settlement::core::hex::encode(self.signer().sign_digest(digest),)
                    ),
                })
            }
            Verdict::Forged(digests) => {
                crate::metrics::inc_labeled(crate::metrics::names::ATTEST_REFUSED, "forged");
                Err((
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({ "verdict": "forged", "orders": hex_all(&digests) }),
                ))
            }
            Verdict::FillsHashMismatch => {
                crate::metrics::inc_labeled(
                    crate::metrics::names::ATTEST_REFUSED,
                    "fills-hash-mismatch",
                );
                Err((
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({ "verdict": "fills-hash-mismatch" }),
                ))
            }
            Verdict::Censored(digests) => {
                crate::metrics::inc_labeled(crate::metrics::names::ATTEST_REFUSED, "censored");
                Err((
                    StatusCode::CONFLICT,
                    json!({ "verdict": "censored", "missing": hex_all(&digests) }),
                ))
            }
        }
    }

    pub fn status(&self) -> Value {
        let pool = self.pool.lock().unwrap();
        let mut per_instrument: std::collections::HashMap<&str, usize> =
            std::collections::HashMap::new();
        for e in pool.values() {
            *per_instrument.entry(e.instrument_id.as_str()).or_insert(0) += 1;
        }
        let epoch = self.current_epoch();
        json!({
            "me": format!("{:#x}", self.me),
            "epoch": epoch,
            "epochSecs": self.cfg.epoch_secs,
            "proposer": elect_proposer(&self.cfg.addresses(), epoch).map(|a| format!("{a:#x}")),
            "threshold": self.cfg.threshold,
            "operators": self.cfg.operators.iter().map(|(a, u)| json!({
                "address": format!("{a:#x}"), "url": u,
            })).collect::<Vec<_>>(),
            "poolSize": pool.len(),
            "poolByInstrument": per_instrument,
        })
    }
}

fn hex_all(digests: &[B256]) -> Vec<String> {
    digests.iter().map(|d| format!("{d:#x}")).collect()
}
