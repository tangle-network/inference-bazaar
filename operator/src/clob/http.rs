//! The HTTP surface: the axum router + handlers for order entry and the ops
//! endpoints, the env-driven boot (`start_from_env` picks the transport), and
//! the two background loops (membership reconciliation + the epoch driver).

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use inference_bazaar_matcher::elect_proposer;
use serde_json::json;

use super::{Clob, ClobConfig, SharedClob, WireCancel, WireOrder, WireProposal};
use crate::venue::Venue;

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
/// PKI mesh when compiled with `mesh` and `INFERENCE_BAZAAR_MESH_ADDR` is set, else the
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
    if std::env::var("INFERENCE_BAZAAR_MESH_ADDR").is_ok() {
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
