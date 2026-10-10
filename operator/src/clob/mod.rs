//! Shared-CLOB epoch service: the transport + chain wiring around
//! `inference_bazaar_matcher`'s pure consensus.
//!
//! Per epoch (a fixed wall-clock window, `INFERENCE_BAZAAR_CLOB_EPOCH_SECS`):
//!   1. Signed orders arrive at any operator (`POST /clob/order`) and fan out
//!      to every peer over the [`ClobNet`] transport — the HTTP peer list, or
//!      (feature `mesh`) blueprint-networking's PKI-gated gossip — so all
//!      operators accumulate the same order pool.
//!   2. At the epoch boundary the elected proposer (`elect_proposer`: round-robin
//!      over the configured bonded set) snapshots its pool per instrument, runs
//!      `match_epoch`, and broadcasts the proposal — the order SET it matched,
//!      signatures included — to every peer (`POST /clob/propose`).
//!   3. Each peer independently re-verifies (`verify_proposal`: trader-signature
//!      authenticity, exact match recomputation, censorship) and returns its
//!      co-signature over `batch_digest(batchNonce, fillsHash)`.
//!   4. At quorum (`aggregate_attestation`) the proposer submits
//!      `settleBatchAttested` — the contract re-verifies the quorum and applies
//!      the fills atomically.
//!
//! Trust model: peers never trust the proposer (set-determinism lets them
//! recompute the batch bit-for-bit), and the proposer never trusts peers (the
//! contract re-verifies the quorum). Proposals are authenticated: each carries
//! the elected proposer's signature over the claimed batch digest, verified
//! with one ecrecover before any expensive work — co-sign side effects (pool
//! prune, settled marking) are only reachable by the epoch's real proposer.
//!
//! Failure mode is liveness, never safety. Co-signed batches are TWO-STAGE:
//! quorum/co-sign marks the batch's orders PENDING (retained in the pool but
//! excluded from matching), and only the on-chain observation — the proposer's
//! mined receipt, or the settlement watcher seeing `bookNonce` advance past the
//! batch's nonce — moves them to the settled finality set. If the batch is never
//! observed within [`pending_settle_ttl`] (submit failed, or the tx was accepted
//! then evicted by the mempool — observed live on Tempo), the orders are
//! RELEASED back into matching so the next elected proposer re-drives the batch.
//! Double-settle stays impossible: `batchNonce` scopes each quorum signature,
//! the contract's `filled` map caps every order, and the pre-match sim evicts
//! any order the chain reports filled.
//!
//! Module layout (audit M4 — `clob.rs` was a ~1.4k-line god-object):
//!   - [`config`] — `ClobConfig` + env parsing.
//!   - [`net`] — the `ClobNet` transport trait + the HTTP peer-list impl.
//!   - [`wire`] — the JSON wire types (`WireOrder`/`WireCancel`/…).
//!   - [`pool`] — order/cancel admission, the settled/cancelled finality sets,
//!     the epoch snapshot, pending/confirm/release (state mutation).
//!   - [`driver`] — proposer side: match → pre-sim → quorum → submit, the
//!     settlement watcher, plus the on-chain client and membership reconciliation.
//!   - [`peer`] — verifier side: `attest`, plus `status`.
//!   - [`http`] — the axum router, handlers, and the boot/loop spawners.
//! The `Clob` struct, its constructors, and the shared accessors live here so
//! every submodule's `impl Clob` block can reach them.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use inference_bazaar_settlement::core::alloy_primitives::{keccak256, Address, B256, U256};
use inference_bazaar_settlement::SignedOrder;
use serde::{Deserialize, Serialize};

use crate::config::Instrument;
use crate::market::now_unix;
use crate::venue::Venue;

mod config;
mod driver;
mod net;
mod peer;
mod pool;
mod wire;

pub mod http;

pub use config::ClobConfig;
pub use http::{
    router, spawn_epoch_loop, spawn_membership_reconciler, spawn_settlement_watcher, start_from_env,
};
pub use net::{ClobNet, HttpNet};
pub use wire::{WireAttestation, WireCancel, WireOrder, WireProposal};

/// Orders expiring within this margin of epoch close are not matched: the batch
/// must still be valid when the settlement transaction lands.
pub(crate) const EXPIRY_MARGIN_SECS: u64 = 30;
/// Pool cap — a gossip-spam bound, not a market parameter.
pub(crate) const MAX_POOL: usize = 10_000;
/// How long a cancel for an order we have NOT seen is remembered. A cancel must
/// outlive the order it kills; once the order is in hand we extend to its exact
/// expiry. Two days bounds the unseen-order case without growing the set.
pub(crate) const CANCEL_TTL_SECS: u64 = 2 * 24 * 3600;

/// A co-signed batch's orders stay pending at least this long (and 3 epochs) —
/// long enough for the settle tx to be mined and observed, short enough that a
/// lost submission (submit error, mempool eviction) re-matches promptly.
pub(crate) const PENDING_SETTLE_MIN_SECS: u64 = 30;
pub(crate) const PENDING_SETTLE_EPOCHS: u64 = 3;

/// Deadline for a co-signed batch to be OBSERVED on-chain before its orders are
/// released back into matching for a re-drive.
pub(crate) fn pending_settle_ttl(epoch_secs: u64) -> u64 {
    (PENDING_SETTLE_EPOCHS * epoch_secs).max(PENDING_SETTLE_MIN_SECS)
}

/// A batch this order was co-signed into, awaiting on-chain observation.
/// `batch_nonce` is the book nonce the quorum signature binds to; `deadline` is
/// the unix time after which the order is released for a re-drive.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PendingBatch {
    pub batch_nonce: u64,
    pub deadline: u64,
}

/// How long a proposer waits for peer co-signatures, derived from the epoch so
/// it can never overrun a short epoch into the next round (audit M7: a fixed
/// 8s window overlapped any `epoch_secs < 8`). 80% of the epoch leaves headroom
/// for the on-chain submit, clamped to a sane floor/ceiling.
pub fn attest_deadline(epoch_secs: u64) -> Duration {
    Duration::from_millis((epoch_secs * 800).clamp(1_000, 8_000))
}

// EIP-712 `InferenceBazaarCancel/1`, domain-separated from every other InferenceBazaar signature
// (settlement orders, serve auths) so a cancel can never be replayed as anything
// else. Mirrors the on-chain `cancelOrder` authority (msg.sender == trader) with
// a portable signature the gossip layer can carry.
const CANCEL_DOMAIN_NAME: &[u8] = b"InferenceBazaarCancel";
const CANCEL_TYPE: &[u8] = b"OrderCancel(bytes32 orderHash)";

/// keccak256(\x19\x01 ‖ domainSeparator ‖ structHash) for an order cancel.
/// Public so clients (the app) can build the signature a [`WireCancel`] carries.
pub fn cancel_digest(chain_id: U256, settlement: Address, order_hash: B256) -> B256 {
    let mut dom = Vec::with_capacity(160);
    dom.extend_from_slice(
        keccak256(
            b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
        )
        .as_slice(),
    );
    dom.extend_from_slice(keccak256(CANCEL_DOMAIN_NAME).as_slice());
    dom.extend_from_slice(keccak256(b"1").as_slice());
    dom.extend_from_slice(&chain_id.to_be_bytes::<32>());
    dom.extend_from_slice(&[0u8; 12]);
    dom.extend_from_slice(settlement.as_slice());
    let domain_separator = keccak256(&dom);

    let mut st = Vec::with_capacity(64);
    st.extend_from_slice(keccak256(CANCEL_TYPE).as_slice());
    st.extend_from_slice(order_hash.as_slice());
    let struct_hash = keccak256(&st);

    let mut out = Vec::with_capacity(66);
    out.extend_from_slice(b"\x19\x01");
    out.extend_from_slice(domain_separator.as_slice());
    out.extend_from_slice(struct_hash.as_slice());
    keccak256(&out)
}

// ─────────────────────────────── Service state ───────────────────────────────

/// The restart-durable finality record (settled + cancelled order digests).
#[derive(Default, Serialize, Deserialize)]
pub(crate) struct FinalityJournal {
    pub(crate) settled: HashMap<B256, u64>,
    pub(crate) cancelled: HashMap<B256, (Address, u64)>,
}

pub(crate) struct PoolEntry {
    pub(crate) instrument_id: String,
    pub(crate) signed: SignedOrder,
    /// Set at quorum/co-sign: the batch this order is part of, awaiting on-chain
    /// observation. Pending orders stay in the pool but are excluded from
    /// snapshots (matching) until the batch confirms or the deadline releases
    /// them for a re-drive.
    pub(crate) pending: Option<PendingBatch>,
}

pub struct Clob {
    pub(crate) venue: Arc<Venue>,
    pub(crate) cfg: ClobConfig,
    /// My attester identity — the venue's operator signer.
    pub(crate) me: Address,
    /// Gossiped order pool, keyed by order digest. Orders persist across epochs
    /// until matched, expired, or evicted.
    pub(crate) pool: Mutex<HashMap<B256, PoolEntry>>,
    /// Digest → expiry of every order a batch OBSERVED on-chain ever touched
    /// (the proposer's mined receipt, or the watcher seeing `bookNonce` advance
    /// past the batch nonce). A settled order is a signed public object —
    /// replaying it (late gossip, or an attacker) would re-admit it, re-match
    /// it next epoch, and revert that whole batch on the contract's `filled`
    /// cap: a liveness grief. This set
    /// makes settlement final at admission; it self-bounds by order expiry.
    pub(crate) settled: Mutex<HashMap<B256, u64>>,
    /// orderHash → (trader, gc-expiry) for every order a signed cancel has
    /// killed. An order in this set cannot be (re-)admitted, so a cancelled
    /// order never enters a batch — which would revert `OrderIsCancelled`
    /// on-chain and grief the whole batch. Survives a cancel that races ahead of
    /// the order it cancels (pre-order cancel), self-bounds by expiry.
    pub(crate) cancelled: Mutex<HashMap<B256, (Address, u64)>>,
    /// Last epoch this node ran as proposer (idempotence for the driver loop).
    pub(crate) last_epoch: AtomicU64,
    /// False only after a CONFIRMED mismatch between the configured operator set/
    /// threshold and the contract's on-chain `bookAttesters`/`bookThreshold`. The
    /// contract is the source of truth: proposing against a quorum the contract
    /// will reject is pure liveness grief, so a drifted node stops proposing.
    /// Stays true if the on-chain read is merely unavailable (no false stall).
    pub(crate) membership_ok: AtomicBool,
    /// Set once the deployed contract's EIP-712 domain separator has been verified
    /// against this node's (chain id + contract address). A mismatch means every
    /// quorum signature would be unverifiable on-chain, so the first settle attempt
    /// checks it and refuses to submit on drift (fail-closed); checked once.
    pub(crate) domain_checked: AtomicBool,
    pub(crate) net: Arc<dyn ClobNet>,
}

pub type SharedClob = Arc<Clob>;

impl Clob {
    /// The attester identity a settlement-configured venue signs with.
    fn attester_of(venue: &Venue) -> anyhow::Result<Address> {
        let ctx = venue
            .settle
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("shared CLOB requires settlement config"))?;
        Ok(ctx
            .signer
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("shared CLOB requires INFERENCE_BAZAAR_OPERATOR_KEY"))?
            .address())
    }

    /// HTTP-transport service (the `INFERENCE_BAZAAR_CLOB_OPERATORS` peer list).
    pub fn new(venue: Arc<Venue>, cfg: ClobConfig) -> anyhow::Result<Self> {
        let me = Self::attester_of(&venue)?;
        let net = Arc::new(HttpNet::new(&cfg, me));
        Self::with_net(venue, cfg, net)
    }

    /// Service over an explicit transport (the mesh path constructs `MeshNet`
    /// and passes it here). Requires a settlement-configured venue with an
    /// operator key — the key is the attester identity that co-signs batches.
    pub fn with_net(
        venue: Arc<Venue>,
        cfg: ClobConfig,
        net: Arc<dyn ClobNet>,
    ) -> anyhow::Result<Self> {
        let me = Self::attester_of(&venue)?;
        anyhow::ensure!(
            cfg.operators.iter().any(|(a, _)| *a == me),
            "this operator ({me:#x}) is not in INFERENCE_BAZAAR_CLOB_OPERATORS"
        );
        anyhow::ensure!(
            cfg.threshold >= 1 && cfg.threshold <= cfg.operators.len(),
            "threshold {} out of range for {} operators",
            cfg.threshold,
            cfg.operators.len()
        );
        let clob = Clob {
            venue,
            cfg,
            me,
            pool: Mutex::new(HashMap::new()),
            settled: Mutex::new(HashMap::new()),
            cancelled: Mutex::new(HashMap::new()),
            last_epoch: AtomicU64::new(0),
            membership_ok: AtomicBool::new(true),
            domain_checked: AtomicBool::new(false),
            net,
        };
        clob.load_finality();
        Ok(clob)
    }

    /// (chainId, settlement) — the EIP-712 context cancels are bound to.
    pub(crate) fn cancel_ctx(&self) -> (U256, Address) {
        let ctx = self.venue.settle.as_ref().expect("checked in new()");
        (ctx.domain.chain_id.unwrap_or_default(), ctx.contract)
    }

    pub fn current_epoch(&self) -> u64 {
        now_unix() / self.cfg.epoch_secs
    }

    /// The deterministic wall-clock time by which `epoch`'s batch must have
    /// settled: the epoch closes at `(epoch+1)*epoch_secs`, plus a margin for
    /// the on-chain submit. An order must stay valid through this instant or it
    /// can revert the batch with `OrderExpired`. Derived from the AGREED epoch
    /// (not each node's `now`), so proposer and verifiers compute the identical
    /// cutoff and never disagree on which orders are in (audit M3).
    pub(crate) fn settlement_deadline(&self, epoch: u64) -> u64 {
        (epoch + 1) * self.cfg.epoch_secs + EXPIRY_MARGIN_SECS
    }

    pub(crate) fn domain(&self) -> &inference_bazaar_settlement::Eip712Domain {
        &self.venue.settle.as_ref().expect("checked in new()").domain
    }

    pub(crate) fn book_id(&self) -> B256 {
        self.cfg.book_id
    }

    pub(crate) fn signer(&self) -> &inference_bazaar_settlement::Signer {
        self.venue
            .settle
            .as_ref()
            .and_then(|c| c.signer.as_ref())
            .expect("checked in new()")
    }

    pub(crate) fn instrument(&self, id: &str) -> Option<Instrument> {
        self.venue.instruments().into_iter().find(|i| i.id == id)
    }
}

#[cfg(test)]
mod finality_tests {
    use super::*;

    #[test]
    fn finality_journal_round_trips() {
        let mut settled = HashMap::new();
        settled.insert(B256::repeat_byte(0x11), 1_900_000_000u64);
        let mut cancelled = HashMap::new();
        cancelled.insert(
            B256::repeat_byte(0x22),
            (Address::repeat_byte(0xaa), 1_900_000_001u64),
        );
        let j = FinalityJournal {
            settled: settled.clone(),
            cancelled: cancelled.clone(),
        };
        let bytes = serde_json::to_vec(&j).unwrap();
        let back: FinalityJournal = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(back.settled, settled);
        assert_eq!(back.cancelled, cancelled);
    }

    #[test]
    fn attest_deadline_scales_and_clamps() {
        assert_eq!(attest_deadline(10), Duration::from_millis(8000)); // clamped to ceiling
        assert_eq!(attest_deadline(5), Duration::from_millis(4000)); // 80%
        assert_eq!(attest_deadline(1), Duration::from_millis(1000)); // floor
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Instrument, OperatorConfig, QuoteParams, RiskLimits, SettlementConfig};
    use crate::market::{now_unix, SignedOrderBody};
    use crate::venue::Venue;
    use inference_bazaar_matcher::Attestation;
    use inference_bazaar_settlement::{instrument_hash, Order, Signer};
    use serde_json::json;

    pub(super) const INST: &str = "test/model:output";

    struct StubNet;

    #[async_trait::async_trait]
    impl ClobNet for StubNet {
        fn gossip_order(&self, _: &WireOrder) {}
        fn gossip_cancel(&self, _: &WireCancel) {}
        async fn collect_attestations(
            &self,
            _: &WireProposal,
            _: B256,
            _: usize,
        ) -> Vec<Attestation> {
            vec![]
        }
    }

    fn signer() -> Signer {
        Signer::from_hex(&inference_bazaar_settlement::core::hex::encode([0x42; 32])).unwrap()
    }

    /// A single-node CLOB over a stub transport. `rpc_url None` => dry mode
    /// (the consensus round runs, chain reads/submits are skipped).
    pub(super) fn test_clob(rpc_url: Option<&str>) -> Arc<Clob> {
        let me = signer();
        test_clob_as(
            rpc_url,
            &me,
            vec![(me.address(), "http://127.0.0.1:1".into())],
            1,
        )
    }

    pub(super) fn test_clob_as(
        rpc_url: Option<&str>,
        me: &Signer,
        operators: Vec<(Address, String)>,
        threshold: usize,
    ) -> Arc<Clob> {
        let key = inference_bazaar_settlement::core::hex::encode_prefixed([0x42; 32]);
        // The venue's signer is the `me` identity: recover its raw key.
        let me_key = match me.address() == signer().address() {
            true => key.clone(),
            false => inference_bazaar_settlement::core::hex::encode_prefixed([0x43; 32]),
        };
        let cfg = OperatorConfig {
            sidecar_url: "http://127.0.0.1:1".into(),
            router_url: "http://127.0.0.1:1".into(),
            instruments: vec![Instrument {
                id: INST.into(),
                model_id: "test/model".into(),
                token_kind: "output".into(),
                tick_size: 1000,
                min_qty: 1000,
            }],
            params: QuoteParams {
                gamma: 0.0,
                sigma: 0.0,
                horizon_ticks: 0.0,
                k: 0.0,
                size: 0.0,
                max_inventory: 0.0,
                tick_size: 1000.0,
            },
            limits: RiskLimits {
                max_inventory: 0.0,
                max_quote_notional: 0.0,
                max_deviation_bps: 0.0,
                min_spread_bps: 0.0,
                kill_switch_drawdown: 0.0,
            },
            settlement: Some(SettlementConfig {
                chain_id: 31_337,
                contract: format!("{:#x}", Address::with_last_byte(0xcc)),
                operator_key: Some(me_key),
                submitter_key: None,
                rpc_url: rpc_url.map(str::to_string),
                rfq_ttl_secs: 60,
                from_block: 0,
            }),
        };
        let venue = Arc::new(Venue::new(cfg));
        let clob_cfg = ClobConfig {
            book_id: B256::ZERO,
            epoch_secs: 3600, // election is stable for the whole test
            threshold,
            operators,
        };
        Arc::new(Clob::with_net(venue, clob_cfg, Arc::new(StubNet)).unwrap())
    }

    pub(super) fn signed_body(
        clob: &Clob,
        signer: &Signer,
        side: u8,
        price: u64,
        qty: u64,
        salt: u8,
    ) -> SignedOrderBody {
        let order = Order {
            instrument: instrument_hash(INST),
            side,
            priceMicroPerM: price,
            qtyTokens: qty,
            lotId: B256::ZERO,
            trader: signer.address(),
            expiry: now_unix() + 3600,
            salt: B256::with_last_byte(salt),
        };
        let signed = signer.sign_order(&order, clob.domain());
        SignedOrderBody {
            instrument_id: INST.into(),
            order,
            signature: format!(
                "0x{}",
                inference_bazaar_settlement::core::hex::encode(&signed.signature)
            ),
        }
    }

    #[test]
    fn zero_qty_order_is_rejected() {
        let clob = test_clob(None);
        let trader =
            Signer::from_hex(&inference_bazaar_settlement::core::hex::encode([0x11; 32])).unwrap();
        let err = clob
            .admit(signed_body(&clob, &trader, 0, 15_000_000, 0, 1))
            .unwrap_err();
        assert_eq!(err.0, axum::http::StatusCode::UNPROCESSABLE_ENTITY);
        assert!(err.1.contains("qtyTokens must be > 0"), "{:?}", err);
        // …while a sized order admits fine.
        assert!(clob
            .admit(signed_body(&clob, &trader, 0, 15_000_000, 1000, 2))
            .is_ok());
    }

    #[test]
    fn epoch_report_error_detection() {
        use super::driver::epoch_attempt_failed;
        assert!(epoch_attempt_failed(
            &json!({"batches": [{"instrumentId": INST, "error": "HTTP error 429"}]})
        ));
        // Quorum refusal is NOT a transient error: orders carry to next epoch.
        assert!(!epoch_attempt_failed(
            &json!({"batches": [{"instrumentId": INST, "quorum": false}]})
        ));
        assert!(!epoch_attempt_failed(&json!({"batches": []})));
        assert!(!epoch_attempt_failed(&json!({"epoch": 1})));
    }

    #[tokio::test]
    async fn epoch_done_on_dry_success() {
        let clob = test_clob(None);
        let buyer =
            Signer::from_hex(&inference_bazaar_settlement::core::hex::encode([0x21; 32])).unwrap();
        let seller =
            Signer::from_hex(&inference_bazaar_settlement::core::hex::encode([0x22; 32])).unwrap();
        clob.admit(signed_body(&clob, &seller, 1, 14_000_000, 1000, 1))
            .unwrap();
        clob.admit(signed_body(&clob, &buyer, 0, 15_000_000, 1000, 2))
            .unwrap();
        let epoch = clob.current_epoch();
        assert!(
            clob.drive_epoch(epoch).await,
            "dry-mode quorum must complete"
        );
        // …and the orders were pruned by the quorum'd batch.
        assert!(clob.pool.lock().unwrap().is_empty());
    }

    /// A dead RPC makes the pre-match simulation fail the proposal with a
    /// transient error: the tick must report NOT-done so the loop retries the
    /// epoch instead of abandoning it (the Tempo 429 finding).
    #[cfg(feature = "chain")]
    #[tokio::test]
    async fn epoch_not_done_on_transient_chain_failure() {
        let clob = test_clob(Some("http://127.0.0.1:1")); // nothing listens here
        let buyer =
            Signer::from_hex(&inference_bazaar_settlement::core::hex::encode([0x21; 32])).unwrap();
        let seller =
            Signer::from_hex(&inference_bazaar_settlement::core::hex::encode([0x22; 32])).unwrap();
        clob.admit(signed_body(&clob, &seller, 1, 14_000_000, 1000, 1))
            .unwrap();
        clob.admit(signed_body(&clob, &buyer, 0, 15_000_000, 1000, 2))
            .unwrap();
        let epoch = clob.current_epoch();
        assert!(
            !clob.drive_epoch(epoch).await,
            "a chain-read failure must leave the epoch retryable"
        );
        // The orders were NOT pruned (no quorum was ever collected), so the
        // retry has them.
        assert_eq!(clob.pool.lock().unwrap().len(), 2);
    }
}

#[cfg(test)]
mod pending_tests {
    //! Two-stage finality for co-signed batches (post-quorum recovery): co-sign
    //! marks orders PENDING, not settled; only on-chain observation confirms
    //! them, and an unobserved batch is released for a re-drive at its deadline.
    use super::tests::*;
    use super::*;
    use crate::market::now_unix;
    use inference_bazaar_matcher::match_epoch;
    use inference_bazaar_settlement::core::{batch_digest, order_digest};
    use inference_bazaar_settlement::{Order, Signer, SIDE_BUY, SIDE_SELL};

    fn key(b: u8) -> String {
        inference_bazaar_settlement::core::hex::encode_prefixed([b; 32])
    }
    fn signer_b(b: u8) -> Signer {
        Signer::from_hex(&key(b)).unwrap()
    }

    /// A two-operator CLOB where THIS node is the peer (not the epoch's elected
    /// proposer). Returns (clob, proposer signer, epoch).
    fn peer_clob() -> (Arc<Clob>, Signer, u64) {
        let s42 = signer_b(0x42);
        let s43 = signer_b(0x43);
        let epoch = now_unix() / 3600;
        let mut addrs = [s42.address(), s43.address()];
        addrs.sort_unstable();
        let elected = addrs[(epoch % 2) as usize];
        let (proposer, me) = if elected == s42.address() {
            (signer_b(0x42), signer_b(0x43))
        } else {
            (signer_b(0x43), signer_b(0x42))
        };
        let clob = test_clob_as(
            None,
            &me,
            vec![
                (s42.address(), "http://127.0.0.1:1".into()),
                (s43.address(), "http://127.0.0.1:2".into()),
            ],
            2,
        );
        (clob, proposer, epoch)
    }

    /// Admit a crossing pair, build the exact proposal a proposer would
    /// broadcast, and co-sign it via `attest` — the post-quorum state on a peer.
    fn cosigned_pair(clob: &Arc<Clob>, proposer: &Signer, epoch: u64) -> (B256, B256) {
        let seller = signer_b(0x22);
        let buyer = signer_b(0x21);
        let sell = signed_body(clob, &seller, SIDE_SELL, 14_000_000, 1000, 1);
        let buy = signed_body(clob, &buyer, SIDE_BUY, 15_000_000, 1000, 2);
        let sell_digest = order_digest(&sell.order, clob.domain());
        let buy_digest = order_digest(&buy.order, clob.domain());
        clob.admit(sell).unwrap();
        clob.admit(buy).unwrap();

        let orders: Vec<inference_bazaar_settlement::SignedOrder> = clob.snapshot(INST, epoch);
        assert_eq!(orders.len(), 2);
        let inner: Vec<Order> = orders.iter().map(|s| s.order.clone()).collect();
        let batch = match_epoch(INST, 1000, 1000, clob.domain(), &inner);
        assert_eq!(batch.fills.len(), 1, "the pair must cross");
        let digest = batch_digest(B256::ZERO, 0, batch.fills_hash, clob.domain());
        let wire = WireProposal {
            epoch,
            book_id: B256::ZERO,
            batch_nonce: 0,
            instrument_id: INST.into(),
            proposer: proposer.address(),
            proposer_sig: format!(
                "0x{}",
                inference_bazaar_settlement::core::hex::encode(proposer.sign_digest(digest))
            ),
            orders,
            fills_hash: batch.fills_hash,
        };
        let att = clob
            .attest(wire)
            .expect("peer must co-sign an honest batch");
        assert_eq!(att.attester, clob.me);
        (buy_digest, sell_digest)
    }

    #[test]
    fn cosigned_orders_are_pending_not_pruned() {
        let (clob, proposer, epoch) = peer_clob();
        cosigned_pair(&clob, &proposer, epoch);
        // Retained in the pool…
        assert_eq!(clob.pool.lock().unwrap().len(), 2);
        // …but excluded from matching (cannot double-match while the batch may land)…
        assert!(clob.snapshot(INST, epoch).is_empty());
        // …and NOT in the settled finality set (nothing was observed on-chain).
        assert!(clob.settled.lock().unwrap().is_empty());
        assert_eq!(clob.pending_batch_nonces(), vec![0]);
        // A replayed pending order keeps its pending state (no silent un-pend).
        let buyer = signer_b(0x21);
        let again = signed_body(&clob, &buyer, SIDE_BUY, 15_000_000, 1000, 2);
        clob.admit(again).unwrap();
        assert!(clob.snapshot(INST, epoch).is_empty());
    }

    #[test]
    fn lost_batch_is_released_for_redrive() {
        let (clob, proposer, epoch) = peer_clob();
        cosigned_pair(&clob, &proposer, epoch);
        // The settle tx never lands; the deadline passes.
        let ttl = pending_settle_ttl(3600);
        let expired = clob.expired_pending(now_unix() + ttl + 1);
        assert_eq!(expired.len(), 2);
        assert_eq!(clob.release_pending(&expired), 2);
        // The orders re-enter matching: a later elected proposer re-drives them.
        let snapshot = clob.snapshot(INST, epoch);
        assert_eq!(snapshot.len(), 2);
        let inner: Vec<Order> = snapshot.iter().map(|s| s.order.clone()).collect();
        assert_eq!(
            match_epoch(INST, 1000, 1000, clob.domain(), &inner)
                .fills
                .len(),
            1
        );
        assert!(
            clob.settled.lock().unwrap().is_empty(),
            "still never settled"
        );
    }

    #[test]
    fn observed_batch_confirms_and_never_resttles() {
        let (clob, proposer, epoch) = peer_clob();
        let (buy_digest, sell_digest) = cosigned_pair(&clob, &proposer, epoch);
        // The watcher observes bookNonce advance past 0 → confirm.
        assert_eq!(clob.confirm_batch(0), 2);
        assert!(clob.pool.lock().unwrap().is_empty());
        assert!(clob.settled.lock().unwrap().contains_key(&buy_digest));
        assert!(clob.settled.lock().unwrap().contains_key(&sell_digest));
        // Replays are refused as settled — a late second landing cannot re-match.
        let buyer = signer_b(0x21);
        let replay = signed_body(&clob, &buyer, SIDE_BUY, 15_000_000, 1000, 2);
        let err = clob.admit(replay).unwrap_err();
        assert_eq!(err.0, axum::http::StatusCode::CONFLICT);
        assert!(err.1.contains("settled in a prior batch"), "{:?}", err);
    }
}
