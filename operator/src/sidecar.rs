use crate::config::{OperatorConfig, QuoteParams, RiskLimits};
use serde::{Deserialize, Serialize};

/// Request the operator sends the mm-sidecar each tick.
#[derive(Serialize)]
pub struct QuoteRequest<'a> {
    #[serde(rename = "instrumentId")]
    pub instrument_id: &'a str,
    #[serde(rename = "refMid")]
    pub ref_mid: f64,
    #[serde(rename = "inventoryTokens")]
    pub inventory_tokens: f64,
    #[serde(rename = "drawdownMicro")]
    pub drawdown_micro: f64,
    pub params: &'a QuoteParams,
    pub limits: &'a RiskLimits,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Quote {
    pub price: f64,
    pub qty: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct QuoteResponse {
    #[serde(rename = "instrumentId")]
    pub instrument_id: String,
    pub bid: Option<Quote>,
    pub ask: Option<Quote>,
    pub rationale: String,
    pub valid: bool,
    pub score: f64,
    pub reasons: Vec<String>,
    #[serde(rename = "killSwitch")]
    pub kill_switch: bool,
}

/// HTTP client to the mm-sidecar. The operator decides nothing about quoting —
/// it delegates to the sidecar (deterministic A–S today, an agent later) and
/// then enforces the returned risk verdict before placing anything.
pub struct SidecarClient {
    http: reqwest::Client,
    base: String,
}

impl SidecarClient {
    pub fn new(base: String) -> Self {
        SidecarClient {
            http: reqwest::Client::new(),
            base,
        }
    }

    pub async fn quote(
        &self,
        cfg: &OperatorConfig,
        instrument_id: &str,
        ref_mid: f64,
        inventory_tokens: f64,
        drawdown_micro: f64,
    ) -> anyhow::Result<QuoteResponse> {
        let req = QuoteRequest {
            instrument_id,
            ref_mid,
            inventory_tokens,
            drawdown_micro,
            params: &cfg.params,
            limits: &cfg.limits,
        };
        let resp = self
            .http
            .post(format!("{}/quote", self.base))
            .json(&req)
            .send()
            .await?
            .error_for_status()?
            .json::<QuoteResponse>()
            .await?;
        Ok(resp)
    }
}
