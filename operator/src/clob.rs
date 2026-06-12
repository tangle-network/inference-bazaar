//! Shared-CLOB epoch service: the transport + chain wiring around
//! `surplus_matcher`'s pure consensus.
//!
//! Per epoch (a fixed wall-clock window, `SURPLUS_CLOB_EPOCH_SECS`):
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

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use surplus_matcher::{
    aggregate_attestation, elect_proposer, match_epoch, verify_proposal, Attestation,
    BatchProposal, Verdict,
};
use surplus_settlement::core::alloy_primitives::{keccak256, Address, B256, U256};
use surplus_settlement::core::{batch_digest, order_digest, recover_signer, BatchFill, Order};
use surplus_settlement::SignedOrder;

use crate::config::Instrument;
use crate::market::{now_unix, SignedOrderBody};
use crate::venue::Venue;

/// Orders expiring within this margin of epoch close are not matched: the batch
/// must still be valid when the settlement transaction lands.
const EXPIRY_MARGIN_SECS: u64 = 30;
/// Pool cap — a gossip-spam bound, not a market parameter.
const MAX_POOL: usize = 10_000;
/// How long a cancel for an order we have NOT seen is remembered. A cancel must
/// outlive the order it kills; once the order is in hand we extend to its exact
/// expiry. Two days bounds the unseen-order case without growing the set.
const CANCEL_TTL_SECS: u64 = 2 * 24 * 3600;

/// How long a proposer waits for peer co-signatures, derived from the epoch so
/// it can never overrun a short epoch into the next round (audit M7: a fixed
/// 8s window overlapped any `epoch_secs < 8`). 80% of the epoch leaves headroom
/// for the on-chain submit, clamped to a sane floor/ceiling.
pub fn attest_deadline(epoch_secs: u64) -> Duration {
    Duration::from_millis((epoch_secs * 800).clamp(1_000, 8_000))
}

// EIP-712 `SurplusCancel/1`, domain-separated from every other Surplus signature
// (settlement orders, serve auths) so a cancel can never be replayed as anything
// else. Mirrors the on-chain `cancelOrder` authority (msg.sender == trader) with
// a portable signature the gossip layer can carry.
const CANCEL_DOMAIN_NAME: &[u8] = b"SurplusCancel";
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

// ─────────────────────────────── Config ──────────────────────────────────────

#[derive(Clone, Debug)]
pub struct ClobConfig {
    /// The matching domain (contract `Book`) this fleet settles through —
    /// `SURPLUS_CLOB_BOOK`, 0x-hex bytes32. Must be registered on-chain via
    /// `registerBook` with exactly this operator set. Default: the zero book.
    pub book_id: B256,
    pub epoch_secs: u64,
    /// Quorum size — must equal the contract's `attesterThreshold`.
    pub threshold: usize,
    /// The full bonded operator set, THIS node included: (attester address,
    /// base URL). Election and quorum run over exactly this list, so every node
    /// must be configured with the same set — it is the off-chain mirror of the
    /// contract's attester set.
    pub operators: Vec<(Address, String)>,
}

impl ClobConfig {
    /// `SURPLUS_CLOB_OPERATORS="0xabc..=http://h1:9500,0xdef..=http://h2:9400"`
    /// plus `SURPLUS_CLOB_THRESHOLD` (default 2) and `SURPLUS_CLOB_EPOCH_SECS`
    /// (default 10). `Ok(None)` when unset — the shared CLOB is opt-in. A SET
    /// but malformed value is an ERROR, never a silent skip: a node that boots
    /// green while quietly not participating also stalls every peer that needs
    /// its co-signature for quorum.
    pub fn from_env() -> anyhow::Result<Option<Self>> {
        let Ok(raw) = std::env::var("SURPLUS_CLOB_OPERATORS") else {
            return Ok(None);
        };
        let mut operators = Vec::new();
        for entry in raw.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            let (addr, url) = entry.split_once('=').ok_or_else(|| {
                anyhow::anyhow!("SURPLUS_CLOB_OPERATORS entry '{entry}' is not 0xaddr=url")
            })?;
            let addr: Address = addr.trim().parse().map_err(|_| {
                anyhow::anyhow!("SURPLUS_CLOB_OPERATORS entry '{entry}' has a bad address")
            })?;
            operators.push((addr, url.trim().trim_end_matches('/').to_string()));
        }
        anyhow::ensure!(
            !operators.is_empty(),
            "SURPLUS_CLOB_OPERATORS is set but lists no operators"
        );
        let threshold = match std::env::var("SURPLUS_CLOB_THRESHOLD") {
            Ok(v) => v
                .parse()
                .map_err(|_| anyhow::anyhow!("SURPLUS_CLOB_THRESHOLD '{v}' is not a number"))?,
            Err(_) => 2,
        };
        let epoch_secs = match std::env::var("SURPLUS_CLOB_EPOCH_SECS") {
            Ok(v) => {
                let secs: u64 = v.parse().map_err(|_| {
                    anyhow::anyhow!("SURPLUS_CLOB_EPOCH_SECS '{v}' is not a number")
                })?;
                anyhow::ensure!(
                    secs >= 2,
                    "SURPLUS_CLOB_EPOCH_SECS must be >= 2, got {secs}"
                );
                secs
            }
            Err(_) => 10,
        };
        let book_id = match std::env::var("SURPLUS_CLOB_BOOK") {
            Ok(v) => v
                .parse()
                .map_err(|_| anyhow::anyhow!("SURPLUS_CLOB_BOOK '{v}' is not bytes32 hex"))?,
            Err(_) => B256::ZERO,
        };
        Ok(Some(ClobConfig {
            book_id,
            epoch_secs,
            threshold,
            operators,
        }))
    }

    fn addresses(&self) -> Vec<Address> {
        self.operators.iter().map(|(a, _)| *a).collect()
    }
}

// ─────────────────────────────── Transport seam ──────────────────────────────

/// How the epoch service reaches its peers: order fanout and the proposer's
/// co-signature round. Two transports implement it — [`HttpNet`] (static peer
/// URL list, plain HTTP) and `mesh::MeshNet` (feature `mesh`):
/// blueprint-networking's PKI-gated gossip, where only the whitelisted bonded
/// operator set can complete a handshake, let alone speak. Consensus safety
/// never rests on the transport (signatures authenticate everything end to
/// end); the transport decides who can spam you.
#[async_trait]
pub trait ClobNet: Send + Sync {
    /// Best-effort one-hop fanout of an admitted order. Loss surfaces as a
    /// censorship verdict at verification time, never as silent divergence.
    fn gossip_order(&self, w: &WireOrder);

    /// Best-effort fanout of a signed cancel — same path as orders, so a cancel
    /// reaches every pool before the next epoch matches the order.
    fn gossip_cancel(&self, c: &WireCancel);

    /// Broadcast a proposal and collect peer co-signatures over `digest` until
    /// `want` arrive or the transport's deadline passes. Self-attestation is
    /// the caller's job; returned signatures are validated by
    /// `aggregate_attestation`, so the transport may return garbage safely.
    async fn collect_attestations(
        &self,
        wire: &WireProposal,
        digest: B256,
        want: usize,
    ) -> Vec<Attestation>;
}

/// The static peer-list HTTP transport (`SURPLUS_CLOB_OPERATORS`).
pub struct HttpNet {
    me: Address,
    operators: Vec<(Address, String)>,
    http: reqwest::Client,
}

impl HttpNet {
    pub fn new(cfg: &ClobConfig, me: Address) -> Self {
        HttpNet {
            me,
            operators: cfg.operators.clone(),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .expect("reqwest client"),
        }
    }

    async fn request_attestation(
        &self,
        peer_url: &str,
        wire: &WireProposal,
    ) -> anyhow::Result<Attestation> {
        let resp = self
            .http
            .post(format!("{peer_url}/clob/propose"))
            .json(wire)
            .send()
            .await?;
        anyhow::ensure!(
            resp.status().is_success(),
            "{}: {}",
            resp.status(),
            resp.text().await.unwrap_or_default()
        );
        let att: WireAttestation = resp.json().await?;
        Ok(Attestation {
            attester: att.attester,
            signature: surplus_settlement::core::hex::decode(
                att.signature.trim_start_matches("0x"),
            )?,
        })
    }
}

#[async_trait]
impl ClobNet for HttpNet {
    fn gossip_order(&self, w: &WireOrder) {
        for (addr, url) in &self.operators {
            if *addr == self.me {
                continue;
            }
            let http = self.http.clone();
            let url = format!("{url}/clob/gossip");
            let body = w.clone();
            tokio::spawn(async move {
                if let Err(e) = http.post(&url).json(&body).send().await {
                    crate::metrics::inc(crate::metrics::names::GOSSIP_SEND_FAILURES);
                    tracing::warn!(%url, "gossip relay failed: {e}");
                }
            });
        }
    }

    fn gossip_cancel(&self, c: &WireCancel) {
        for (addr, url) in &self.operators {
            if *addr == self.me {
                continue;
            }
            let http = self.http.clone();
            let url = format!("{url}/clob/cancel-gossip");
            let body = c.clone();
            tokio::spawn(async move {
                if let Err(e) = http.post(&url).json(&body).send().await {
                    tracing::warn!(%url, "cancel relay failed: {e}");
                }
            });
        }
    }

    async fn collect_attestations(
        &self,
        wire: &WireProposal,
        _digest: B256,
        want: usize,
    ) -> Vec<Attestation> {
        // EVERY peer gets the proposal, concurrently — never stop at threshold.
        // Co-signing has a side effect (the peer prunes the batch's orders from
        // its pool), so a peer that never sees a settling proposal keeps the
        // settled orders and, when it is next elected, re-proposes them into an
        // on-chain Overfill revert. Observed live the moment the quorum grew to
        // 3: the third attester's first elected epoch re-proposed an
        // already-settled batch. Quorum still only NEEDS `want` signatures; the
        // rest arrive (and prune) regardless. Parallel fan-out also bounds the
        // round at one peer-timeout instead of peers × timeout.
        let _ = want;
        let requests = self
            .operators
            .iter()
            .filter(|(addr, _)| *addr != self.me)
            .map(|(_, url)| async move {
                match self.request_attestation(url, wire).await {
                    Ok(att) => Some(att),
                    Err(e) => {
                        tracing::warn!(peer = %url, "attestation refused: {e}");
                        None
                    }
                }
            });
        futures::future::join_all(requests)
            .await
            .into_iter()
            .flatten()
            .collect()
    }
}

// ─────────────────────────────── Service state ───────────────────────────────

/// The restart-durable finality record (settled + cancelled order digests).
#[derive(Default, Serialize, Deserialize)]
struct FinalityJournal {
    settled: HashMap<B256, u64>,
    cancelled: HashMap<B256, (Address, u64)>,
}

struct PoolEntry {
    instrument_id: String,
    signed: SignedOrder,
}

pub struct Clob {
    venue: Arc<Venue>,
    cfg: ClobConfig,
    /// My attester identity — the venue's operator signer.
    me: Address,
    /// Gossiped order pool, keyed by order digest. Orders persist across epochs
    /// until matched, expired, or evicted.
    pool: Mutex<HashMap<B256, PoolEntry>>,
    /// Digest → expiry of every order a co-signed batch ever touched. A settled
    /// order is a signed public object — replaying it (late gossip, or an
    /// attacker) would re-admit it, re-match it next epoch, and revert that
    /// whole batch on the contract's `filled` cap: a liveness grief. This set
    /// makes settlement final at admission; it self-bounds by order expiry.
    settled: Mutex<HashMap<B256, u64>>,
    /// orderHash → (trader, gc-expiry) for every order a signed cancel has
    /// killed. An order in this set cannot be (re-)admitted, so a cancelled
    /// order never enters a batch — which would revert `OrderIsCancelled`
    /// on-chain and grief the whole batch. Survives a cancel that races ahead of
    /// the order it cancels (pre-order cancel), self-bounds by expiry.
    cancelled: Mutex<HashMap<B256, (Address, u64)>>,
    /// Last epoch this node ran as proposer (idempotence for the driver loop).
    last_epoch: AtomicU64,
    /// False only after a CONFIRMED mismatch between the configured operator set/
    /// threshold and the contract's on-chain `bookAttesters`/`bookThreshold`. The
    /// contract is the source of truth: proposing against a quorum the contract
    /// will reject is pure liveness grief, so a drifted node stops proposing.
    /// Stays true if the on-chain read is merely unavailable (no false stall).
    membership_ok: AtomicBool,
    net: Arc<dyn ClobNet>,
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
            .ok_or_else(|| anyhow::anyhow!("shared CLOB requires SURPLUS_OPERATOR_KEY"))?
            .address())
    }

    /// HTTP-transport service (the `SURPLUS_CLOB_OPERATORS` peer list).
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
            "this operator ({me:#x}) is not in SURPLUS_CLOB_OPERATORS"
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
            net,
        };
        clob.load_finality();
        Ok(clob)
    }

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

    fn load_finality(&self) {
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

    /// Reconcile the configured operator set/threshold against the contract's
    /// `bookAttesters`/`bookThreshold` for this book — the contract is the source
    /// of truth. On a CONFIRMED mismatch, mark membership not-ok (the node stops
    /// proposing, since the quorum it would gather can't settle on-chain) and log
    /// loudly. An unavailable RPC is NOT a mismatch — last-known config stands.
    #[cfg(feature = "chain")]
    pub(crate) async fn verify_membership(self: &Arc<Self>) {
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

    /// (chainId, settlement) — the EIP-712 context cancels are bound to.
    fn cancel_ctx(&self) -> (U256, Address) {
        let ctx = self.venue.settle.as_ref().expect("checked in new()");
        (ctx.domain.chain_id.unwrap_or_default(), ctx.contract)
    }

    /// Verify a signed cancel (recovers to the order's trader), record it, and
    /// drop the order from the pool if held. Idempotent. A cancel for an order
    /// not yet seen is remembered so the order is refused on arrival.
    pub(crate) fn admit_cancel(&self, c: WireCancel) -> Result<Value, (StatusCode, String)> {
        let sig = surplus_settlement::core::hex::decode(c.signature.trim_start_matches("0x"))
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
    fn is_cancelled(&self, order_hash: B256, trader: Address) -> bool {
        let now = now_unix();
        let mut cancelled = self.cancelled.lock().unwrap();
        cancelled.retain(|_, (_, exp)| *exp >= now);
        cancelled
            .get(&order_hash)
            .map(|(t, _)| *t == trader)
            .unwrap_or(false)
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
    fn settlement_deadline(&self, epoch: u64) -> u64 {
        (epoch + 1) * self.cfg.epoch_secs + EXPIRY_MARGIN_SECS
    }

    pub(crate) fn domain(&self) -> &surplus_settlement::Eip712Domain {
        &self.venue.settle.as_ref().expect("checked in new()").domain
    }

    pub(crate) fn book_id(&self) -> B256 {
        self.cfg.book_id
    }

    fn signer(&self) -> &surplus_settlement::Signer {
        self.venue
            .settle
            .as_ref()
            .and_then(|c| c.signer.as_ref())
            .expect("checked in new()")
    }

    fn instrument(&self, id: &str) -> Option<Instrument> {
        self.venue.instruments().into_iter().find(|i| i.id == id)
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
    fn snapshot(&self, instrument_id: &str, epoch: u64) -> Vec<SignedOrder> {
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
    fn prune_filled(&self, fills: &[BatchFill]) {
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

    // ───────────────────────────── Proposer side ─────────────────────────────

    /// Run one epoch as proposer: match, broadcast, collect quorum, submit.
    /// Returns a per-instrument report. Election is NOT re-checked here — peers
    /// enforce it when deciding whether to co-sign.
    pub async fn run_epoch(self: &Arc<Self>, epoch: u64) -> Value {
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
        self: &Arc<Self>,
        epoch: u64,
        inst: &Instrument,
        snapshot: Vec<SignedOrder>,
    ) -> anyhow::Result<Option<Value>> {
        let domain = self.domain().clone();
        let inner: Vec<Order> = snapshot.iter().map(|s| s.order.clone()).collect();
        let batch = match_epoch(&inst.id, inst.tick_size, inst.min_qty, &domain, &inner);
        if batch.fills.is_empty() {
            return Ok(None); // nothing crossed; pool carries to the next epoch
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

        // Quorum reached: the batch is final for the network. Prune before
        // submitting — co-signers already pruned, and re-matching filled orders
        // would poison the next epoch.
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
        let ctx = self.venue.settle.as_ref().expect("checked in new()");
        let (Some(rpc), Some(key)) = (ctx.rpc_url.as_deref(), ctx.submitter_key()) else {
            return Ok(None);
        };
        let client =
            surplus_settlement::chain::SettlementClient::connect(rpc, key, ctx.contract).await?;
        Ok(Some(client))
    }

    // ───────────────────────────── Peer side ─────────────────────────────────

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
        let mut per_instrument: HashMap<&str, usize> = HashMap::new();
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

// ─────────────────────────────── Wire types ──────────────────────────────────

/// Gossip relay body — identical shape to [`SignedOrderBody`] (which is
/// deserialize-only), so the same JSON a client posts to `/clob/order` flows on
/// to peers unchanged.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireOrder {
    pub instrument_id: String,
    pub order: Order,
    pub signature: String,
}

impl From<WireOrder> for SignedOrderBody {
    fn from(w: WireOrder) -> Self {
        SignedOrderBody {
            instrument_id: w.instrument_id,
            order: w.order,
            signature: w.signature,
        }
    }
}

/// A signed order cancel. `signature` is the trader's EIP-712 `SurplusCancel`
/// signature over `orderHash` (`cancel_digest`), the off-chain analogue of the
/// contract's `cancelOrder` (msg.sender == trader).
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireCancel {
    pub order_hash: B256,
    pub trader: Address,
    /// 65-byte r||s||v signature, 0x-hex.
    pub signature: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireProposal {
    pub epoch: u64,
    /// The matching domain (contract `Book`) — peers refuse foreign books.
    pub book_id: B256,
    pub batch_nonce: u64,
    pub instrument_id: String,
    pub proposer: Address,
    /// The proposer's 65-byte signature over `batch_digest(batchNonce,
    /// fillsHash)`, 0x-hex — the same signature it self-attests with. Proves
    /// the proposal really comes from the elected proposer; peers refuse
    /// co-sign side effects without it.
    pub proposer_sig: String,
    /// The matched order set, trader signatures included (`SignedOrder`
    /// serializes its signature as 0x-hex).
    pub orders: Vec<SignedOrder>,
    pub fills_hash: B256,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireAttestation {
    pub attester: Address,
    /// 65-byte r||s||v signature, 0x-hex.
    pub signature: String,
}

// ─────────────────────────────── HTTP surface ────────────────────────────────

pub fn router(clob: SharedClob) -> Router {
    Router::new()
        .route("/clob/order", post(clob_order))
        .route("/clob/gossip", post(clob_gossip))
        .route("/clob/cancel", post(clob_cancel))
        .route("/clob/cancel-gossip", post(clob_cancel_gossip))
        .route("/clob/propose", post(clob_propose))
        .route("/clob/run-epoch", post(clob_run_epoch))
        .route("/clob/status", get(clob_status))
        // A proposal carries the full matched order set; at MAX_POOL (10k orders
        // × ~450B JSON) it nears 5MB, well over axum's 2MB default — which would
        // 413 legitimate proposals exactly at the load the pool cap allows
        // (audit H4). Raise the limit with headroom. The eventual scale fix is a
        // digest-list proposal with pull-missing, but this removes the cliff now.
        .layer(axum::extract::DefaultBodyLimit::max(16 * 1024 * 1024))
        .with_state(clob)
}

async fn clob_order(State(c): State<SharedClob>, Json(b): Json<WireOrder>) -> impl IntoResponse {
    match c.submit_order(b) {
        Ok(val) => Json(val).into_response(),
        Err((status, msg)) => (status, msg).into_response(),
    }
}

async fn clob_gossip(State(c): State<SharedClob>, Json(b): Json<WireOrder>) -> impl IntoResponse {
    match c.admit(b.into()) {
        Ok(val) => Json(val).into_response(),
        Err((status, msg)) => (status, msg).into_response(),
    }
}

async fn clob_cancel(State(c): State<SharedClob>, Json(b): Json<WireCancel>) -> impl IntoResponse {
    match c.submit_cancel(b) {
        Ok(val) => Json(val).into_response(),
        Err((status, msg)) => (status, msg).into_response(),
    }
}

async fn clob_cancel_gossip(
    State(c): State<SharedClob>,
    Json(b): Json<WireCancel>,
) -> impl IntoResponse {
    match c.admit_cancel(b) {
        Ok(val) => Json(val).into_response(),
        Err((status, msg)) => (status, msg).into_response(),
    }
}

async fn clob_propose(
    State(c): State<SharedClob>,
    Json(b): Json<WireProposal>,
) -> impl IntoResponse {
    match c.attest(b) {
        Ok(att) => Json(att).into_response(),
        Err((status, body)) => (status, Json(body)).into_response(),
    }
}

/// Manual epoch trigger (ops + e2e proof). Refuses when this node is not the
/// epoch's elected proposer — and peers would refuse to co-sign anyway, so this
/// cannot be used to seize leadership.
async fn clob_run_epoch(State(c): State<SharedClob>) -> impl IntoResponse {
    let epoch = c.current_epoch();
    let elected = elect_proposer(&c.cfg.addresses(), epoch);
    if elected != Some(c.me) {
        return (
            StatusCode::CONFLICT,
            Json(json!({
                "error": "not the elected proposer this epoch",
                "epoch": epoch,
                "elected": elected.map(|a| format!("{a:#x}")),
            })),
        )
            .into_response();
    }
    Json(c.run_epoch(epoch).await).into_response()
}

async fn clob_status(State(c): State<SharedClob>) -> impl IntoResponse {
    Json(c.status())
}

/// Boot the shared CLOB from env, picking the transport: blueprint-networking's
/// PKI mesh when compiled with `mesh` and `SURPLUS_MESH_ADDR` is set, else the
/// HTTP peer list. Returns the service plus its HTTP surface (order entry +
/// ops endpoints — mounted in both transports; in mesh mode the fanout simply
/// rides the mesh instead of peer URLs).
///
/// A fleet MUST be homogeneous: a mesh node fans proposals out only on the
/// mesh, so a mixed mesh/HTTP fleet partitions and HTTP-led epochs are vetoed
/// (audit H7). The transport is logged loudly at boot so a mismatch is visible
/// in ops, and the gossip_send_failures / quorum_failed metrics surface the
/// resulting partition. Treat transport as a fleet-wide deployment parameter.
pub fn start_from_env(venue: Arc<Venue>) -> anyhow::Result<Option<(SharedClob, Router)>> {
    let Some(cfg) = ClobConfig::from_env()? else {
        return Ok(None);
    };
    #[cfg(feature = "mesh")]
    if std::env::var("SURPLUS_MESH_ADDR").is_ok() {
        tracing::info!("shared CLOB transport: PKI mesh (the whole fleet must run mesh)");
        return crate::mesh::start(venue, cfg).map(Some);
    }
    tracing::info!(
        peers = cfg.operators.len(),
        "shared CLOB transport: HTTP peer list (the whole fleet must run HTTP)"
    );
    let clob = Arc::new(Clob::new(venue, cfg)?);
    spawn_membership_reconciler(clob.clone());
    spawn_epoch_loop(clob.clone());
    let r = router(clob.clone());
    Ok(Some((clob, r)))
}

/// Periodically reconcile the configured operator set against the contract's
/// `bookAttesters` (the source of truth). Without the `chain` feature this is a
/// no-op — the off-chain set is then trusted as-is.
pub fn spawn_membership_reconciler(clob: SharedClob) {
    #[cfg(feature = "chain")]
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(300));
        loop {
            clob.verify_membership().await;
            tick.tick().await;
        }
    });
    #[cfg(not(feature = "chain"))]
    let _ = clob;
}

/// The epoch driver: at every epoch boundary, if this node is the elected
/// proposer and holds orders, run the propose → co-sign → submit round.
pub fn spawn_epoch_loop(clob: SharedClob) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(500));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            let epoch = clob.current_epoch();
            if epoch == clob.last_epoch.load(Ordering::Relaxed) {
                continue;
            }
            clob.last_epoch.store(epoch, Ordering::Relaxed);
            if !clob.membership_ok.load(Ordering::Relaxed) {
                continue; // confirmed drift from the contract's attester set
            }
            if elect_proposer(&clob.cfg.addresses(), epoch) != Some(clob.me) {
                continue;
            }
            if clob.pool.lock().unwrap().is_empty() {
                continue;
            }
            let report = clob.run_epoch(epoch).await;
            tracing::debug!(%report, "epoch run");
        }
    });
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
