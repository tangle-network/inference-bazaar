//! The lite HTTP venue surface. Thin handlers over [`Venue`]; the same ops the
//! blueprint job handlers call. Used by the `surplus-operator-lite` bin and by
//! the blueprint bin's `BackgroundService` so the market is reachable over HTTP
//! either way.

use crate::market::{RfqFillBody, RfqRequestBody, SignedOrderBody};
use crate::venue::{Venue, VenueError};
use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use std::sync::Arc;
use surplus_orderbook::Side;

pub type Shared = Arc<Venue>;

pub fn router(venue: Shared) -> Router {
    let limiter = Arc::new(crate::ratelimit::RateLimiter::from_env());
    Router::new()
        .route("/health", get(health))
        .route("/instruments", get(instruments))
        .route("/ref", post(set_ref))
        .route("/book", post(book))
        .route("/order", post(place_order))
        .route("/cancel", post(cancel_order))
        .route("/mm-tick", post(mm_tick))
        // Firm-quote market: signed orders, RFQ, settlement outbox.
        .route("/order-signed", post(place_signed))
        .route("/rfq", post(rfq_quote))
        .route("/rfq/fill", post(rfq_fill))
        // Redemption: spend a credit lot on real inference (gate G1).
        .route("/redeem", post(redeem_serve))
        .route("/redeem/receipt", post(redeem_receipt))
        .route("/settlement/outbox", get(settlement_outbox))
        .route("/settlement/flush", post(settlement_flush))
        .layer(axum::middleware::from_fn_with_state(
            limiter,
            crate::ratelimit::limit,
        ))
        .with_state(venue)
}

/// Background settlement pump: flush the outbox (and refresh the on-chain
/// funding cache that bounds quoting) every `SURPLUS_FLUSH_INTERVAL_SECS`.
/// Fills clear without any external poke; failures requeue and retry on the
/// next tick. Spawned by both the lite and the blueprint bins.
pub fn spawn_auto_flush(venue: Shared) {
    let interval = std::env::var("SURPLUS_FLUSH_INTERVAL_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|v: &u64| *v >= 5)
        .unwrap_or(30);
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(interval));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            if let Err(e) = venue.refresh_chain_cache().await {
                tracing::debug!("chain cache refresh skipped: {e}");
            }
            if venue.outbox_len() == 0 {
                continue;
            }
            match venue.flush_settlement().await {
                Ok(report) => tracing::info!(%report, "auto-flush"),
                Err(e) => tracing::warn!("auto-flush failed (requeued): {e}"),
            }
        }
    });
}

async fn redeem_serve(
    State(v): State<Shared>,
    Json(b): Json<crate::redeem::RedeemServeBody>,
) -> impl IntoResponse {
    match v.redeem_serve(b).await {
        Ok(val) => Json(val).into_response(),
        Err(e) => (err_status(&e), e.to_string()).into_response(),
    }
}

async fn redeem_receipt(
    State(v): State<Shared>,
    Json(b): Json<crate::redeem::RedeemReceiptBody>,
) -> impl IntoResponse {
    match v.redeem_receipt(b).await {
        Ok(val) => Json(val).into_response(),
        Err(e) => (err_status(&e), e.to_string()).into_response(),
    }
}

fn err_status(e: &VenueError) -> StatusCode {
    match e {
        VenueError::NotFound(_) => StatusCode::NOT_FOUND,
        VenueError::Rejected(_) => StatusCode::UNPROCESSABLE_ENTITY,
        VenueError::NoReference => StatusCode::CONFLICT,
        VenueError::Sidecar(_) => StatusCode::BAD_GATEWAY,
        VenueError::SettlementUnconfigured(_) => StatusCode::SERVICE_UNAVAILABLE,
        VenueError::Chain(_) => StatusCode::BAD_GATEWAY,
    }
}

async fn health() -> impl IntoResponse {
    Json(serde_json::json!({ "ok": true }))
}

async fn instruments(State(v): State<Shared>) -> impl IntoResponse {
    Json(v.instruments())
}

#[derive(Deserialize)]
struct SetRefBody {
    #[serde(rename = "instrumentId")]
    instrument_id: String,
    #[serde(rename = "refMid")]
    ref_mid: f64,
}

async fn set_ref(State(v): State<Shared>, Json(b): Json<SetRefBody>) -> impl IntoResponse {
    match v.set_ref(&b.instrument_id, b.ref_mid) {
        Ok(val) => Json(val).into_response(),
        Err(e) => (err_status(&e), e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct InstBody {
    #[serde(rename = "instrumentId")]
    instrument_id: String,
}

async fn book(State(v): State<Shared>, Json(b): Json<InstBody>) -> impl IntoResponse {
    match v.snapshot(&b.instrument_id) {
        Ok(val) => Json(val).into_response(),
        Err(e) => (err_status(&e), e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct PlaceOrderBody {
    #[serde(rename = "instrumentId")]
    instrument_id: String,
    side: Side,
    price: i64,
    #[serde(rename = "qtyTokens")]
    qty_tokens: i64,
    owner: String,
    #[serde(default)]
    rail: Option<String>,
}

async fn place_order(State(v): State<Shared>, Json(b): Json<PlaceOrderBody>) -> impl IntoResponse {
    let rail = b.rail.unwrap_or_else(|| "router-credits".to_string());
    match v.place(
        &b.instrument_id,
        b.side,
        b.price,
        b.qty_tokens,
        &b.owner,
        &rail,
    ) {
        Ok(val) => Json(val).into_response(),
        Err(e) => (err_status(&e), e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct CancelBody {
    #[serde(rename = "instrumentId")]
    instrument_id: String,
    #[serde(rename = "orderId")]
    order_id: String,
}

async fn cancel_order(State(v): State<Shared>, Json(b): Json<CancelBody>) -> impl IntoResponse {
    match v.cancel(&b.instrument_id, &b.order_id) {
        Ok(cancelled) => Json(serde_json::json!({ "cancelled": cancelled })).into_response(),
        Err(e) => (err_status(&e), e.to_string()).into_response(),
    }
}

async fn mm_tick(State(v): State<Shared>, Json(b): Json<InstBody>) -> impl IntoResponse {
    match v.mm_tick(&b.instrument_id).await {
        Ok(val) => Json(val).into_response(),
        Err(e) => (err_status(&e), e.to_string()).into_response(),
    }
}

async fn place_signed(
    State(v): State<Shared>,
    Json(b): Json<SignedOrderBody>,
) -> impl IntoResponse {
    match v.place_signed(b) {
        Ok(val) => Json(val).into_response(),
        Err(e) => (err_status(&e), e.to_string()).into_response(),
    }
}

async fn rfq_quote(State(v): State<Shared>, Json(b): Json<RfqRequestBody>) -> impl IntoResponse {
    match v.rfq_quote(&b.instrument_id, b.side, b.qty_tokens).await {
        Ok(val) => Json(val).into_response(),
        Err(e) => (err_status(&e), e.to_string()).into_response(),
    }
}

async fn rfq_fill(State(v): State<Shared>, Json(b): Json<RfqFillBody>) -> impl IntoResponse {
    match v.rfq_fill(b) {
        Ok(val) => Json(val).into_response(),
        Err(e) => (err_status(&e), e.to_string()).into_response(),
    }
}

async fn settlement_outbox(State(v): State<Shared>) -> impl IntoResponse {
    Json(v.outbox_json())
}

async fn settlement_flush(State(v): State<Shared>) -> impl IntoResponse {
    match v.flush_settlement().await {
        Ok(val) => Json(val).into_response(),
        Err(e) => (err_status(&e), e.to_string()).into_response(),
    }
}
