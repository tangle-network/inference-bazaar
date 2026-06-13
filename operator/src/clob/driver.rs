//! Proposer side: at an epoch boundary the elected node matches its snapshot,
//! pre-simulates each fill against live chain state (audit H3), gathers a quorum
//! of peer co-signatures, and submits `settleBatchAttested`. Also home to the
//! on-chain client and the membership reconciler (the contract is the source of
//! truth for the attester set).

use serde_json::{json, Value};
use surplus_matcher::{aggregate_attestation, match_epoch, Attestation};
use surplus_settlement::core::{batch_digest, BatchFill, Order};
use surplus_settlement::SignedOrder;

// Used only by the pre-match simulation, which is itself `chain`-gated.
#[cfg(feature = "chain")]
use surplus_settlement::core::order_digest;

use super::{Clob, WireProposal};
use crate::config::Instrument;

impl Clob {
    /// Reconcile the configured operator set/threshold against the contract's
    /// `bookAttesters`/`bookThreshold` for this book — the contract is the source
    /// of truth. On a CONFIRMED mismatch, mark membership not-ok (the node stops
    /// proposing, since the quorum it would gather can't settle on-chain) and log
    /// loudly. An unavailable RPC is NOT a mismatch — last-known config stands.
    #[cfg(feature = "chain")]
    pub(crate) async fn verify_membership(self: &std::sync::Arc<Self>) {
        use std::sync::atomic::Ordering;
        let Ok(Some(client)) = self.chain_client().await else {
            return; // chain not configured / unreachable: do not gate on it
        };
        let on_chain = match (
            client.book_attesters(self.cfg.book_id).await,
            client.book_threshold(self.cfg.book_id).await,
        ) {
            (Ok(a), Ok(t)) => (a, t),
            _ => return, // read failed: do not flip to not-ok on a transient error
        };
        let (mut chain_set, chain_threshold) = on_chain;
        chain_set.sort_unstable();
        let mut cfg_set = self.cfg.addresses();
        cfg_set.sort_unstable();
        let ok = chain_set == cfg_set && usize::from(chain_threshold) == self.cfg.threshold;
        self.membership_ok.store(ok, Ordering::Relaxed);
        if !ok {
            tracing::error!(
                book = %format!("{:#x}", self.cfg.book_id),
                configured = ?cfg_set, on_chain = ?chain_set,
                configured_threshold = self.cfg.threshold, on_chain_threshold = chain_threshold,
                "CLOB membership drift: configured operator set/threshold does not match the \
                 contract's bookAttesters. This node will NOT propose until reconciled \
                 (rotateAttesters on-chain or fix SURPLUS_CLOB_OPERATORS/THRESHOLD)."
            );
        }
    }

    /// Replicate `_applyFill`'s preconditions against LIVE chain state and return
    /// the EIP-712 digests of orders that would make the batch revert. Every
    /// check is CONSERVATIVE — it flags only orders that are DEFINITELY
    /// unsettleable (cancelled, expired, overfilled, buyer can't pay, seller
    /// can't back a mint), never a marginal one — so a good order is never
    /// wrongly evicted; the contract stays the final arbiter for the edge.
    #[cfg(feature = "chain")]
    async fn simulate_doomed(
        &self,
        fills: &[BatchFill],
        domain: &surplus_settlement::Eip712Domain,
    ) -> anyhow::Result<std::collections::HashSet<surplus_settlement::core::alloy_primitives::B256>>
    {
        use surplus_settlement::core::alloy_primitives::{B256, U256};
        use surplus_settlement::core::{order_struct_hash, SIDE_BUY};
        let Some(client) = self.chain_client().await? else {
            return Ok(Default::default()); // no chain configured: cannot simulate
        };
        let now = crate::market::now_unix();
        let mut doomed = std::collections::HashSet::new();
        for f in fills {
            let qty = f.qtyTokens;
            // exec-price * qty / 1e6, half-up — mirrors the contract's `cost`.
            let cost = U256::from(f.execPriceMicroPerM) * U256::from(qty);
            let cost = (cost + U256::from(500_000u64)) / U256::from(1_000_000u64);
            for (o, is_buy) in [(&f.buy, true), (&f.sell, false)] {
                let h = order_struct_hash(o);
                if now > o.expiry
                    || client.cancelled(h).await?
                    || client.filled(h).await?.saturating_add(qty) > o.qtyTokens
                {
                    doomed.insert(order_digest(o, domain));
                    continue;
                }
                if is_buy {
                    if client.balance_of(o.trader).await? < cost {
                        doomed.insert(order_digest(o, domain)); // buyer withdrew (the H3 grief)
                    }
                } else if o.lotId == B256::ZERO && client.free_collateral(o.trader).await? < cost {
                    doomed.insert(order_digest(o, domain)); // issuer can't back the mint
                }
            }
            let _ = SIDE_BUY;
        }
        Ok(doomed)
    }

    /// Run one epoch as proposer: match, broadcast, collect quorum, submit.
    /// Returns a per-instrument report. Election is NOT re-checked here — peers
    /// enforce it when deciding whether to co-sign.
    pub async fn run_epoch(self: &std::sync::Arc<Self>, epoch: u64) -> Value {
        crate::metrics::inc(crate::metrics::names::EPOCHS_RUN);
        let mut reports = Vec::new();
        for inst in self.venue.instruments() {
            let snapshot = self.snapshot(&inst.id, epoch);
            if snapshot.is_empty() {
                continue;
            }
            match self.propose_instrument(epoch, &inst, snapshot).await {
                Ok(Some(r)) => reports.push(r),
                Ok(None) => {}
                Err(e) => {
                    tracing::warn!(instrument = %inst.id, epoch, "epoch proposal failed: {e}");
                    reports.push(json!({ "instrumentId": inst.id, "error": e.to_string() }));
                }
            }
        }
        json!({ "epoch": epoch, "proposer": format!("{:#x}", self.me), "batches": reports })
    }

    async fn propose_instrument(
        self: &std::sync::Arc<Self>,
        epoch: u64,
        inst: &Instrument,
        mut snapshot: Vec<SignedOrder>,
    ) -> anyhow::Result<Option<Value>> {
        let domain = self.domain().clone();

        // Pre-match simulation (audit H3). `match_epoch` is chain-state-free, so
        // a crossed batch can still contain a fill that reverts on-chain — a
        // buyer who withdrew their balance, a cancelled/overfilled order — and
        // because `_applyBatch` is all-or-nothing that one fill would lose the
        // whole epoch's batch, stranding the GOOD orders in it. So before we
        // ask peers to co-sign, replicate `_applyFill`'s preconditions against
        // live chain state, evict the doomed orders, and re-match the clean set.
        // Peers then only ever co-sign a batch that will actually settle. A
        // bounded loop converges; without the chain feature this is a no-op.
        let mut batch = match_epoch(
            &inst.id,
            inst.tick_size,
            inst.min_qty,
            &domain,
            &orders_of(&snapshot),
        );
        #[cfg(feature = "chain")]
        for _ in 0..3 {
            if batch.fills.is_empty() {
                break;
            }
            let doomed = self.simulate_doomed(&batch.fills, &domain).await?;
            if doomed.is_empty() {
                break;
            }
            self.evict(&doomed);
            snapshot.retain(|s| !doomed.contains(&order_digest(&s.order, &domain)));
            batch = match_epoch(
                &inst.id,
                inst.tick_size,
                inst.min_qty,
                &domain,
                &orders_of(&snapshot),
            );
        }
        let _ = &mut snapshot;

        if batch.fills.is_empty() {
            return Ok(None); // nothing crossed (or all doomed); pool carries on
        }

        let batch_nonce = self.read_batch_nonce().await?;
        let digest = batch_digest(self.cfg.book_id, batch_nonce, batch.fills_hash, &domain);

        // One signature, two jobs: it is the proposer's attestation AND the
        // proposal's transport authentication (peers verify it recovers to the
        // elected proposer before doing any expensive verification).
        let self_sig = self.signer().sign_digest(digest);
        let mut attestations = vec![Attestation {
            attester: self.me,
            signature: self_sig.to_vec(),
        }];
        let wire = WireProposal {
            epoch,
            book_id: self.cfg.book_id,
            batch_nonce,
            instrument_id: inst.id.clone(),
            proposer: self.me,
            proposer_sig: format!("0x{}", surplus_settlement::core::hex::encode(self_sig)),
            orders: snapshot,
            fills_hash: batch.fills_hash,
        };
        let want = self.cfg.threshold.saturating_sub(1);
        attestations.extend(self.net.collect_attestations(&wire, digest, want).await);

        let quorum = aggregate_attestation(
            digest,
            &attestations,
            &self.cfg.addresses(),
            self.cfg.threshold,
        );
        let Some(sigs) = quorum else {
            crate::metrics::inc(crate::metrics::names::QUORUM_FAILED);
            tracing::warn!(
                instrument = %inst.id, epoch,
                got = attestations.len(), need = self.cfg.threshold,
                "no quorum — orders carry to the next epoch"
            );
            return Ok(Some(json!({
                "instrumentId": inst.id,
                "fillsHash": format!("{:#x}", batch.fills_hash),
                "fills": batch.fills.len(),
                "quorum": false,
                "attestations": attestations.len(),
            })));
        };
        crate::metrics::inc(crate::metrics::names::QUORUM_REACHED);

        // Quorum reached on a pre-simulated batch (every fill checked against
        // live chain state above), so it is expected to settle. Prune — peers
        // co-signed the same clean set; re-matching filled orders would poison
        // the next epoch.
        self.prune_filled(&batch.fills);
        let submitted = match self.submit(&batch.fills, sigs).await {
            Ok(tx) => {
                crate::metrics::inc(crate::metrics::names::BATCHES_SUBMITTED);
                tx
            }
            Err(e) => {
                crate::metrics::inc(crate::metrics::names::SUBMIT_REVERTS);
                return Err(e);
            }
        };
        tracing::info!(
            instrument = %inst.id, epoch, batch_nonce,
            fills = batch.fills.len(),
            fills_hash = %format!("{:#x}", batch.fills_hash),
            tx = %submitted, "epoch batch settled"
        );
        Ok(Some(json!({
            "instrumentId": inst.id,
            "fillsHash": format!("{:#x}", batch.fills_hash),
            "fills": batch.fills.len(),
            "quorum": true,
            "batchNonce": batch_nonce,
            "tx": submitted,
        })))
    }

    /// Dry without the `chain` feature OR without RPC config — same rule as
    /// `flush_settlement`. The consensus round still runs end to end; only the
    /// chain read/submit are skipped.
    async fn read_batch_nonce(&self) -> anyhow::Result<u64> {
        #[cfg(feature = "chain")]
        if let Some(client) = self.chain_client().await? {
            return client.book_nonce(self.cfg.book_id).await;
        }
        Ok(0)
    }

    async fn submit(&self, fills: &[BatchFill], sigs: Vec<Vec<u8>>) -> anyhow::Result<String> {
        #[cfg(feature = "chain")]
        if let Some(client) = self.chain_client().await? {
            let tx = client
                .settle_batch_fills_attested(self.cfg.book_id, fills, sigs)
                .await?;
            return Ok(format!("{tx:#x}"));
        }
        tracing::info!(
            fills = fills.len(),
            sigs = sigs.len(),
            "dry mode: quorum reached, would submit settleBatchAttested (needs --features chain + SURPLUS_RPC_URL)"
        );
        Ok("dry".into())
    }

    #[cfg(feature = "chain")]
    async fn chain_client(
        &self,
    ) -> anyhow::Result<Option<surplus_settlement::chain::SettlementClient>> {
        use std::sync::atomic::Ordering;
        let ctx = self.venue.settle.as_ref().expect("checked in new()");
        let (Some(rpc), Some(key)) = (ctx.rpc_url.as_deref(), ctx.submitter_key()) else {
            return Ok(None);
        };
        let client =
            surplus_settlement::chain::SettlementClient::connect(rpc, key, ctx.contract).await?;
        // Verify the on-chain domain separator once before we ever submit: a wrong
        // chain id / contract address would otherwise produce batch digests the
        // quorum can't verify, failing every settle confusingly. Fail closed.
        if !self.domain_checked.load(Ordering::Relaxed) {
            client.assert_domain().await?;
            self.domain_checked.store(true, Ordering::Relaxed);
        }
        Ok(Some(client))
    }
}

/// Extract the inner orders from a set of signed orders for matching.
fn orders_of(signed: &[SignedOrder]) -> Vec<Order> {
    signed.iter().map(|s| s.order.clone()).collect()
}
