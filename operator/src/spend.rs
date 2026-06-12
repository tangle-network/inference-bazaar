//! The spend-key rail: a credit lot consumed through a plain OpenAI-compatible
//! API — `Authorization: Bearer sk-surplus-…`, vanilla SDKs, zero per-request
//! crypto.
//!
//! The holder signs ONE EIP-712 `SpendKeyAuth { lotId, keyHash, maxTokens,
//! expiry }` (under the settlement contract's own domain — the contract
//! verifies the same digest in `settleSpend`). The key itself is generated
//! client-side; only its keccak256 reaches this operator at registration, and
//! the raw key is seen only inside TLS at request time, exactly like every
//! hosted API key in existence.
//!
//! Serving: `POST /v1/chat/completions` resolves the bearer to its
//! authorization, serves through the venue's [`InferenceBackend`], meters the
//! lot's token kind, and accumulates a cumulative served counter (journaled —
//! a restart must never forget what it already served, audit M1). A background
//! flush presents `settleSpend(auth, servedCumulative, holderSig)` on-chain,
//! debiting the lot. Cumulative semantics make the flush idempotent at any
//! cadence; a missed flush past lot expiry is THIS operator's loss by design.
//!
//! Trust statement (same as the docs make to the dev): within the cap you
//! authorized, you trust this issuer's metering — which is already true of
//! every request served today — backed by its collateral and slashable bond.
//! Revocation (`revokeSpendKey`) is the on-chain emergency brake.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, value::RawValue, Value};
use surplus_settlement::core::alloy_primitives::{keccak256, Address, B256, U256};
use surplus_settlement::core::hex;

use crate::venue::{Venue, VenueError};

/// Never serve within this margin of the auth's or lot's expiry: the
/// settlement transaction must still land before either clock runs out.
const SPEND_EXPIRY_MARGIN_SECS: u64 = 120;
/// Per-request completion cap, mirroring `/redeem`.
const MAX_TOKENS_PER_REQUEST: u32 = 8192;

// ─────────────────────────────── Digest ──────────────────────────────────────

const SPEND_TYPE: &[u8] =
    b"SpendKeyAuth(bytes32 lotId,bytes32 keyHash,uint64 maxTokens,uint64 expiry)";

/// keccak256(\x19\x01 ‖ settlementDomainSeparator ‖ structHash) — byte-for-byte
/// the contract's `spendAuthDigest`. Pinned cross-stack by
/// `tests::digest_matches_contract_pin` against test/Spend.t.sol.
pub fn spend_auth_digest(
    chain_id: U256,
    settlement: Address,
    lot_id: B256,
    key_hash: B256,
    max_tokens: u64,
    expiry: u64,
) -> B256 {
    let mut dom = Vec::with_capacity(160);
    dom.extend_from_slice(
        keccak256(
            b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
        )
        .as_slice(),
    );
    dom.extend_from_slice(keccak256(b"SurplusSettlement").as_slice());
    dom.extend_from_slice(keccak256(b"1").as_slice());
    dom.extend_from_slice(&chain_id.to_be_bytes::<32>());
    dom.extend_from_slice(&[0u8; 12]);
    dom.extend_from_slice(settlement.as_slice());
    let domain_separator = keccak256(&dom);

    let mut st = Vec::with_capacity(160);
    st.extend_from_slice(keccak256(SPEND_TYPE).as_slice());
    st.extend_from_slice(lot_id.as_slice());
    st.extend_from_slice(key_hash.as_slice());
    st.extend_from_slice(&[0u8; 24]);
    st.extend_from_slice(&max_tokens.to_be_bytes());
    st.extend_from_slice(&[0u8; 24]);
    st.extend_from_slice(&expiry.to_be_bytes());
    let struct_hash = keccak256(&st);

    let mut out = Vec::with_capacity(66);
    out.extend_from_slice(b"\x19\x01");
    out.extend_from_slice(domain_separator.as_slice());
    out.extend_from_slice(struct_hash.as_slice());
    keccak256(&out)
}

// ─────────────────────────────── State ───────────────────────────────────────

/// One registered key: the holder-signed authorization plus what this venue
/// resolved about the lot at registration time.
#[derive(Clone, Serialize, Deserialize)]
pub struct StoredAuth {
    pub lot_id: B256,
    pub key_hash: B256,
    pub max_tokens: u64,
    pub expiry: u64,
    /// Holder's 65-byte signature over the auth digest, 0x-hex — what
    /// `settleSpend` re-verifies on-chain.
    pub signature: String,
    pub holder: Address,
    pub instrument_id: String,
    pub model_id: String,
    pub token_kind: String,
}

#[derive(Default, Serialize, Deserialize)]
struct SpendJournal {
    /// key hash (of the full bearer string) → authorization.
    auths: HashMap<B256, StoredAuth>,
    /// key hash → cumulative tokens served (the number settleSpend receives).
    served: HashMap<B256, u64>,
    /// key hash → cumulative tokens confirmed settled on-chain.
    settled: HashMap<B256, u64>,
}

pub struct SpendSvc {
    venue: Arc<Venue>,
    state: Mutex<SpendJournal>,
}

pub type SharedSpend = Arc<SpendSvc>;

fn journal_path() -> Option<std::path::PathBuf> {
    std::env::var("DATA_DIR")
        .or_else(|_| std::env::var("SURPLUS_DATA_DIR"))
        .ok()
        .map(|d| std::path::Path::new(&d).join("spendkeys.json"))
}

impl SpendSvc {
    pub fn new(venue: Arc<Venue>) -> Self {
        let state = journal_path()
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|raw| serde_json::from_slice(&raw).ok())
            .unwrap_or_default();
        SpendSvc {
            venue,
            state: Mutex::new(state),
        }
    }

    /// Persist on every mutation — served counters are money-shaped state: a
    /// restart that forgot them would re-serve already-consumed quota.
    fn persist(&self, j: &SpendJournal) {
        let Some(path) = journal_path() else { return };
        if let Ok(bytes) = serde_json::to_vec_pretty(j) {
            if let Err(e) = std::fs::write(&path, bytes) {
                tracing::error!("spend journal write failed: {e}");
            }
        }
    }

    fn now() -> u64 {
        crate::market::now_unix()
    }

    // ───────────────────────── Registration ─────────────────────────────────

    /// Verify the holder's authorization against on-chain truth and store it.
    /// Without the `chain` feature (or RPC config) registration refuses — an
    /// unverifiable key would be a fail-open.
    #[cfg(feature = "chain")]
    pub async fn register(&self, body: RegisterBody) -> Result<Value, VenueError> {
        use surplus_settlement::core::recover_signer;

        let ctx = self.venue.settle_ctx_pub()?;
        let (rpc, op_key) = match (ctx.rpc_url.as_deref(), ctx.operator_key.as_deref()) {
            (Some(r), Some(k)) => (r, k),
            _ => return Err(VenueError::SettlementUnconfigured("rpc + operator key")),
        };
        let now = Self::now();
        if body.expiry <= now + SPEND_EXPIRY_MARGIN_SECS {
            return Err(VenueError::Rejected("auth expiry too soon".into()));
        }
        if body.max_tokens == 0 {
            return Err(VenueError::Rejected("maxTokens is zero".into()));
        }

        let chain_id = ctx.domain.chain_id.unwrap_or_default();
        let digest = spend_auth_digest(
            chain_id,
            ctx.contract,
            body.lot_id,
            body.key_hash,
            body.max_tokens,
            body.expiry,
        );
        let sig = hex::decode(body.signature.trim_start_matches("0x"))
            .map_err(|_| VenueError::Rejected("signature is not hex".into()))?;
        let signer = recover_signer(digest, &sig)
            .ok_or_else(|| VenueError::Rejected("unrecoverable auth signature".into()))?;

        let client =
            surplus_settlement::chain::SettlementClient::connect(rpc, op_key, ctx.contract)
                .await
                .map_err(|e| VenueError::Chain(e.to_string()))?;
        let lot = client
            .get_lot(body.lot_id)
            .await
            .map_err(|e| VenueError::Chain(e.to_string()))?;
        if lot.holder == Address::ZERO {
            return Err(VenueError::NotFound("lot".into()));
        }
        if lot.holder != signer {
            return Err(VenueError::Rejected(
                "authorization is not from the lot holder".into(),
            ));
        }
        let me = ctx
            .operator_address_hex()
            .ok_or(VenueError::SettlementUnconfigured("operator key"))?;
        if format!("{:#x}", lot.issuer).to_lowercase() != me.to_lowercase() {
            return Err(VenueError::Rejected(
                "lot was not issued by this operator".into(),
            ));
        }
        if u64::from(lot.expiry) <= now + SPEND_EXPIRY_MARGIN_SECS {
            return Err(VenueError::Rejected("lot expires too soon".into()));
        }
        let inst = self
            .venue
            .instruments()
            .into_iter()
            .find(|i| surplus_settlement::instrument_hash(&i.id) == lot.instrument)
            .ok_or_else(|| VenueError::Rejected("unknown instrument hash on lot".into()))?;

        let stored = StoredAuth {
            lot_id: body.lot_id,
            key_hash: body.key_hash,
            max_tokens: body.max_tokens,
            expiry: body.expiry,
            signature: body.signature,
            holder: signer,
            instrument_id: inst.id.clone(),
            model_id: inst.model_id.clone(),
            token_kind: inst.token_kind.clone(),
        };
        let mut j = self.state.lock().unwrap();
        j.auths.insert(body.key_hash, stored);
        self.persist(&j);
        Ok(json!({
            "keyHash": format!("{:#x}", body.key_hash),
            "model": inst.model_id,
            "instrumentId": inst.id,
            "maxTokens": body.max_tokens,
            "expiry": body.expiry,
            "baseUrl": "/v1",
        }))
    }

    #[cfg(not(feature = "chain"))]
    pub async fn register(&self, _body: RegisterBody) -> Result<Value, VenueError> {
        Err(VenueError::SettlementUnconfigured(
            "spend keys need the chain feature (lot ownership is verified on-chain)",
        ))
    }

    // ───────────────────────── Serving ───────────────────────────────────────

    /// One OpenAI-compatible chat completion billed to the bearer's lot.
    pub async fn complete(
        &self,
        bearer: &str,
        body: ChatBody,
    ) -> Result<Value, (StatusCode, Value)> {
        let key_hash = keccak256(bearer.as_bytes());
        let (auth, already_served) = {
            let j = self.state.lock().unwrap();
            let Some(auth) = j.auths.get(&key_hash).cloned() else {
                return Err((
                    StatusCode::UNAUTHORIZED,
                    oai_err("invalid_api_key", "Unknown API key."),
                ));
            };
            (auth.clone(), j.served.get(&key_hash).copied().unwrap_or(0))
        };

        let now = Self::now();
        if now + SPEND_EXPIRY_MARGIN_SECS > auth.expiry {
            return Err((
                StatusCode::UNAUTHORIZED,
                oai_err("key_expired", "This API key has expired."),
            ));
        }
        let remaining = auth.max_tokens.saturating_sub(already_served);
        if remaining == 0 {
            return Err((
                StatusCode::PAYMENT_REQUIRED,
                oai_err(
                    "insufficient_quota",
                    "This key's authorized quota is fully consumed.",
                ),
            ));
        }
        if body.stream.unwrap_or(false) {
            return Err((
                StatusCode::BAD_REQUEST,
                oai_err(
                    "unsupported",
                    "stream=true is not supported yet; poll non-streaming.",
                ),
            ));
        }
        if !body.model.is_empty() && body.model != auth.model_id {
            return Err((
                StatusCode::BAD_REQUEST,
                oai_err(
                    "model_mismatch",
                    &format!(
                        "This key is bound to '{}'; set model accordingly.",
                        auth.model_id
                    ),
                ),
            ));
        }

        let cap = body
            .max_tokens
            .unwrap_or(1024)
            .min(MAX_TOKENS_PER_REQUEST)
            .min(u32::try_from(remaining).unwrap_or(u32::MAX));
        let (status, completion) = self
            .venue
            .inference
            .chat_completion(&auth.model_id, &body.messages, cap)
            .await
            .map_err(|e| (StatusCode::BAD_GATEWAY, oai_err("upstream", &e)))?;
        if !status.is_success() {
            return Err((
                StatusCode::BAD_GATEWAY,
                oai_err("upstream", &completion.to_string()),
            ));
        }

        // Meter the lot's token kind, never past the authorized remainder.
        let usage_key = if auth.token_kind == "input" {
            "prompt_tokens"
        } else {
            "completion_tokens"
        };
        let used = completion
            .get("usage")
            .and_then(|u| u.get(usage_key))
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(remaining);
        {
            let mut j = self.state.lock().unwrap();
            *j.served.entry(key_hash).or_insert(0) += used;
            self.persist(&j);
        }
        Ok(completion)
    }

    /// OpenAI-shape model list: what this venue can bill a spend key against.
    pub fn models(&self) -> Value {
        let models: Vec<Value> = self
            .venue
            .instruments()
            .iter()
            .map(|i| json!({ "id": i.model_id, "object": "model", "owned_by": "surplus" }))
            .collect();
        json!({ "object": "list", "data": models })
    }

    // ───────────────────────── Settlement flush ─────────────────────────────

    /// Settle every key whose served counter is ahead of its settled counter.
    /// Cumulative on-chain semantics make retries safe; failures stay queued
    /// by construction (served > settled persists until a flush succeeds).
    #[cfg(feature = "chain")]
    pub async fn flush(&self) -> Result<Value, VenueError> {
        let ctx = self.venue.settle_ctx_pub()?;
        let (rpc, op_key) = match (ctx.rpc_url.as_deref(), ctx.operator_key.as_deref()) {
            (Some(r), Some(k)) => (r, k),
            _ => {
                return Ok(
                    json!({ "mode": "dry", "hint": "set SURPLUS_RPC_URL + SURPLUS_OPERATOR_KEY" }),
                )
            }
        };
        let pending: Vec<(B256, StoredAuth, u64)> = {
            let j = self.state.lock().unwrap();
            j.auths
                .iter()
                .filter_map(|(kh, a)| {
                    let served = j.served.get(kh).copied().unwrap_or(0);
                    let settled = j.settled.get(kh).copied().unwrap_or(0);
                    (served > settled).then(|| (*kh, a.clone(), served))
                })
                .collect()
        };
        if pending.is_empty() {
            return Ok(json!({ "mode": "noop", "settled": 0 }));
        }
        let client =
            surplus_settlement::chain::SettlementClient::connect(rpc, op_key, ctx.contract)
                .await
                .map_err(|e| VenueError::Chain(e.to_string()))?;
        let mut settled_count = 0usize;
        let mut failures = 0usize;
        for (key_hash, auth, served) in pending {
            let sig = match hex::decode(auth.signature.trim_start_matches("0x")) {
                Ok(s) => s,
                Err(_) => continue,
            };
            match client
                .settle_spend(
                    auth.lot_id,
                    auth.key_hash,
                    auth.max_tokens,
                    auth.expiry,
                    served,
                    sig,
                )
                .await
            {
                Ok(tx) => {
                    let mut j = self.state.lock().unwrap();
                    j.settled.insert(key_hash, served);
                    self.persist(&j);
                    settled_count += 1;
                    tracing::info!(lot = %format!("{:#x}", auth.lot_id), served, tx = %format!("{tx:#x}"), "spend settled");
                }
                Err(e) => {
                    failures += 1;
                    tracing::warn!(lot = %format!("{:#x}", auth.lot_id), served, "settleSpend failed (will retry): {e}");
                }
            }
        }
        Ok(json!({ "mode": "direct", "settled": settled_count, "failed": failures }))
    }

    #[cfg(not(feature = "chain"))]
    pub async fn flush(&self) -> Result<Value, VenueError> {
        Ok(json!({ "mode": "dry" }))
    }

    fn status(&self) -> Value {
        let j = self.state.lock().unwrap();
        let unsettled: u64 = j
            .auths
            .keys()
            .map(|kh| {
                j.served.get(kh).copied().unwrap_or(0) - j.settled.get(kh).copied().unwrap_or(0)
            })
            .sum();
        json!({
            "keys": j.auths.len(),
            "servedTokens": j.served.values().sum::<u64>(),
            "settledTokens": j.settled.values().sum::<u64>(),
            "unsettledTokens": unsettled,
        })
    }
}

/// OpenAI-style error envelope so SDKs surface the message verbatim.
fn oai_err(code: &str, message: &str) -> Value {
    json!({ "error": { "type": code, "code": code, "message": message } })
}

// ─────────────────────────────── Wire types ──────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterBody {
    pub lot_id: B256,
    /// keccak256 of the FULL bearer string — the secret itself never arrives.
    pub key_hash: B256,
    pub max_tokens: u64,
    pub expiry: u64,
    /// Holder's EIP-712 signature over the SpendKeyAuth digest, 0x-hex.
    pub signature: String,
}

/// The OpenAI request surface we bill: model + messages + max_tokens. Extra
/// fields are accepted and ignored (SDKs send many).
#[derive(Deserialize)]
pub struct ChatBody {
    #[serde(default)]
    pub model: String,
    pub messages: Box<RawValue>,
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub stream: Option<bool>,
}

// ─────────────────────────────── HTTP surface ────────────────────────────────

pub fn router(svc: SharedSpend) -> Router {
    Router::new()
        .route("/v1/spend-keys", post(register_key))
        .route("/v1/chat/completions", post(chat))
        .route("/v1/models", get(models))
        .route("/v1/spend/status", get(spend_status))
        .route("/v1/spend/flush", post(spend_flush))
        .with_state(svc)
}

async fn register_key(
    State(s): State<SharedSpend>,
    Json(b): Json<RegisterBody>,
) -> impl IntoResponse {
    match s.register(b).await {
        Ok(v) => (StatusCode::CREATED, Json(v)).into_response(),
        Err(e) => (crate::http::err_status_pub(&e), e.to_string()).into_response(),
    }
}

async fn chat(
    State(s): State<SharedSpend>,
    headers: HeaderMap,
    Json(b): Json<ChatBody>,
) -> impl IntoResponse {
    let Some(bearer) = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
    else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(oai_err(
                "missing_api_key",
                "Send Authorization: Bearer sk-surplus-…",
            )),
        )
            .into_response();
    };
    match s.complete(bearer.trim(), b).await {
        Ok(v) => Json(v).into_response(),
        Err((status, body)) => (status, Json(body)).into_response(),
    }
}

async fn models(State(s): State<SharedSpend>) -> impl IntoResponse {
    Json(s.models())
}

async fn spend_status(State(s): State<SharedSpend>) -> impl IntoResponse {
    Json(s.status())
}

async fn spend_flush(State(s): State<SharedSpend>) -> impl IntoResponse {
    match s.flush().await {
        Ok(v) => Json(v).into_response(),
        Err(e) => (crate::http::err_status_pub(&e), e.to_string()).into_response(),
    }
}

/// Background settlement pump for served-but-unsettled spend, sharing the
/// venue's flush cadence.
pub fn spawn_spend_flush(svc: SharedSpend) {
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
            match svc.flush().await {
                Ok(report) if report["mode"] == "direct" => {
                    tracing::info!(%report, "spend flush");
                }
                Ok(_) => {}
                Err(e) => tracing::warn!("spend flush failed: {e}"),
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Cross-stack pin against contracts/test/Spend.t.sol::test_spendDigestPin —
    /// same fields, same domain (chain 3799, contract 0x1111…), same digest.
    #[test]
    fn digest_matches_contract_pin() {
        let digest = spend_auth_digest(
            U256::from(3799u64),
            "0x1111111111111111111111111111111111111111"
                .parse()
                .unwrap(),
            keccak256(b"pin-lot"),
            keccak256(b"pin-key"),
            1_000_000,
            1_800_000_000,
        );
        assert_eq!(
            format!("{digest:#x}"),
            "0xa3d29fef51ab1cca2d7f1b9c763c6cca40d14f9dd9c9a967e217fbb844647d00",
            "operator digest drifted from the contract's spendAuthDigest"
        );
    }
}
