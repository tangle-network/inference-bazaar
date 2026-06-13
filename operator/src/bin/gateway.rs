//! `surplus-gateway` — the consumer-side spend gateway.
//!
//! An OpenAI-compatible proxy that turns a credit lot into a plain API key. It
//! holds the channel's **session key**, signs `SpendVoucher`s acknowledging the
//! cumulative tokens served, and forwards requests to the issuing operator with
//! those vouchers attached — so the developer points a vanilla OpenAI client at
//! it and never signs anything per request:
//!
//!     client = OpenAI(base_url="http://127.0.0.1:8088/v1", api_key="sk-surplus-…")
//!
//! Run it locally for ZERO trust in Surplus (you hold the session key, you depend
//! only on the chain + the operator), or host it for convenience. Over-billing is
//! impossible regardless: the operator can only settle a cumulative the session
//! key signed, and that key lives here.
//!
//! Config (env):
//!   SURPLUS_GATEWAY_LISTEN   default 127.0.0.1:8088
//!   SURPLUS_OPERATOR_URL     issuing operator base URL (https://… or http://…onion via a Tor proxy)
//!   SURPLUS_SESSION_KEY      session private key, 0x-hex (the gateway's signing key)
//!   SURPLUS_LOT_ID           the credit lot, 0x-hex bytes32
//!   SURPLUS_CHAIN_ID         EIP-712 domain chain id
//!   SURPLUS_SETTLEMENT_ADDR  settlement contract (the voucher domain's verifyingContract)

use std::sync::{Arc, Mutex};

use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use surplus_operator::spend::spend_voucher_digest;
use surplus_settlement::core::alloy_primitives::{Address, B256, U256};
use surplus_settlement::core::hex;
use surplus_settlement::Signer;

struct Gateway {
    operator_url: String,
    signer: Signer,
    session: Address,
    lot_id: B256,
    chain_id: U256,
    settlement: Address,
    client: reqwest::Client,
    /// Cumulative tokens this gateway has acknowledged (signed a voucher for).
    acked: Mutex<u64>,
}

impl Gateway {
    /// Sign a voucher for `cumulative` tokens.
    fn voucher_sig(&self, cumulative: u64) -> String {
        let digest = spend_voucher_digest(
            self.chain_id,
            self.settlement,
            self.lot_id,
            self.session,
            cumulative,
        );
        format!("0x{}", hex::encode(self.signer.sign_digest(digest)))
    }

    /// Post a trailing voucher for `cumulative` to the operator's ack endpoint so
    /// the just-served request becomes settleable. Best-effort by design.
    async fn send_ack(&self, cumulative: u64) {
        let sig = self.voucher_sig(cumulative);
        let r = self
            .client
            .post(format!("{}/v1/spend/ack", self.operator_url))
            .header("x-surplus-session", format!("{:#x}", self.session))
            .header("x-surplus-voucher-cum", cumulative.to_string())
            .header("x-surplus-voucher-sig", sig)
            .send()
            .await;
        if let Err(e) = r {
            tracing::warn!("trailing ack failed (next request will catch up): {e}");
        }
    }
}

type Shared = Arc<Gateway>;

async fn chat(State(g): State<Shared>, Json(body): Json<Value>) -> impl IntoResponse {
    // The voucher we present covers everything acknowledged so far (= what the
    // operator has already metered as served). The operator serves this request
    // trusting we will advance the voucher to cover it on the next call.
    let acked = *g.acked.lock().unwrap();
    let sig = g.voucher_sig(acked);

    let resp = g
        .client
        .post(format!("{}/v1/chat/completions", g.operator_url))
        .header("x-surplus-session", format!("{:#x}", g.session))
        .header("x-surplus-voucher-cum", acked.to_string())
        .header("x-surplus-voucher-sig", sig)
        .json(&body)
        .send()
        .await;
    let resp = match resp {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(err("upstream", &e.to_string())),
            )
                .into_response();
        }
    };
    let status = resp.status();
    let mut completion: Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(err("upstream_body", &e.to_string())),
            )
                .into_response()
        }
    };
    if !status.is_success() {
        let code = StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        return (code, Json(completion)).into_response();
    }

    // Advance our acknowledgement to cover what was just served, then send a
    // trailing voucher so THIS request is settleable immediately — without it the
    // operator could only ever settle through the previous request and would serve
    // our last one for free. Best-effort: if the ack fails, the next chat request's
    // voucher header carries the same cumulative, so settlement still catches up.
    let advanced = match completion
        .get("surplus")
        .and_then(|s| s.get("nextCumulative"))
        .and_then(Value::as_u64)
    {
        Some(next) => {
            let mut a = g.acked.lock().unwrap();
            if next > *a {
                *a = next;
                Some(next)
            } else {
                None
            }
        }
        None => None,
    };
    if let Some(next) = advanced {
        g.send_ack(next).await;
    }
    if let Some(obj) = completion.as_object_mut() {
        obj.remove("surplus");
    }
    Json(completion).into_response()
}

async fn models(State(g): State<Shared>) -> impl IntoResponse {
    match g
        .client
        .get(format!("{}/v1/models", g.operator_url))
        .send()
        .await
    {
        Ok(r) => match r.json::<Value>().await {
            Ok(v) => Json(v).into_response(),
            Err(e) => (
                StatusCode::BAD_GATEWAY,
                Json(err("upstream_body", &e.to_string())),
            )
                .into_response(),
        },
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(err("upstream", &e.to_string())),
        )
            .into_response(),
    }
}

fn err(code: &str, message: &str) -> Value {
    json!({ "error": { "type": code, "code": code, "message": message } })
}

fn env(key: &str) -> anyhow::Result<String> {
    std::env::var(key).map_err(|_| anyhow::anyhow!("missing required env {key}"))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "info".into()))
        .init();

    let listen =
        std::env::var("SURPLUS_GATEWAY_LISTEN").unwrap_or_else(|_| "127.0.0.1:8088".into());
    let gateway = Arc::new(Gateway {
        operator_url: env("SURPLUS_OPERATOR_URL")?
            .trim_end_matches('/')
            .to_string(),
        signer: Signer::from_hex(&env("SURPLUS_SESSION_KEY")?)
            .map_err(|e| anyhow::anyhow!("SURPLUS_SESSION_KEY: {e}"))?,
        session: Signer::from_hex(&env("SURPLUS_SESSION_KEY")?)
            .unwrap()
            .address(),
        lot_id: env("SURPLUS_LOT_ID")?
            .parse()
            .map_err(|_| anyhow::anyhow!("SURPLUS_LOT_ID not bytes32"))?,
        chain_id: U256::from(env("SURPLUS_CHAIN_ID")?.parse::<u64>()?),
        settlement: env("SURPLUS_SETTLEMENT_ADDR")?
            .parse()
            .map_err(|_| anyhow::anyhow!("bad SURPLUS_SETTLEMENT_ADDR"))?,
        client: reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(300))
            .build()?,
        acked: Mutex::new(0),
    });
    tracing::info!(
        %listen, operator = %gateway.operator_url, session = %format!("{:#x}", gateway.session),
        "surplus-gateway up — point any OpenAI client at http://{listen}/v1"
    );

    let app = Router::new()
        .route("/v1/chat/completions", post(chat))
        .route("/v1/models", get(models))
        .with_state(gateway);
    let listener = tokio::net::TcpListener::bind(&listen).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
