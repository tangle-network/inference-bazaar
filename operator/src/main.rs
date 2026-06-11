//! Surplus operator (lite).
//!
//! The market-maker operator without the Tangle substrate. It hosts the
//! authoritative OPEN ORDERBOOK per instrument (off-chain matching, the SOTA
//! hybrid), delegates quoting to the mm-sidecar, posts the sidecar's quotes as
//! resting orders, matches buyer/seller flow, tracks inventory from fills, and
//! emits settlement intents (cleared by the settlement layer — router credits or
//! on-chain shielded, per order). Runnable in local e2e before the on-chain
//! registration (`--features blueprint`) lands.

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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use surplus_orderbook::{Fill, MatchingEngine, NativeBook, Order, Side};

/// The operator's own market-making orders carry this owner so it can
/// cancel-replace them each tick and attribute fills to its inventory.
const MM_OWNER: &str = "operator-mm";

struct InstrumentVenue {
    book: NativeBook,
    /// Reference mid from the router feed, micro-tsUSD per 1M tokens.
    ref_mid: f64,
    /// Operator's signed inventory, tokens.
    inventory_tokens: i64,
    /// Session drawdown from peak, micro-tsUSD.
    drawdown_micro: f64,
}

struct AppState {
    cfg: OperatorConfig,
    sidecar: SidecarClient,
    venues: Mutex<HashMap<String, InstrumentVenue>>,
    seq: AtomicU64,
}

type Shared = Arc<AppState>;

impl AppState {
    fn next_id(&self, prefix: &str) -> String {
        format!("{prefix}-{}", self.seq.fetch_add(1, Ordering::Relaxed))
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let cfg = OperatorConfig::from_env();
    let sidecar = SidecarClient::new(cfg.sidecar_url.clone());
    let mut venues = HashMap::new();
    for inst in &cfg.instruments {
        venues.insert(
            inst.id.clone(),
            InstrumentVenue {
                book: NativeBook::new(inst.id.clone(), inst.tick_size, inst.min_qty),
                ref_mid: 0.0,
                inventory_tokens: 0,
                drawdown_micro: 0.0,
            },
        );
    }
    let state: Shared = Arc::new(AppState {
        cfg,
        sidecar,
        venues: Mutex::new(venues),
        seq: AtomicU64::new(1),
    });

    let app = Router::new()
        .route("/health", get(health))
        .route("/instruments", get(instruments))
        .route("/ref", post(set_ref))
        .route("/book", post(book))
        .route("/order", post(place_order))
        .route("/cancel", post(cancel_order))
        .route("/mm-tick", post(mm_tick))
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

async fn set_ref(State(s): State<Shared>, Json(b): Json<SetRefBody>) -> impl IntoResponse {
    let mut venues = s.venues.lock().unwrap();
    let Some(v) = venues.get_mut(&b.instrument_id) else {
        return (StatusCode::NOT_FOUND, "unknown instrument").into_response();
    };
    v.ref_mid = b.ref_mid;
    Json(serde_json::json!({ "ok": true, "refMid": b.ref_mid })).into_response()
}

#[derive(Deserialize)]
struct BookBody {
    #[serde(rename = "instrumentId")]
    instrument_id: String,
}

async fn book(State(s): State<Shared>, Json(b): Json<BookBody>) -> impl IntoResponse {
    let venues = s.venues.lock().unwrap();
    match venues.get(&b.instrument_id) {
        Some(v) => Json(serde_json::json!({
            "book": v.book.snapshot(10),
            "refMid": v.ref_mid,
            "inventoryTokens": v.inventory_tokens,
        }))
        .into_response(),
        None => (StatusCode::NOT_FOUND, "unknown instrument").into_response(),
    }
}

/// A settlement intent per fill — what the settlement layer clears, on whichever
/// rail the order named (default router-credits).
#[derive(Serialize)]
struct SettlementIntent {
    #[serde(rename = "orderId")]
    order_id: String,
    rail: String,
    buyer: String,
    operator: String,
    #[serde(rename = "qtyTokens")]
    qty_tokens: i64,
    price: i64,
    #[serde(rename = "notionalMicro")]
    notional_micro: i64,
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
    /// Settlement rail this trade clears on. Default "router-credits".
    #[serde(default)]
    rail: Option<String>,
}

async fn place_order(State(s): State<Shared>, Json(b): Json<PlaceOrderBody>) -> impl IntoResponse {
    let id = s.next_id("ord");
    let rail = b.rail.unwrap_or_else(|| "router-credits".to_string());
    let order = Order {
        id: id.clone(),
        instrument_id: b.instrument_id.clone(),
        side: b.side,
        price: b.price,
        qty: b.qty_tokens,
        owner: b.owner.clone(),
        ts: s.seq.fetch_add(1, Ordering::Relaxed) as i64,
    };
    let mut venues = s.venues.lock().unwrap();
    let Some(v) = venues.get_mut(&b.instrument_id) else {
        return (StatusCode::NOT_FOUND, "unknown instrument").into_response();
    };
    match v.book.place(order) {
        Ok(out) => {
            apply_inventory(v, &out.fills);
            let settlements = settlement_intents(&out.fills, &rail);
            Json(serde_json::json!({
                "orderId": id,
                "fills": out.fills,
                "resting": out.resting,
                "settlements": settlements,
                "inventoryTokens": v.inventory_tokens,
            }))
            .into_response()
        }
        Err(e) => (StatusCode::UNPROCESSABLE_ENTITY, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct CancelBody {
    #[serde(rename = "instrumentId")]
    instrument_id: String,
    #[serde(rename = "orderId")]
    order_id: String,
}

async fn cancel_order(State(s): State<Shared>, Json(b): Json<CancelBody>) -> impl IntoResponse {
    let mut venues = s.venues.lock().unwrap();
    let Some(v) = venues.get_mut(&b.instrument_id) else {
        return (StatusCode::NOT_FOUND, "unknown instrument").into_response();
    };
    Json(serde_json::json!({ "cancelled": v.book.cancel(&b.order_id) })).into_response()
}

#[derive(Deserialize)]
struct MmTickBody {
    #[serde(rename = "instrumentId")]
    instrument_id: String,
}

/// One market-making tick: pull risk-gated quotes from the sidecar for the
/// current inventory + reference, cancel the operator's stale quotes, and post
/// the new bid/ask as resting orders. The sidecar's verdict — not the operator —
/// is the safety boundary: a `valid:false` verdict pulls quotes and places none.
async fn mm_tick(State(s): State<Shared>, Json(b): Json<MmTickBody>) -> impl IntoResponse {
    let (ref_mid, inventory, drawdown) = {
        let venues = s.venues.lock().unwrap();
        match venues.get(&b.instrument_id) {
            Some(v) => (v.ref_mid, v.inventory_tokens, v.drawdown_micro),
            None => return (StatusCode::NOT_FOUND, "unknown instrument").into_response(),
        }
    };
    if ref_mid <= 0.0 {
        return (StatusCode::CONFLICT, "no reference price set").into_response();
    }
    let quote = match s
        .sidecar
        .quote(&s.cfg, &b.instrument_id, ref_mid, inventory as f64, drawdown)
        .await
    {
        Ok(q) => q,
        Err(e) => return (StatusCode::BAD_GATEWAY, format!("sidecar error: {e}")).into_response(),
    };

    let mut venues = s.venues.lock().unwrap();
    let Some(v) = venues.get_mut(&b.instrument_id) else {
        return (StatusCode::NOT_FOUND, "unknown instrument").into_response();
    };
    // Cancel-replace: pull our existing quotes first.
    for o in v.book.open_orders(MM_OWNER) {
        v.book.cancel(&o.id);
    }
    if !quote.valid {
        return Json(serde_json::json!({
            "quoting": false,
            "reasons": quote.reasons,
            "killSwitch": quote.kill_switch,
        }))
        .into_response();
    }

    let mut placed = Vec::new();
    let mut all_fills: Vec<Fill> = Vec::new();
    for (side, q) in [(Side::Buy, &quote.bid), (Side::Sell, &quote.ask)] {
        let Some(q) = q else { continue };
        let order = Order {
            id: s.next_id("mm"),
            instrument_id: b.instrument_id.clone(),
            side,
            price: q.price.round() as i64,
            qty: q.qty.round() as i64,
            owner: MM_OWNER.to_string(),
            ts: s.seq.fetch_add(1, Ordering::Relaxed) as i64,
        };
        match v.book.place(order.clone()) {
            Ok(out) => {
                all_fills.extend(out.fills.iter().cloned());
                placed.push(serde_json::json!({
                    "side": side, "price": order.price, "qty": order.qty,
                    "resting": out.resting.is_some(),
                }));
            }
            Err(e) => {
                return (StatusCode::UNPROCESSABLE_ENTITY, e.to_string()).into_response();
            }
        }
    }
    apply_inventory(v, &all_fills);
    Json(serde_json::json!({
        "quoting": true,
        "placed": placed,
        "fills": all_fills,
        "rationale": quote.rationale,
        "inventoryTokens": v.inventory_tokens,
    }))
    .into_response()
}

/// Adjust the operator's inventory for every fill it was a party to. When the MM
/// is maker, its side is the opposite of the taker's; when taker, the same.
fn apply_inventory(v: &mut InstrumentVenue, fills: &[Fill]) {
    for f in fills {
        let mm_side = if f.maker_owner == MM_OWNER {
            Some(f.taker_side.opposite())
        } else if f.taker_owner == MM_OWNER {
            Some(f.taker_side)
        } else {
            None
        };
        if let Some(side) = mm_side {
            v.inventory_tokens += if side == Side::Buy { f.qty } else { -f.qty };
        }
    }
}

/// Build a settlement intent for each fill where a real buyer traded (i.e. not
/// an internal MM-vs-MM print). The buyer is the non-MM counterparty.
fn settlement_intents(fills: &[Fill], rail: &str) -> Vec<SettlementIntent> {
    fills
        .iter()
        .filter_map(|f| {
            let (buyer, operator) = if f.taker_owner != MM_OWNER && f.maker_owner == MM_OWNER {
                (f.taker_owner.clone(), f.maker_owner.clone())
            } else if f.maker_owner != MM_OWNER && f.taker_owner == MM_OWNER {
                (f.maker_owner.clone(), f.taker_owner.clone())
            } else if f.maker_owner != MM_OWNER && f.taker_owner != MM_OWNER {
                // seller <-> buyer direct (operator is just the venue)
                (f.taker_owner.clone(), f.maker_owner.clone())
            } else {
                return None; // MM vs MM — nothing to settle externally
            };
            Some(SettlementIntent {
                order_id: f.taker_order_id.clone(),
                rail: rail.to_string(),
                buyer,
                operator,
                qty_tokens: f.qty,
                price: f.price,
                notional_micro: f.notional_micro(),
            })
        })
        .collect()
}
