//! `surplus-operator` — the full on-chain blueprint.
//!
//! The venue (open orderbook + sidecar quoting + settlement) runs INSIDE the
//! Tangle `BlueprintRunner`: it starts as a [`BackgroundService`], and on-chain
//! jobs drive it. `workflow_tick` (job 30) is the main thing triggered by the
//! runner — it runs a market-making tick; `list_instrument` (0) and `status`
//! (4) round out the lifecycle. Mirrors the llm-inference-blueprint operator.

use std::sync::{Arc, OnceLock};

use alloy_sol_types::{sol, SolValue};
use blueprint_sdk::contexts::tangle::TangleClientContext;
use blueprint_sdk::macros::debug_job;
use blueprint_sdk::router::Router;
use blueprint_sdk::runner::config::BlueprintEnvironment;
use blueprint_sdk::runner::error::RunnerError;
use blueprint_sdk::runner::tangle::config::TangleConfig;
use blueprint_sdk::runner::{BackgroundService, BlueprintRunner};
use blueprint_sdk::tangle::extract::{TangleArg, TangleResult};
use blueprint_sdk::tangle::layers::TangleLayer;
use blueprint_sdk::tangle::{TangleConsumer, TangleProducer};
use blueprint_sdk::Job;
use tokio::sync::oneshot;

use surplus_operator::config::Instrument;
use surplus_operator::{http, Venue};

// --- Job IDs (mirror blueprint.toml) ---
pub const LIST_INSTRUMENT_JOB: u8 = 0;
pub const STATUS_JOB: u8 = 4;
pub const WORKFLOW_TICK_JOB: u8 = 30;
/// Compact-definition deployments (live chains, where 25 reserved filler jobs
/// would cost real storage gas) place workflow_tick at positional index 5.
/// Both indices route to the same handler.
pub const WORKFLOW_TICK_JOB_COMPACT: u8 = 5;

// --- ABI types for on-chain job encoding ---
sol! {
    #[derive(Debug, serde::Serialize, serde::Deserialize)]
    struct ListInstrumentRequest {
        string instrumentId;
        string modelId;
        string tokenKind;
        int64 tickSize;
        int64 minQty;
    }

    #[derive(Debug, serde::Serialize, serde::Deserialize)]
    struct Ack {
        bool ok;
        string instrumentId;
    }

    #[derive(Debug, serde::Serialize, serde::Deserialize)]
    struct WorkflowTickRequest {
        string instrumentId;
    }

    #[derive(Debug, serde::Serialize, serde::Deserialize)]
    struct WorkflowTickResult {
        bool quoting;
        int64 inventoryTokens;
        string rationale;
    }

    #[derive(Debug, serde::Serialize, serde::Deserialize)]
    struct StatusResult {
        string json;
    }
}

/// Shared venue, set by the background service so on-chain job handlers reach it
/// (mirrors llm-inference's `VLLM_ENDPOINT` OnceLock).
static VENUE: OnceLock<Arc<Venue>> = OnceLock::new();

fn venue() -> Result<&'static Arc<Venue>, RunnerError> {
    VENUE
        .get()
        .ok_or_else(|| RunnerError::Other("venue not started".into()))
}

// --- Job handlers ---

/// List a (model, tokenKind) credit market (job 0).
#[debug_job]
pub async fn list_instrument(
    TangleArg(req): TangleArg<ListInstrumentRequest>,
) -> Result<TangleResult<Ack>, RunnerError> {
    let v = venue()?;
    let inst = Instrument {
        id: req.instrumentId.clone(),
        model_id: req.modelId,
        token_kind: req.tokenKind,
        tick_size: req.tickSize,
        min_qty: req.minQty,
    };
    v.register_instrument(inst.clone());
    persist_instrument(&inst);
    Ok(TangleResult(Ack {
        ok: true,
        instrumentId: req.instrumentId,
    }))
}

// --- Instrument persistence ---------------------------------------------------
//
// On-chain `list_instrument` calls are processed once (the consumer submits a
// result, so they never replay). The venue book is in-memory, so a restart
// would silently drop every listed market. Listings are therefore journaled
// to `$DATA_DIR/instruments.json` and re-registered on boot.

fn instruments_path() -> Option<std::path::PathBuf> {
    std::env::var("DATA_DIR")
        .ok()
        .map(|d| std::path::Path::new(&d).join("instruments.json"))
}

/// Serializes concurrent job handlers — read-modify-write on the journal file
/// would otherwise lose listings when a burst of jobs lands in one block.
static PERSIST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn persist_instrument(inst: &Instrument) {
    let Some(path) = instruments_path() else {
        return;
    };
    let _guard = PERSIST_LOCK.lock().unwrap();
    let mut all = load_instruments();
    all.retain(|i| i.id != inst.id);
    all.push(inst.clone());
    if let Ok(json) = serde_json::to_vec_pretty(&all) {
        if let Err(e) = std::fs::write(&path, json) {
            tracing::warn!("failed to persist instruments: {e}");
        }
    }
}

fn load_instruments() -> Vec<Instrument> {
    let Some(path) = instruments_path() else {
        return Vec::new();
    };
    std::fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// Operator status (job 4).
#[debug_job]
pub async fn status() -> Result<TangleResult<StatusResult>, RunnerError> {
    let v = venue()?;
    Ok(TangleResult(StatusResult {
        json: v.status().to_string(),
    }))
}

/// The main thing the runner triggers: one market-making tick (job 30). Pulls
/// risk-gated quotes from the sidecar and (cancel-)places the operator's quotes.
#[debug_job]
pub async fn workflow_tick(
    TangleArg(req): TangleArg<WorkflowTickRequest>,
) -> Result<TangleResult<WorkflowTickResult>, RunnerError> {
    let v = venue()?;
    let report = v
        .mm_tick(&req.instrumentId)
        .await
        .map_err(|e| RunnerError::Other(e.to_string().into()))?;
    Ok(TangleResult(WorkflowTickResult {
        quoting: report
            .get("quoting")
            .and_then(|x| x.as_bool())
            .unwrap_or(false),
        inventoryTokens: report
            .get("inventoryTokens")
            .and_then(|x| x.as_i64())
            .unwrap_or(0),
        rationale: report
            .get("rationale")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
    }))
}

pub fn router() -> Router {
    Router::new()
        .route(LIST_INSTRUMENT_JOB, list_instrument.layer(TangleLayer))
        .route(STATUS_JOB, status.layer(TangleLayer))
        .route(WORKFLOW_TICK_JOB, workflow_tick.layer(TangleLayer))
        .route(WORKFLOW_TICK_JOB_COMPACT, workflow_tick.layer(TangleLayer))
}

// --- Background service: the venue HTTP server ---

#[derive(Clone)]
struct MarketVenueService {
    venue: Arc<Venue>,
    addr: String,
}

impl BackgroundService for MarketVenueService {
    async fn start(&self) -> Result<oneshot::Receiver<Result<(), RunnerError>>, RunnerError> {
        let (tx, rx) = oneshot::channel();
        // Publish the venue so job handlers can reach it.
        surplus_operator::metrics::init();
        let _ = VENUE.set(self.venue.clone());
        http::spawn_auto_flush(self.venue.clone());
        let mut app = http::router(self.venue.clone());
        // Shared CLOB (opt-in via SURPLUS_CLOB_OPERATORS): gossip + epoch
        // consensus. Transport: PKI mesh when built with `mesh` and
        // SURPLUS_MESH_ADDR is set, else the HTTP peer list.
        match surplus_operator::clob::start_from_env(self.venue.clone()) {
            Ok(Some((_clob, clob_router))) => {
                app = app.merge(clob_router);
                tracing::info!("shared CLOB epoch service enabled");
            }
            Ok(None) => {}
            // Fail closed: a node that boots green while silently not
            // participating in consensus also stalls every peer that needs its
            // co-signature for quorum. Refusing to start is the kind option.
            Err(e) => {
                return Err(RunnerError::Other(
                    format!("shared CLOB misconfigured: {e}").into(),
                ));
            }
        }
        // Spend-key rail: lots consumed as plain bearer API keys (OpenAI surface).
        let spend = Arc::new(surplus_operator::spend::SpendSvc::new(self.venue.clone()));
        surplus_operator::spend::spawn_spend_flush(spend.clone());
        app = app.merge(surplus_operator::spend::router(spend));
        // Rate limiting wraps the MERGED app — `merge` does not propagate layers.
        let app = http::rate_limited(app);
        let addr = self.addr.clone();
        tokio::spawn(async move {
            match tokio::net::TcpListener::bind(&addr).await {
                Ok(listener) => {
                    tracing::info!("surplus venue (blueprint background) on http://{addr}");
                    if let Err(e) = axum::serve(listener, app).await {
                        let _ = tx.send(Err(RunnerError::Other(e.to_string().into())));
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(RunnerError::Other(e.to_string().into())));
                }
            }
        });
        Ok(rx)
    }
}

fn setup_log() {
    use tracing_subscriber::{fmt, EnvFilter};
    fmt().with_env_filter(EnvFilter::from_default_env()).init();
}

/// ABI-encoded registration payload: the operator's primary instrument + venue
/// endpoint, for the blueprint's on-chain `onRegister`.
fn registration_payload(venue: &Venue, endpoint: &str) -> Vec<u8> {
    let inst = venue
        .cfg
        .instruments
        .first()
        .cloned()
        .unwrap_or(Instrument {
            id: String::new(),
            model_id: String::new(),
            token_kind: String::new(),
            tick_size: 0,
            min_qty: 0,
        });
    (
        inst.id,
        inst.model_id,
        inst.token_kind,
        endpoint.to_string(),
    )
        .abi_encode()
}

#[tokio::main]
#[allow(clippy::result_large_err)]
async fn main() -> Result<(), blueprint_sdk::Error> {
    setup_log();

    let venue = Arc::new(Venue::from_env());
    // Restore on-chain listings journaled by previous runs (see persist_instrument).
    for inst in load_instruments() {
        venue.register_instrument(inst);
    }
    let addr = std::env::var("SURPLUS_OPERATOR_ADDR").unwrap_or_else(|_| "127.0.0.1:9100".into());

    let env = BlueprintEnvironment::load()?;

    if env.registration_mode() {
        let payload = registration_payload(&venue, &format!("http://{addr}"));
        let output_path = env.registration_output_path();
        if let Some(parent) = output_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| blueprint_sdk::Error::Other(e.to_string()))?;
        }
        std::fs::write(&output_path, &payload)
            .map_err(|e| blueprint_sdk::Error::Other(e.to_string()))?;
        tracing::info!(path = %output_path.display(), "registration payload saved");
        return Ok(());
    }

    let tangle_client = env
        .tangle_client()
        .await
        .map_err(|e| blueprint_sdk::Error::Other(e.to_string()))?;

    let service_id = env
        .protocol_settings
        .tangle()
        .map_err(|e| blueprint_sdk::Error::Other(e.to_string()))?
        .service_id
        .ok_or_else(|| blueprint_sdk::Error::Other("No service ID configured".to_string()))?;

    let producer = TangleProducer::new(tangle_client.clone(), service_id);
    let consumer = TangleConsumer::new(tangle_client.clone());
    let service = MarketVenueService {
        venue: venue.clone(),
        addr,
    };

    BlueprintRunner::builder(TangleConfig::default(), env)
        .router(router())
        .producer(producer)
        .consumer(consumer)
        .background_service(service)
        .run()
        .await?;

    Ok(())
}
