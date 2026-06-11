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
    v.register_instrument(Instrument {
        id: req.instrumentId.clone(),
        model_id: req.modelId,
        token_kind: req.tokenKind,
        tick_size: req.tickSize,
        min_qty: req.minQty,
    });
    Ok(TangleResult(Ack {
        ok: true,
        instrumentId: req.instrumentId,
    }))
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
        quoting: report.get("quoting").and_then(|x| x.as_bool()).unwrap_or(false),
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
        let _ = VENUE.set(self.venue.clone());
        let app = http::router(self.venue.clone());
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
