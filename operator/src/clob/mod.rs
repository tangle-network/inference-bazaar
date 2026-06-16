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
//! Failure mode is liveness, never safety: orders touched by a co-signed batch
//! leave the pool (re-matching a filled order would overfill and revert the next
//! batch on-chain), so if a submission fails after quorum the affected orders
//! must be resubmitted — they can never double-settle (`batchNonce` scopes each
//! quorum signature, the contract's `filled` map caps every order).
//!
//! Module layout (audit M4 — `clob.rs` was a ~1.4k-line god-object):
//!   - [`config`] — `ClobConfig` + env parsing.
//!   - [`net`] — the `ClobNet` transport trait + the HTTP peer-list impl.
//!   - [`wire`] — the JSON wire types (`WireOrder`/`WireCancel`/…).
//!   - [`pool`] — order/cancel admission, the settled/cancelled finality sets,
//!     the epoch snapshot, prune/evict (state mutation).
//!   - [`driver`] — proposer side: match → pre-sim → quorum → submit, plus the
//!     on-chain client and membership reconciliation.
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
pub use http::{router, spawn_epoch_loop, spawn_membership_reconciler, start_from_env};
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
}

pub struct Clob {
    pub(crate) venue: Arc<Venue>,
    pub(crate) cfg: ClobConfig,
    /// My attester identity — the venue's operator signer.
    pub(crate) me: Address,
    /// Gossiped order pool, keyed by order digest. Orders persist across epochs
    /// until matched, expired, or evicted.
    pub(crate) pool: Mutex<HashMap<B256, PoolEntry>>,
    /// Digest → expiry of every order a co-signed batch ever touched. A settled
    /// order is a signed public object — replaying it (late gossip, or an
    /// attacker) would re-admit it, re-match it next epoch, and revert that
    /// whole batch on the contract's `filled` cap: a liveness grief. This set
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
