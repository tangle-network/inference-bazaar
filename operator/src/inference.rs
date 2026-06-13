//! The inference backend seam — where a credit's tokens actually come from.
//!
//! The universal serving interface is the OpenAI-compatible chat-completions
//! API: vLLM, llama.cpp, the Tangle Router, and every commercial provider all
//! speak it. A backend is therefore "a base URL + optional bearer key", with
//! one operational nicety: the operator can MANAGE a local vLLM subprocess
//! (spawned at boot, killed with the venue) and serve from it — the credit is
//! then backed by the operator's own GPU rather than its willingness to pay an
//! upstream. This is deliberately NOT a dependency on the llm-inference
//! blueprint lib: that crate unconditionally pulls blueprint-sdk (+TEE),
//! tangle-inference-core, axum and prometheus into every consumer, and this
//! operator's lite path stays substrate-free by design. vLLM's own server IS
//! the OpenAI-compat interface, so the URL seam loses nothing.
//!
//! Selection (env), in precedence order:
//!   SURPLUS_VLLM_MODEL        — spawn `python3 -m vllm.entrypoints.openai.api_server`
//!                               serving this model on SURPLUS_VLLM_PORT
//!                               (default 8901; SURPLUS_VLLM_ARGS appended) and
//!                               serve from it.
//!   SURPLUS_INFERENCE_URL     — serve from this OpenAI-compat base URL
//!                               (SURPLUS_INFERENCE_API_KEY as bearer).
//!   neither                   — serve through the Tangle Router
//!                               (SURPLUS_ROUTER_URL + SURPLUS_ROUTER_API_KEY),
//!                               the legacy proxy behavior, unchanged.

use serde_json::{json, Value};
use std::time::Duration;

pub struct InferenceBackend {
    base_url: String,
    api_key: Option<String>,
    client: reqwest::Client,
    /// "managed-vllm" | "external" | "router" — for status surfaces and logs.
    mode: &'static str,
    /// Keeps a managed vLLM child alive; `kill_on_drop` ties its lifetime to
    /// the venue's.
    _managed: Option<tokio::process::Child>,
}

/// Build the shared HTTP client, tunneling through Tor when `PRIVACY_MODE=tor`.
///
/// Network anonymity for the SELLER is a client-side concern: the leaking leg is
/// the seller dialing an operator's `/redeem` (the operator is the server there
/// and cannot anonymize its own inbound peers). This proxy therefore protects
/// the OPERATOR's OWN outbound calls — to a remote OpenAI-compatible backend, or
/// when this process acts as a redemption client to another operator — by
/// routing them through Arti's SOCKS5 listener. `socks5h` (not `socks5`) sends
/// the hostname to the proxy so `.onion` names resolve inside Tor.
/// `SURPLUS_TOR_SOCKS` overrides the default Arti listener (127.0.0.1:9150).
fn http_client() -> reqwest::Client {
    let mut b = reqwest::Client::builder().timeout(Duration::from_secs(300));
    if std::env::var("PRIVACY_MODE").as_deref() == Ok("tor") {
        let socks = std::env::var("SURPLUS_TOR_SOCKS")
            .unwrap_or_else(|_| "socks5h://127.0.0.1:9150".to_string());
        let proxy = reqwest::Proxy::all(&socks)
            .unwrap_or_else(|e| panic!("PRIVACY_MODE=tor but SOCKS proxy {socks} is invalid: {e}"));
        b = b.proxy(proxy);
        tracing::info!(%socks, "PRIVACY_MODE=tor: outbound inference tunneled through Arti SOCKS5");
    }
    b.build().expect("reqwest client")
}

impl InferenceBackend {
    pub fn new(base_url: impl Into<String>, api_key: Option<String>) -> Self {
        InferenceBackend {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            api_key,
            client: http_client(),
            mode: "external",
            _managed: None,
        }
    }

    /// Must run inside a tokio runtime (a managed vLLM spawn needs one).
    pub fn from_env(router_url: &str) -> Self {
        let api_key = std::env::var("SURPLUS_INFERENCE_API_KEY")
            .or_else(|_| std::env::var("SURPLUS_ROUTER_API_KEY"))
            .ok();

        if let Ok(model) = std::env::var("SURPLUS_VLLM_MODEL") {
            let port: u16 = std::env::var("SURPLUS_VLLM_PORT")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(8901);
            let mut cmd = tokio::process::Command::new("python3");
            cmd.args(["-m", "vllm.entrypoints.openai.api_server"])
                .args(["--model", &model])
                .args(["--port", &port.to_string()]);
            if let Ok(extra) = std::env::var("SURPLUS_VLLM_ARGS") {
                cmd.args(extra.split_whitespace());
            }
            cmd.kill_on_drop(true);
            match cmd.spawn() {
                Ok(child) => {
                    let base_url = format!("http://127.0.0.1:{port}");
                    spawn_readiness_log(base_url.clone(), model.clone());
                    let mut b = Self::new(base_url, api_key);
                    b.mode = "managed-vllm";
                    b._managed = Some(child);
                    return b;
                }
                Err(e) => {
                    // Refusing to boot beats silently serving from the wrong
                    // backend: the operator configured its own GPU on purpose.
                    panic!("SURPLUS_VLLM_MODEL set but vLLM failed to spawn: {e}");
                }
            }
        }

        if let Ok(url) = std::env::var("SURPLUS_INFERENCE_URL") {
            return Self::new(url, api_key);
        }
        let mut b = Self::new(router_url, api_key);
        b.mode = "router";
        b
    }

    /// Where completions come from, for status/log surfaces.
    pub fn target(&self) -> Value {
        json!({ "mode": self.mode, "url": self.base_url })
    }

    /// "managed-vllm" | "external" | "router". A bonded issuer must NOT be in
    /// "router" mode — it would resell a third party's inference rather than
    /// serve what it sold (enforced fail-closed at venue boot).
    pub fn mode(&self) -> &str {
        self.mode
    }

    /// One OpenAI-compatible chat completion. Returns the upstream status and
    /// body verbatim — the caller meters `usage` and decides settlement.
    pub async fn chat_completion(
        &self,
        model: &str,
        messages: &serde_json::value::RawValue,
        max_tokens: u32,
    ) -> Result<(reqwest::StatusCode, Value), String> {
        let mut req = self
            .client
            .post(format!("{}/v1/chat/completions", self.base_url))
            .json(&json!({
                "model": model,
                "messages": messages,
                "max_tokens": max_tokens,
            }))
            .timeout(Duration::from_secs(120));
        if let Some(key) = &self.api_key {
            req = req.bearer_auth(key);
        }
        let resp = req.send().await.map_err(|e| format!("backend: {e}"))?;
        let status = resp.status();
        let body: Value = resp
            .json()
            .await
            .map_err(|e| format!("backend body: {e}"))?;
        Ok((status, body))
    }

    /// Streaming OpenAI-compatible chat completion. Returns the upstream's raw
    /// streaming response (SSE); the caller forwards the chunks token-by-token and
    /// tees the final `usage` chunk to meter. `stream_options.include_usage` makes
    /// the backend emit that final chunk so streamed requests bill like buffered.
    pub async fn chat_completion_stream(
        &self,
        model: &str,
        messages: &serde_json::value::RawValue,
        max_tokens: u32,
    ) -> Result<reqwest::Response, String> {
        let mut req = self
            .client
            .post(format!("{}/v1/chat/completions", self.base_url))
            .json(&json!({
                "model": model,
                "messages": messages,
                "max_tokens": max_tokens,
                "stream": true,
                "stream_options": { "include_usage": true },
            }))
            .timeout(Duration::from_secs(300));
        if let Some(key) = &self.api_key {
            req = req.bearer_auth(key);
        }
        req.send().await.map_err(|e| format!("backend: {e}"))
    }
}

/// vLLM cold-starts in minutes (model load); poll /health and log the moment
/// the backend can actually serve, so "listed but not ready" is visible in ops.
fn spawn_readiness_log(base_url: String, model: String) {
    tokio::spawn(async move {
        let client = reqwest::Client::new();
        for i in 0.. {
            tokio::time::sleep(Duration::from_secs(5)).await;
            if client
                .get(format!("{base_url}/health"))
                .send()
                .await
                .map(|r| r.status().is_success())
                .unwrap_or(false)
            {
                tracing::info!(%base_url, %model, "managed vLLM ready");
                return;
            }
            if i % 12 == 0 {
                tracing::info!(%base_url, %model, "managed vLLM still loading…");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::post, Json, Router};

    async fn stub_openai(expect_bearer: Option<&'static str>) -> String {
        let app = Router::new().route(
            "/v1/chat/completions",
            post(
                move |headers: axum::http::HeaderMap, Json(body): Json<Value>| async move {
                    if let Some(want) = expect_bearer {
                        let got = headers
                            .get("authorization")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("");
                        assert_eq!(got, format!("Bearer {want}"));
                    }
                    assert_eq!(body["model"], "test-model");
                    Json(json!({
                        "choices": [{ "message": { "role": "assistant", "content": "ok" } }],
                        "usage": { "prompt_tokens": 7, "completion_tokens": 42 }
                    }))
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn serves_from_any_openai_url_with_bearer() {
        let url = stub_openai(Some("sekret")).await;
        let backend = InferenceBackend::new(url, Some("sekret".into()));
        let messages =
            serde_json::value::RawValue::from_string(r#"[{"role":"user","content":"hi"}]"#.into())
                .unwrap();
        let (status, body) = backend
            .chat_completion("test-model", &messages, 256)
            .await
            .unwrap();
        assert!(status.is_success());
        assert_eq!(body["usage"]["completion_tokens"], 42);
    }

    #[tokio::test]
    async fn keyless_backend_sends_no_auth_header() {
        let url = stub_openai(None).await;
        let backend = InferenceBackend::new(url, None);
        let messages =
            serde_json::value::RawValue::from_string(r#"[{"role":"user","content":"hi"}]"#.into())
                .unwrap();
        let (status, _) = backend
            .chat_completion("test-model", &messages, 16)
            .await
            .unwrap();
        assert!(status.is_success());
    }
}
