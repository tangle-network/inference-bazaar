//! `surplus-gateway` — the consumer-side spend gateway, now **multi-lot**.
//!
//! An OpenAI-compatible proxy that turns a *wallet of credit lots* into one plain
//! API key. The developer points a vanilla OpenAI client at it; the gateway holds
//! a **session key per lot** and, per request, routes to a lot whose issuer serves
//! the requested model, has quota left, is unexpired, and is reachable — signing
//! that lot's `SpendVoucher` invisibly and failing over to the next lot if one is
//! drained or its operator is down. So a long agentic run drains all your lots
//! seamlessly:
//!
//!     client = OpenAI(base_url="http://127.0.0.1:8088/v1", api_key="sk-surplus")
//!
//! Over-billing stays impossible: each operator can only settle a cumulative the
//! lot's session key signed, and those keys live here. Per-request billing is also
//! bounded to the request's own max_tokens (`capped_next`).
//!
//! Config — EITHER a multi-lot file OR single-lot env (back-compat):
//!   SURPLUS_GATEWAY_CONFIG   path to a JSON array of channels:
//!        [{ "lotId":"0x..","sessionKey":"0x..","operatorUrl":"http..",
//!           "model":"anthropic/…:output"?, "maxTokens":N?, "expiry":unixSecs? }]
//!   SURPLUS_OPERATOR_URL / SURPLUS_SESSION_KEY / SURPLUS_LOT_ID   one channel
//!   SURPLUS_CHAIN_ID / SURPLUS_SETTLEMENT_ADDR   the voucher EIP-712 domain
//!   SURPLUS_GATEWAY_LISTEN   default 127.0.0.1:8088

use std::sync::{Arc, Mutex};

use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use surplus_operator::spend::spend_voucher_digest;
use surplus_settlement::core::alloy_primitives::{Address, B256, U256};
use surplus_settlement::core::hex;
use surplus_settlement::Signer;

/// Never route to a lot within this margin of its expiry — settlement must still
/// land before the lot expires.
const EXPIRY_MARGIN_SECS: u64 = 120;
/// Fallback per-request bound when a request omits max_tokens — the operator's own
/// hard per-request cap, so an honest serve is never under-acked while an inflated
/// claim is still bounded.
const GATEWAY_DEFAULT_MAX_TOKENS: u64 = 8192;

/// One spend channel = one credit lot at its issuing operator.
struct Channel {
    lot_id: B256,
    signer: Signer,
    session: Address,
    operator_url: String,
    /// The model this lot serves; `None` routes any model to it.
    model: Option<String>,
    /// Lot/permit token cap; `0` = unknown (no local quota gate, operator enforces).
    max_tokens: u64,
    /// Lot/permit expiry, unix seconds; `0` = no local expiry gate.
    expiry: u64,
    /// Cumulative tokens this gateway has acknowledged (signed a voucher for).
    acked: Mutex<u64>,
}

impl Channel {
    fn voucher_sig(&self, chain_id: U256, settlement: Address, cumulative: u64) -> String {
        let digest =
            spend_voucher_digest(chain_id, settlement, self.lot_id, self.session, cumulative);
        format!("0x{}", hex::encode(self.signer.sign_digest(digest)))
    }

    fn serves_model(&self, requested: Option<&str>) -> bool {
        match (&self.model, requested) {
            (Some(m), Some(r)) => m == r,
            _ => true, // channel serves any, or request didn't pin a model
        }
    }

    fn has_quota(&self) -> bool {
        self.max_tokens == 0 || *self.acked.lock().unwrap() < self.max_tokens
    }

    fn live(&self, now: u64) -> bool {
        self.expiry == 0 || now + EXPIRY_MARGIN_SECS < self.expiry
    }
}

struct Gateway {
    channels: Vec<Arc<Channel>>,
    chain_id: U256,
    settlement: Address,
    client: reqwest::Client,
}

type Shared = Arc<Gateway>;

impl Gateway {
    /// Eligible channels for a request's model, ordered by expiry-urgency (use
    /// soonest-expiring credit first; no-expiry lots last). The caller tries them
    /// in order, failing over on a drained/unreachable operator.
    fn route(&self, model: Option<&str>, now: u64) -> Vec<Arc<Channel>> {
        let mut eligible: Vec<Arc<Channel>> = self
            .channels
            .iter()
            .filter(|c| c.serves_model(model) && c.has_quota() && c.live(now))
            .cloned()
            .collect();
        eligible.sort_by_key(|c| if c.expiry == 0 { u64::MAX } else { c.expiry });
        eligible
    }

    /// Buffered completion on one channel: advance + ack the voucher, strip the
    /// private surplus field, return the clean JSON.
    async fn buffered(
        self: &Shared,
        ch: &Arc<Channel>,
        resp: reqwest::Response,
        acked_at_start: u64,
        max_delta: u64,
    ) -> axum::response::Response {
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
        if let Some(next) = completion
            .get("surplus")
            .and_then(|s| s.get("nextCumulative"))
            .and_then(Value::as_u64)
        {
            let next = capped_next(acked_at_start, next, max_delta);
            let advanced = {
                let mut a = ch.acked.lock().unwrap();
                if next > *a {
                    *a = next;
                    true
                } else {
                    false
                }
            };
            if advanced {
                self.send_ack(ch, next).await;
            }
        }
        if let Some(obj) = completion.as_object_mut() {
            obj.remove("surplus");
        }
        Json(completion).into_response()
    }

    /// Pass an SSE stream from the operator through to the client token-by-token,
    /// stripping the private `surplus` event and, at stream end, advancing this
    /// channel's voucher + sending a trailing ack so the request settles.
    fn stream_through(
        self: &Shared,
        ch: Arc<Channel>,
        resp: reqwest::Response,
        acked_at_start: u64,
        max_delta: u64,
    ) -> axum::response::Response {
        use futures::StreamExt;
        let g = Arc::clone(self);
        let (tx, rx) =
            futures::channel::mpsc::unbounded::<Result<axum::body::Bytes, std::io::Error>>();
        tokio::spawn(async move {
            let mut stream = resp.bytes_stream();
            let mut pending = String::new();
            let mut next_cum: Option<u64> = None;
            while let Some(chunk) = stream.next().await {
                let Ok(bytes) = chunk else { break };
                pending.push_str(&String::from_utf8_lossy(&bytes));
                while let Some(idx) = pending.find("\n\n") {
                    let event: String = pending.drain(..idx + 2).collect();
                    let data = event
                        .lines()
                        .find_map(|l| l.strip_prefix("data:").map(str::trim));
                    if let Some(json_str) = data {
                        if json_str != "[DONE]" {
                            if let Ok(v) = serde_json::from_str::<Value>(json_str) {
                                if let Some(s) = v.get("surplus") {
                                    if let Some(n) = s.get("nextCumulative").and_then(Value::as_u64)
                                    {
                                        next_cum = Some(n);
                                    }
                                    continue; // strip — the client never sees the surplus event
                                }
                            }
                        }
                    }
                    let _ = tx.unbounded_send(Ok(event.into_bytes().into()));
                }
            }
            if let Some(n) = next_cum {
                let n = capped_next(acked_at_start, n, max_delta);
                {
                    let mut a = ch.acked.lock().unwrap();
                    if n > *a {
                        *a = n;
                    }
                }
                g.send_ack(&ch, n).await;
            }
        });
        axum::response::Response::builder()
            .header("content-type", "text/event-stream")
            .header("cache-control", "no-cache")
            .body(axum::body::Body::from_stream(rx))
            .expect("valid sse response")
    }

    /// Post a trailing voucher to the channel's operator so the just-served request
    /// becomes settleable. Best-effort by design.
    async fn send_ack(&self, ch: &Arc<Channel>, cumulative: u64) {
        let sig = ch.voucher_sig(self.chain_id, self.settlement, cumulative);
        let r = self
            .client
            .post(format!("{}/v1/spend/ack", ch.operator_url))
            .header("x-surplus-session", format!("{:#x}", ch.session))
            .header("x-surplus-voucher-cum", cumulative.to_string())
            .header("x-surplus-voucher-sig", sig)
            .send()
            .await;
        if let Err(e) = r {
            tracing::warn!("trailing ack failed (next request will catch up): {e}");
        }
    }
}

async fn chat(State(g): State<Shared>, Json(body): Json<Value>) -> impl IntoResponse {
    let streaming = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let model = body.get("model").and_then(Value::as_str);
    // Independent per-request bound: never sign a voucher advance larger than THIS
    // request's max_tokens (the developer's own cap), model-agnostic.
    let max_delta = body
        .get("max_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(GATEWAY_DEFAULT_MAX_TOKENS);

    let eligible = g.route(model, now_unix());
    if eligible.is_empty() {
        return (
            StatusCode::PAYMENT_REQUIRED,
            Json(err("no_credit", "no lot with quota serves this model")),
        )
            .into_response();
    }

    // Try each eligible lot in turn; fail over on a drained/unreachable operator,
    // so the agentic run never sees an exhausted or down lot. A genuine client
    // error (400/422) is returned as-is — it would fail on every lot identically.
    let mut last: Option<axum::response::Response> = None;
    for ch in eligible {
        let acked = *ch.acked.lock().unwrap();
        let sig = ch.voucher_sig(g.chain_id, g.settlement, acked);
        let resp = g
            .client
            .post(format!("{}/v1/chat/completions", ch.operator_url))
            .header("x-surplus-session", format!("{:#x}", ch.session))
            .header("x-surplus-voucher-cum", acked.to_string())
            .header("x-surplus-voucher-sig", sig)
            .json(&body)
            .send()
            .await;
        match resp {
            Ok(r) if r.status().is_success() => {
                return if streaming {
                    g.stream_through(ch, r, acked, max_delta)
                } else {
                    g.buffered(&ch, r, acked, max_delta).await
                };
            }
            Ok(r) => {
                let status = r.status();
                if status == StatusCode::PAYMENT_REQUIRED {
                    // This lot is out of quota — drain it locally so route() skips
                    // it, then fail over to the next.
                    if ch.max_tokens > 0 {
                        *ch.acked.lock().unwrap() = ch.max_tokens;
                    }
                }
                let code = StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
                let payload = r
                    .json::<Value>()
                    .await
                    .unwrap_or_else(|e| err("upstream_body", &e.to_string()));
                // A bad client request fails identically everywhere — return it.
                if status == StatusCode::BAD_REQUEST || status == StatusCode::UNPROCESSABLE_ENTITY {
                    return (code, Json(payload)).into_response();
                }
                last = Some((code, Json(payload)).into_response()); // else fail over
            }
            Err(e) => {
                last = Some(
                    (
                        StatusCode::BAD_GATEWAY,
                        Json(err("upstream", &e.to_string())),
                    )
                        .into_response(),
                );
            }
        }
    }
    last.unwrap_or_else(|| {
        (
            StatusCode::PAYMENT_REQUIRED,
            Json(err(
                "no_credit",
                "every eligible lot failed or is exhausted",
            )),
        )
            .into_response()
    })
}

async fn models(State(g): State<Shared>) -> impl IntoResponse {
    // Query the first channel's operator; lots typically quote the same catalog.
    let Some(ch) = g.channels.first() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(err("no_channels", "gateway has no lots")),
        )
            .into_response();
    };
    match g
        .client
        .get(format!("{}/v1/models", ch.operator_url))
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

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The cumulative this gateway will sign for, given the operator's claimed `next`:
/// never more than `acked + max_delta`, so a single request can't bill beyond the
/// developer's own max_tokens regardless of what the operator reports.
fn capped_next(acked: u64, claimed: u64, max_delta: u64) -> u64 {
    claimed.min(acked.saturating_add(max_delta))
}

// ─────────────────────────────── Config ──────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChannelConfig {
    lot_id: String,
    session_key: String,
    operator_url: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    max_tokens: u64,
    #[serde(default)]
    expiry: u64,
}

impl ChannelConfig {
    fn into_channel(self) -> anyhow::Result<Channel> {
        let signer = Signer::from_hex(&self.session_key)
            .map_err(|e| anyhow::anyhow!("sessionKey for {}: {e}", self.lot_id))?;
        Ok(Channel {
            lot_id: self
                .lot_id
                .parse()
                .map_err(|_| anyhow::anyhow!("lotId not bytes32: {}", self.lot_id))?,
            session: signer.address(),
            signer,
            operator_url: self.operator_url.trim_end_matches('/').to_string(),
            model: self.model,
            max_tokens: self.max_tokens,
            expiry: self.expiry,
            acked: Mutex::new(0),
        })
    }
}

fn load_channels() -> anyhow::Result<Vec<Channel>> {
    if let Ok(path) = std::env::var("SURPLUS_GATEWAY_CONFIG") {
        let raw = std::fs::read_to_string(&path)
            .map_err(|e| anyhow::anyhow!("reading SURPLUS_GATEWAY_CONFIG {path}: {e}"))?;
        let cfgs: Vec<ChannelConfig> =
            serde_json::from_str(&raw).map_err(|e| anyhow::anyhow!("parsing {path}: {e}"))?;
        anyhow::ensure!(!cfgs.is_empty(), "gateway config lists no channels");
        return cfgs.into_iter().map(ChannelConfig::into_channel).collect();
    }
    // Back-compat: a single channel from env.
    let cfg = ChannelConfig {
        lot_id: env("SURPLUS_LOT_ID")?,
        session_key: env("SURPLUS_SESSION_KEY")?,
        operator_url: env("SURPLUS_OPERATOR_URL")?,
        model: None,
        max_tokens: 0,
        expiry: 0,
    };
    Ok(vec![cfg.into_channel()?])
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
    let channels: Vec<Arc<Channel>> = load_channels()?.into_iter().map(Arc::new).collect();
    let gateway = Arc::new(Gateway {
        chain_id: U256::from(env("SURPLUS_CHAIN_ID")?.parse::<u64>()?),
        settlement: env("SURPLUS_SETTLEMENT_ADDR")?
            .parse()
            .map_err(|_| anyhow::anyhow!("bad SURPLUS_SETTLEMENT_ADDR"))?,
        client: reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(300))
            .build()?,
        channels,
    });
    tracing::info!(
        %listen, lots = gateway.channels.len(),
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

#[cfg(test)]
mod tests {
    use super::capped_next;

    #[test]
    fn caps_per_request_advance_at_max_tokens() {
        assert_eq!(capped_next(100, 150, 100), 150); // honest serve passes through
        assert_eq!(capped_next(100, 5000, 100), 200); // over-claim capped at +max_tokens
        assert_eq!(capped_next(100, 200, 100), 200); // exactly at the bound
        assert_eq!(capped_next(100, 90, 100), 90); // regression left as-is
    }
}
