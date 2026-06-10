//! Surplus operator (lite).
//!
//! The market-maker operator without the Tangle substrate: it holds reference
//! prices and inventory, delegates quoting to the mm-sidecar, enforces the
//! sidecar's risk verdict, fills buyer orders against its live quotes, and emits
//! a settlement intent (the actual money movement is the settlement layer's job
//! — router credits or on-chain shielded). This is the product loop, runnable in
//! local e2e before the on-chain registration lands.

mod config;
mod sidecar;

use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use config::OperatorConfig;
use serde::{Deserialize, Serialize};
use sidecar::SidecarClient;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct InstrumentState {
    /// Reference mid from the router feed, micro-tsUSD per 1M tokens.
    ref_mid: f64,
    /// Signed inventory, tokens.
    inventory_tokens: f64,
    /// Session drawdown from peak, micro-tsUSD.
    drawdown_micro: f64,
}

struct AppState {
    cfg: OperatorConfig,
    sidecar: SidecarClient,
    book: Mutex<HashMap<String, InstrumentState>>,
}

type Shared = Arc<AppState>;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let cfg = OperatorConfig::from_env();
    let sidecar = SidecarClient::new(cfg.sidecar_url.clone());
    let mut book = HashMap::new();
    for inst in &cfg.instruments {
        book.insert(inst.id.clone(), InstrumentState::default());
    }
    let state: Shared = Arc::new(AppState {
        cfg,
        sidecar,
        book: Mutex::new(book),
    });

    let app = Router::new()
        .route("/health", get(health))
        .route("/instruments", get(instruments))
        .route("/ref", post(set_ref))
        .route("/quote", post(quote))
        .route("/buy", post(buy))
        .with_state(state);

    let addr = std::env::var("SURPLUS_OPERATOR_ADDR").unwrap_or_else(|_| "127.0.0.1:9100".into());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("surplus operator-lite listening on http://{addr}");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health() -> impl IntoResponse {
    Json(serde_json::json!({ "ok": true }))
}

async fn instruments(State(s): State<Shared>) -> impl IntoResponse {
    Json(s.cfg.instruments.clone())
}

#[derive(Deserialize)]
struct SetRefBody {
    #[serde(rename = "instrumentId")]
    instrument_id: String,
    #[serde(rename = "refMid")]
    ref_mid: f64,
}

/// Push a reference price (in a full build this is driven by the router feed).
async fn set_ref(State(s): State<Shared>, Json(body): Json<SetRefBody>) -> impl IntoResponse {
    let mut book = s.book.lock().unwrap();
    let Some(st) = book.get_mut(&body.instrument_id) else {
        return (StatusCode::NOT_FOUND, "unknown instrument").into_response();
    };
    st.ref_mid = body.ref_mid;
    Json(serde_json::json!({ "ok": true, "refMid": body.ref_mid })).into_response()
}

#[derive(Deserialize)]
struct QuoteBody {
    #[serde(rename = "instrumentId")]
    instrument_id: String,
}

/// Current risk-gated quotes for an instrument (operator → sidecar → verdict).
async fn quote(State(s): State<Shared>, Json(body): Json<QuoteBody>) -> impl IntoResponse {
    let (ref_mid, inventory, drawdown) = {
        let book = s.book.lock().unwrap();
        match book.get(&body.instrument_id) {
            Some(st) => (st.ref_mid, st.inventory_tokens, st.drawdown_micro),
            None => return (StatusCode::NOT_FOUND, "unknown instrument").into_response(),
        }
    };
    match s
        .sidecar
        .quote(&s.cfg, &body.instrument_id, ref_mid, inventory, drawdown)
        .await
    {
        Ok(q) => Json(q).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, format!("sidecar error: {e}")).into_response(),
    }
}

#[derive(Deserialize)]
struct BuyBody {
    #[serde(rename = "instrumentId")]
    instrument_id: String,
    /// Buyer side: "buy" lifts the operator's ask; "sell" hits the bid.
    side: String,
    #[serde(rename = "qtyTokens")]
    qty_tokens: f64,
}

#[derive(Serialize)]
struct Fill {
    #[serde(rename = "instrumentId")]
    instrument_id: String,
    price: f64,
    #[serde(rename = "qtyTokens")]
    qty_tokens: f64,
    /// Notional the settlement layer should move, micro-tsUSD.
    #[serde(rename = "notionalMicro")]
    notional_micro: i64,
    side: String,
}

/// A buyer trades against the operator's current quote. The operator re-quotes
/// (risk-gated), checks the side is offered, fills at the quote price, updates
/// inventory, and returns a fill for the settlement layer to clear.
async fn buy(State(s): State<Shared>, Json(body): Json<BuyBody>) -> impl IntoResponse {
    let (ref_mid, inventory, drawdown) = {
        let book = s.book.lock().unwrap();
        match book.get(&body.instrument_id) {
            Some(st) => (st.ref_mid, st.inventory_tokens, st.drawdown_micro),
            None => return (StatusCode::NOT_FOUND, "unknown instrument").into_response(),
        }
    };
    let q = match s
        .sidecar
        .quote(&s.cfg, &body.instrument_id, ref_mid, inventory, drawdown)
        .await
    {
        Ok(q) => q,
        Err(e) => return (StatusCode::BAD_GATEWAY, format!("sidecar error: {e}")).into_response(),
    };
    if !q.valid {
        return (StatusCode::CONFLICT, Json(serde_json::json!({
            "error": "operator not quoting (risk gate)",
            "reasons": q.reasons,
            "killSwitch": q.kill_switch,
        }))).into_response();
    }
    // Buyer "buy" lifts our ask; buyer "sell" hits our bid.
    let (price, signed_delta) = match body.side.as_str() {
        "buy" => match q.ask {
            Some(a) => (a.price, -body.qty_tokens), // we sell tokens → inventory down
            None => return (StatusCode::CONFLICT, "no ask offered").into_response(),
        },
        "sell" => match q.bid {
            Some(b) => (b.price, body.qty_tokens), // we buy tokens → inventory up
            None => return (StatusCode::CONFLICT, "no bid offered").into_response(),
        },
        other => return (StatusCode::BAD_REQUEST, format!("bad side: {other}")).into_response(),
    };

    let notional_micro = ((price * body.qty_tokens) / 1_000_000.0).round() as i64;
    {
        let mut book = s.book.lock().unwrap();
        if let Some(st) = book.get_mut(&body.instrument_id) {
            st.inventory_tokens += signed_delta;
        }
    }
    Json(Fill {
        instrument_id: body.instrument_id,
        price,
        qty_tokens: body.qty_tokens,
        notional_micro,
        side: body.side,
    })
    .into_response()
}
