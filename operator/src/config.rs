use serde::{Deserialize, Serialize};

/// One tradeable instrument the operator makes a market in.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Instrument {
    pub id: String,
    pub model_id: String,
    pub token_kind: String, // "input" | "output"
    pub tick_size: i64,
    pub min_qty: i64,
}

/// Avellaneda–Stoikov quoting parameters, passed straight through to the
/// mm-sidecar. The operator owns these (per instrument in a fuller build); the
/// sidecar is stateless.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct QuoteParams {
    pub gamma: f64,
    pub sigma: f64,
    #[serde(rename = "horizonTicks")]
    pub horizon_ticks: f64,
    pub k: f64,
    pub size: f64,
    #[serde(rename = "maxInventory")]
    pub max_inventory: f64,
    #[serde(rename = "tickSize")]
    pub tick_size: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RiskLimits {
    #[serde(rename = "maxInventory")]
    pub max_inventory: f64,
    #[serde(rename = "maxQuoteNotional")]
    pub max_quote_notional: f64,
    #[serde(rename = "maxDeviationBps")]
    pub max_deviation_bps: f64,
    #[serde(rename = "minSpreadBps")]
    pub min_spread_bps: f64,
    #[serde(rename = "killSwitchDrawdown")]
    pub kill_switch_drawdown: f64,
}

/// On-chain settlement binding. Present when the venue trades signed firm
/// orders (RFQ + signed CLOB) that clear on the SurplusSettlement contract.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SettlementConfig {
    /// EIP-712 domain chain id (Tangle testnet 3799, mainnet 5845, anvil 31337).
    pub chain_id: u64,
    /// SurplusSettlement contract address, 0x-hex.
    pub contract: String,
    /// EVM key the operator signs RFQ quotes / MM quotes with, 0x-hex. Without
    /// it the venue still accepts third-party signed orders but quotes nothing.
    pub operator_key: Option<String>,
    /// RPC endpoint for direct submission (feature `chain`).
    pub rpc_url: Option<String>,
    /// Firm-quote TTL: how long an RFQ response stays settleable on-chain.
    pub rfq_ttl_secs: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OperatorConfig {
    /// Where the mm-sidecar listens (the quoting brain).
    pub sidecar_url: String,
    /// Tangle Router base URL for reference pricing (`/v1/models`).
    pub router_url: String,
    pub instruments: Vec<Instrument>,
    pub params: QuoteParams,
    pub limits: RiskLimits,
    pub settlement: Option<SettlementConfig>,
}

impl OperatorConfig {
    /// Read config from env with dev defaults so the lite operator boots with
    /// zero setup against a local sidecar.
    pub fn from_env() -> Self {
        let sidecar_url = std::env::var("SURPLUS_SIDECAR_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:9110".to_string());
        // The operator's quoted size per touch level, tokens. Risk bounds scale
        // with it so a larger commitment stays inside the gate.
        let mm_size = std::env::var("SURPLUS_MM_SIZE")
            .ok()
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|v| *v >= 1_000.0)
            .unwrap_or(50_000.0);
        let router_url = std::env::var("SURPLUS_ROUTER_URL")
            .unwrap_or_else(|_| "https://router.tangle.tools".to_string());
        let settlement = match (
            std::env::var("SURPLUS_CHAIN_ID").ok().and_then(|v| v.parse::<u64>().ok()),
            std::env::var("SURPLUS_SETTLEMENT_ADDR").ok(),
        ) {
            (Some(chain_id), Some(contract)) => Some(SettlementConfig {
                chain_id,
                contract,
                operator_key: std::env::var("SURPLUS_OPERATOR_KEY").ok(),
                rpc_url: std::env::var("SURPLUS_RPC_URL").ok(),
                rfq_ttl_secs: std::env::var("SURPLUS_RFQ_TTL_SECS")
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(120),
            }),
            _ => None,
        };
        OperatorConfig {
            sidecar_url,
            router_url,
            settlement,
            instruments: vec![Instrument {
                id: "anthropic/claude-opus-4-8:output".to_string(),
                model_id: "anthropic/claude-opus-4-8".to_string(),
                token_kind: "output".to_string(),
                tick_size: 1000,
                min_qty: 1000,
            }],
            params: QuoteParams {
                gamma: 0.0000015,
                sigma: 22_500.0,
                horizon_ticks: 120.0,
                k: 1.5,
                size: mm_size,
                max_inventory: (mm_size * 30.0).max(300_000.0),
                tick_size: 1000.0,
            },
            limits: RiskLimits {
                max_inventory: (mm_size * 40.0).max(400_000.0),
                max_quote_notional: 2_000_000_000.0_f64.max(mm_size * 50.0),
                max_deviation_bps: 300.0,
                min_spread_bps: 2.0,
                kill_switch_drawdown: 5_000_000.0,
            },
        }
    }

}
