//! Shared-CLOB epoch service: the transport + chain wiring around
//! `surplus_matcher`'s pure consensus.
//!
//! Per epoch (a fixed wall-clock window, `SURPLUS_CLOB_EPOCH_SECS`):
//!   1. Signed orders arrive at any operator (`POST /clob/order`) and are
//!      relayed once to every peer (`POST /clob/gossip`) — all operators
//!      accumulate the same order pool.
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
//! contract re-verifies the quorum). Proposal requests are unauthenticated by
//! design for now: an impersonated "proposal" still has to carry honestly signed
//! orders and a reproducible match to collect signatures, so impersonation can
//! only produce an honest batch (griefing is bounded by the rate limiter).
//!
//! Failure mode is liveness, never safety: orders touched by a co-signed batch
//! leave the pool (re-matching a filled order would overfill and revert the next
//! batch on-chain), so if a submission fails after quorum the affected orders
//! must be resubmitted — they can never double-settle (`batchNonce` scopes each
//! quorum signature, the contract's `filled` map caps every order).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

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
use surplus_settlement::core::alloy_primitives::{Address, B256};
use surplus_settlement::core::{batch_digest, order_digest, BatchFill, Order};
use surplus_settlement::SignedOrder;

use crate::config::Instrument;
use crate::market::{now_unix, SignedOrderBody};
use crate::venue::Venue;

/// Orders expiring within this margin of epoch close are not matched: the batch
/// must still be valid when the settlement transaction lands.
const EXPIRY_MARGIN_SECS: u64 = 30;
/// Pool cap — a gossip-spam bound, not a market parameter.
const MAX_POOL: usize = 10_000;

// ─────────────────────────────── Config ──────────────────────────────────────

#[derive(Clone, Debug)]
pub struct ClobConfig {
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
    /// (default 10). Returns None when unset — the shared CLOB is opt-in.
    pub fn from_env() -> Option<Self> {
        let raw = std::env::var("SURPLUS_CLOB_OPERATORS").ok()?;
        let mut operators = Vec::new();
        for entry in raw.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            let (addr, url) = entry.split_once('=')?;
            let addr: Address = addr.trim().parse().ok()?;
            operators.push((addr, url.trim().trim_end_matches('/').to_string()));
        }
        if operators.is_empty() {
            return None;
        }
        let threshold = std::env::var("SURPLUS_CLOB_THRESHOLD")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(2);
        let epoch_secs = std::env::var("SURPLUS_CLOB_EPOCH_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .filter(|v: &u64| *v >= 2)
            .unwrap_or(10);
        Some(ClobConfig {
            epoch_secs,
            threshold,
            operators,
        })
    }

    fn addresses(&self) -> Vec<Address> {
        self.operators.iter().map(|(a, _)| *a).collect()
    }
}

// ─────────────────────────────── Service state ───────────────────────────────

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
    /// Last epoch this node ran as proposer (idempotence for the driver loop).
    last_epoch: AtomicU64,
    http: reqwest::Client,
}

pub type SharedClob = Arc<Clob>;

impl Clob {
    /// Requires a settlement-configured venue with an operator key — the key is
    /// the attester identity that co-signs batches.
    pub fn new(venue: Arc<Venue>, cfg: ClobConfig) -> anyhow::Result<Self> {
        let ctx = venue
            .settle
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("shared CLOB requires settlement config"))?;
        let me = ctx
            .signer
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("shared CLOB requires SURPLUS_OPERATOR_KEY"))?
            .address();
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
        Ok(Clob {
            venue,
            cfg,
            me,
            pool: Mutex::new(HashMap::new()),
            last_epoch: AtomicU64::new(0),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .expect("reqwest client"),
        })
    }

    pub fn current_epoch(&self) -> u64 {
        now_unix() / self.cfg.epoch_secs
    }

    fn domain(&self) -> &surplus_settlement::Eip712Domain {
        &self.venue.settle.as_ref().expect("checked in new()").domain
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
    fn admit(&self, body: SignedOrderBody) -> Result<Value, (StatusCode, String)> {
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
        let digest = signed.digest(self.domain());
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
        Ok(json!({
            "digest": format!("{digest:#x}"),
            "instrumentId": instrument_id,
            "epoch": self.current_epoch(),
            "poolSize": pool.len(),
        }))
    }

    /// One-hop relay to every peer. Best-effort: gossip loss surfaces as a
    /// censorship verdict at verification time, not as silent divergence.
    fn relay(self: &Arc<Self>, body: WireOrder) {
        for (addr, url) in &self.cfg.operators {
            if *addr == self.me {
                continue;
            }
            let http = self.http.clone();
            let url = format!("{url}/clob/gossip");
            let body = body.clone();
            tokio::spawn(async move {
                if let Err(e) = http.post(&url).json(&body).send().await {
                    tracing::warn!(%url, "gossip relay failed: {e}");
                }
            });
        }
    }

    /// Snapshot the pool for one instrument, dropping orders that expire too
    /// soon to settle (the contract rejects the whole batch on one expired order).
    fn snapshot(&self, instrument_id: &str) -> Vec<SignedOrder> {
        let horizon = now_unix() + EXPIRY_MARGIN_SECS;
        let mut pool = self.pool.lock().unwrap();
        pool.retain(|_, e| e.signed.order.expiry >= horizon);
        pool.values()
            .filter(|e| e.instrument_id == instrument_id)
            .map(|e| e.signed.clone())
            .collect()
    }

    /// Remove every order touched by a fill. Mandatory after co-signing or
    /// submitting a batch: an order that filled (even partially) would overfill
    /// on re-match and revert the next batch.
    fn prune_filled(&self, fills: &[BatchFill]) {
        let domain = self.domain().clone();
        let mut pool = self.pool.lock().unwrap();
        for f in fills {
            pool.remove(&order_digest(&f.buy, &domain));
            pool.remove(&order_digest(&f.sell, &domain));
        }
    }

    // ───────────────────────────── Proposer side ─────────────────────────────

    /// Run one epoch as proposer: match, broadcast, collect quorum, submit.
    /// Returns a per-instrument report. Election is NOT re-checked here — peers
    /// enforce it when deciding whether to co-sign.
    pub async fn run_epoch(self: &Arc<Self>, epoch: u64) -> Value {
        let mut reports = Vec::new();
        for inst in self.venue.instruments() {
            let snapshot = self.snapshot(&inst.id);
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
        let digest = batch_digest(batch_nonce, batch.fills_hash, &domain);

        // Self-attest, then collect peer co-signatures.
        let mut attestations = vec![Attestation {
            attester: self.me,
            signature: self.signer().sign_digest(digest).to_vec(),
        }];
        let wire = WireProposal {
            epoch,
            batch_nonce,
            instrument_id: inst.id.clone(),
            proposer: self.me,
            orders: snapshot,
            fills_hash: batch.fills_hash,
        };
        for (addr, url) in &self.cfg.operators {
            if *addr == self.me {
                continue;
            }
            match self.request_attestation(url, &wire).await {
                Ok(att) => attestations.push(att),
                Err(e) => tracing::warn!(peer = %url, "attestation refused: {e}"),
            }
        }

        let quorum = aggregate_attestation(
            digest,
            &attestations,
            &self.cfg.addresses(),
            self.cfg.threshold,
        );
        let Some(sigs) = quorum else {
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

        // Quorum reached: the batch is final for the network. Prune before
        // submitting — co-signers already pruned, and re-matching filled orders
        // would poison the next epoch.
        self.prune_filled(&batch.fills);
        let submitted = self.submit(&batch.fills, sigs).await?;
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

    /// Dry without the `chain` feature OR without RPC config — same rule as
    /// `flush_settlement`. The consensus round still runs end to end; only the
    /// chain read/submit are skipped.
    async fn read_batch_nonce(&self) -> anyhow::Result<u64> {
        #[cfg(feature = "chain")]
        if let Some(client) = self.chain_client().await? {
            return client.batch_nonce().await;
        }
        Ok(0)
    }

    async fn submit(&self, fills: &[BatchFill], sigs: Vec<Vec<u8>>) -> anyhow::Result<String> {
        #[cfg(feature = "chain")]
        if let Some(client) = self.chain_client().await? {
            let tx = client.settle_batch_fills_attested(fills, sigs).await?;
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
        let (Some(rpc), Some(key)) = (ctx.rpc_url.as_deref(), ctx.operator_key.as_deref()) else {
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
    fn attest(&self, wire: WireProposal) -> Result<WireAttestation, (StatusCode, Value)> {
        let current = self.current_epoch();
        if wire.epoch.abs_diff(current) > 1 {
            return Err((
                StatusCode::CONFLICT,
                json!({ "verdict": "stale-epoch", "current": current, "proposed": wire.epoch }),
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
        let Some(inst) = self.instrument(&wire.instrument_id) else {
            return Err((
                StatusCode::NOT_FOUND,
                json!({ "verdict": "unknown-instrument", "instrumentId": wire.instrument_id }),
            ));
        };

        let domain = self.domain().clone();
        let my_orders = self.snapshot(&wire.instrument_id);
        let proposal = BatchProposal {
            epoch: wire.epoch,
            batch_nonce: wire.batch_nonce,
            instrument_id: wire.instrument_id,
            proposer: wire.proposer,
            orders: wire.orders,
            fills_hash: wire.fills_hash,
        };
        match verify_proposal(&proposal, &my_orders, inst.tick_size, inst.min_qty, &domain) {
            Verdict::Sign(digest) => {
                // Final for this node: prune what the batch fills so the next
                // epoch cannot re-match (and overfill) settled orders.
                let inner: Vec<Order> = proposal.orders.iter().map(|s| s.order.clone()).collect();
                let recomputed = match_epoch(
                    &proposal.instrument_id,
                    inst.tick_size,
                    inst.min_qty,
                    &domain,
                    &inner,
                );
                self.prune_filled(&recomputed.fills);
                Ok(WireAttestation {
                    attester: self.me,
                    signature: format!(
                        "0x{}",
                        surplus_settlement::core::hex::encode(self.signer().sign_digest(digest),)
                    ),
                })
            }
            Verdict::Forged(digests) => Err((
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({ "verdict": "forged", "orders": hex_all(&digests) }),
            )),
            Verdict::FillsHashMismatch => Err((
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({ "verdict": "fills-hash-mismatch" }),
            )),
            Verdict::Censored(digests) => Err((
                StatusCode::CONFLICT,
                json!({ "verdict": "censored", "missing": hex_all(&digests) }),
            )),
        }
    }

    fn status(&self) -> Value {
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

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireProposal {
    pub epoch: u64,
    pub batch_nonce: u64,
    pub instrument_id: String,
    pub proposer: Address,
    /// The matched order set, trader signatures included (`SignedOrder`
    /// serializes its signature as 0x-hex).
    pub orders: Vec<SignedOrder>,
    pub fills_hash: B256,
}

#[derive(Serialize, Deserialize)]
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
        .route("/clob/propose", post(clob_propose))
        .route("/clob/run-epoch", post(clob_run_epoch))
        .route("/clob/status", get(clob_status))
        .with_state(clob)
}

async fn clob_order(State(c): State<SharedClob>, Json(b): Json<WireOrder>) -> impl IntoResponse {
    match c.admit(b.clone().into()) {
        Ok(val) => {
            c.relay(b);
            Json(val).into_response()
        }
        Err((status, msg)) => (status, msg).into_response(),
    }
}

async fn clob_gossip(State(c): State<SharedClob>, Json(b): Json<WireOrder>) -> impl IntoResponse {
    match c.admit(b.into()) {
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
