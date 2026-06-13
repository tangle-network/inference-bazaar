//! The spend rail: a credit lot consumed through a plain OpenAI-compatible API,
//! as a **one-way payment channel** (see docs/specs/spend-rail.md).
//!
//! The holder signs ONE EIP-712 `SpendPermit { lotId, sessionKey, maxTokens,
//! expiry }` delegating an ephemeral session key to draw down the lot. The
//! consumer's gateway holds that session key and signs a `SpendVoucher`
//! acknowledging the cumulative tokens served after each request. This operator
//! serves request N+1 only once the gateway has acknowledged everything served
//! through N (the voucher's monotone advance is the per-request possession proof,
//! bounding this operator's exposure to a single unacknowledged request), and
//! settles on-chain with the latest voucher.
//!
//! The security core lives in the contract: `settleSpend` settles only up to a
//! `servedCumulative` the session key signed, so this operator — which does not
//! hold the session key — CANNOT over-bill. Over-billing is impossible by
//! construction, not merely detectable.

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

/// Never serve within this margin of the permit's or lot's expiry: the
/// settlement transaction must still land before either clock runs out.
const SPEND_EXPIRY_MARGIN_SECS: u64 = 120;
/// Per-request completion cap, mirroring `/redeem`.
const MAX_TOKENS_PER_REQUEST: u32 = 8192;

// ─────────────────────────────── Digests ─────────────────────────────────────

const PERMIT_TYPE: &[u8] =
    b"SpendPermit(bytes32 lotId,address sessionKey,uint64 maxTokens,uint64 expiry)";
const VOUCHER_TYPE: &[u8] =
    b"SpendVoucher(bytes32 lotId,address sessionKey,uint64 servedCumulative)";

fn settlement_domain_separator(chain_id: U256, settlement: Address) -> B256 {
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
    keccak256(&dom)
}

fn eip712(domain_separator: B256, struct_hash: B256) -> B256 {
    let mut out = Vec::with_capacity(66);
    out.extend_from_slice(b"\x19\x01");
    out.extend_from_slice(domain_separator.as_slice());
    out.extend_from_slice(struct_hash.as_slice());
    keccak256(&out)
}

/// The digest the HOLDER signs once to delegate the session key — byte-for-byte
/// the contract's `spendPermitDigest`. Pinned by `tests::digests_match_contract_pin`.
pub fn spend_permit_digest(
    chain_id: U256,
    settlement: Address,
    lot_id: B256,
    session_key: Address,
    max_tokens: u64,
    expiry: u64,
) -> B256 {
    let mut st = Vec::with_capacity(160);
    st.extend_from_slice(keccak256(PERMIT_TYPE).as_slice());
    st.extend_from_slice(lot_id.as_slice());
    st.extend_from_slice(&[0u8; 12]);
    st.extend_from_slice(session_key.as_slice());
    st.extend_from_slice(&U256::from(max_tokens).to_be_bytes::<32>());
    st.extend_from_slice(&U256::from(expiry).to_be_bytes::<32>());
    eip712(
        settlement_domain_separator(chain_id, settlement),
        keccak256(&st),
    )
}

/// The digest the SESSION KEY signs per request to acknowledge cumulative served
/// tokens — byte-for-byte the contract's `spendVoucherDigest`.
pub fn spend_voucher_digest(
    chain_id: U256,
    settlement: Address,
    lot_id: B256,
    session_key: Address,
    served_cumulative: u64,
) -> B256 {
    let mut st = Vec::with_capacity(160);
    st.extend_from_slice(keccak256(VOUCHER_TYPE).as_slice());
    st.extend_from_slice(lot_id.as_slice());
    st.extend_from_slice(&[0u8; 12]);
    st.extend_from_slice(session_key.as_slice());
    st.extend_from_slice(&U256::from(served_cumulative).to_be_bytes::<32>());
    eip712(
        settlement_domain_separator(chain_id, settlement),
        keccak256(&st),
    )
}

// ─────────────────────────────── State ───────────────────────────────────────

/// One registered channel: the holder-signed permit plus what this venue
/// resolved about the lot at registration time.
#[derive(Clone, Serialize, Deserialize)]
pub struct StoredPermit {
    pub lot_id: B256,
    pub session_key: Address,
    pub max_tokens: u64,
    pub expiry: u64,
    /// Holder's signature over the permit digest, 0x-hex — what `settleSpend`
    /// re-verifies on-chain against the lot's CURRENT holder.
    pub holder_sig: String,
    pub holder: Address,
    pub instrument_id: String,
    pub model_id: String,
    pub token_kind: String,
}

#[derive(Default, Serialize, Deserialize)]
struct SpendJournal {
    /// session key → permit.
    permits: HashMap<Address, StoredPermit>,
    /// session key → cumulative tokens this venue has metered as served.
    served: HashMap<Address, u64>,
    /// session key → the latest consumer-signed voucher (cumulative, 0x-hex sig).
    voucher: HashMap<Address, (u64, String)>,
    /// session key → cumulative tokens confirmed settled on-chain.
    settled: HashMap<Address, u64>,
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

    /// Persist on every mutation — served/voucher counters are money-shaped state:
    /// a restart that forgot them would re-serve already-consumed quota or lose a
    /// settleable voucher.
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

    /// Verify the holder's permit against on-chain truth and store the channel.
    /// Without the `chain` feature (or RPC config) registration refuses — an
    /// unverifiable permit would be a fail-open.
    #[cfg(feature = "chain")]
    pub async fn register(&self, body: RegisterBody) -> Result<Value, VenueError> {
        use surplus_settlement::core::recover_signer;

        let ctx = self.venue.settle_ctx_pub()?;
        let (rpc, op_key) = match (ctx.rpc_url.as_deref(), ctx.submitter_key()) {
            (Some(r), Some(k)) => (r, k),
            _ => return Err(VenueError::SettlementUnconfigured("rpc + operator key")),
        };
        let now = Self::now();
        if body.expiry <= now + SPEND_EXPIRY_MARGIN_SECS {
            return Err(VenueError::Rejected("permit expiry too soon".into()));
        }
        if body.max_tokens == 0 {
            return Err(VenueError::Rejected("maxTokens is zero".into()));
        }

        let chain_id = ctx.domain.chain_id.unwrap_or_default();
        let digest = spend_permit_digest(
            chain_id,
            ctx.contract,
            body.lot_id,
            body.session_key,
            body.max_tokens,
            body.expiry,
        );
        let sig = hex::decode(body.holder_sig.trim_start_matches("0x"))
            .map_err(|_| VenueError::Rejected("holderSig is not hex".into()))?;
        let signer = recover_signer(digest, &sig)
            .ok_or_else(|| VenueError::Rejected("unrecoverable holder signature".into()))?;

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
                "permit is not from the lot holder".into(),
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
        // Never let a permit outlive the lot's settlement window: serving past
        // lot.expiry cannot be settled (settleSpend reverts), so we would eat it.
        if u64::from(lot.expiry) <= now + SPEND_EXPIRY_MARGIN_SECS {
            return Err(VenueError::Rejected("lot expires too soon".into()));
        }
        if body.expiry > u64::from(lot.expiry) {
            return Err(VenueError::Rejected(
                "permit expiry must not exceed the lot expiry".into(),
            ));
        }
        let inst = self
            .venue
            .instruments()
            .into_iter()
            .find(|i| surplus_settlement::instrument_hash(&i.id) == lot.instrument)
            .ok_or_else(|| VenueError::Rejected("unknown instrument hash on lot".into()))?;

        let stored = StoredPermit {
            lot_id: body.lot_id,
            session_key: body.session_key,
            max_tokens: body.max_tokens,
            expiry: body.expiry,
            holder_sig: body.holder_sig,
            holder: signer,
            instrument_id: inst.id.clone(),
            model_id: inst.model_id.clone(),
            token_kind: inst.token_kind.clone(),
        };
        let mut j = self.state.lock().unwrap();
        j.permits.insert(body.session_key, stored);
        self.persist(&j);
        Ok(json!({
            "sessionKey": format!("{:#x}", body.session_key),
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

    /// One OpenAI-compatible chat completion billed to a spend channel. The
    /// request carries the latest consumer-signed voucher; we serve only once the
    /// voucher acknowledges everything previously served (so our exposure is one
    /// request) and meter the new usage against the lot's token kind.
    pub async fn complete(
        &self,
        voucher: VoucherHeader,
        body: ChatBody,
    ) -> Result<Value, (StatusCode, Value)> {
        let ctx = self.venue.settle_ctx_pub().map_err(|_| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                oai_err("unconfigured", "settlement not configured"),
            )
        })?;
        let chain_id = ctx.domain.chain_id.unwrap_or_default();

        let (permit, already_served) = {
            let j = self.state.lock().unwrap();
            let Some(p) = j.permits.get(&voucher.session_key).cloned() else {
                return Err((
                    StatusCode::UNAUTHORIZED,
                    oai_err("invalid_api_key", "Unknown session key."),
                ));
            };
            (p, j.served.get(&voucher.session_key).copied().unwrap_or(0))
        };

        // The voucher is the per-request possession proof AND the payment ack: it
        // must be signed by the session key and acknowledge everything served so
        // far. A replayed/stale voucher (cumulative < already-served) is refused,
        // so only the session-key holder (the consumer's gateway) can advance.
        let vsig = hex::decode(voucher.signature.trim_start_matches("0x")).map_err(|_| {
            (
                StatusCode::BAD_REQUEST,
                oai_err("bad_voucher", "voucher sig is not hex"),
            )
        })?;
        let vdigest = spend_voucher_digest(
            chain_id,
            ctx.contract,
            permit.lot_id,
            permit.session_key,
            voucher.cumulative,
        );
        let recovered = surplus_settlement::core::recover_signer(vdigest, &vsig);
        if recovered != Some(permit.session_key) {
            return Err((
                StatusCode::UNAUTHORIZED,
                oai_err("bad_voucher", "voucher not signed by the session key"),
            ));
        }
        if voucher.cumulative > permit.max_tokens {
            return Err((
                StatusCode::PAYMENT_REQUIRED,
                oai_err("cap_exceeded", "voucher exceeds the authorized cap"),
            ));
        }
        if voucher.cumulative < already_served {
            return Err((
                StatusCode::CONFLICT,
                oai_err(
                    "stale_voucher",
                    "voucher must acknowledge all previously served tokens",
                ),
            ));
        }

        let now = Self::now();
        if now + SPEND_EXPIRY_MARGIN_SECS > permit.expiry {
            return Err((
                StatusCode::UNAUTHORIZED,
                oai_err("key_expired", "This API key has expired."),
            ));
        }
        let remaining = permit.max_tokens.saturating_sub(already_served);
        if remaining == 0 {
            return Err((
                StatusCode::PAYMENT_REQUIRED,
                oai_err("insufficient_quota", "Authorized quota consumed."),
            ));
        }
        if body.stream.unwrap_or(false) {
            return Err((
                StatusCode::BAD_REQUEST,
                oai_err("unsupported", "stream=true is not supported yet."),
            ));
        }
        if !body.model.is_empty() && body.model != permit.model_id {
            return Err((
                StatusCode::BAD_REQUEST,
                oai_err(
                    "model_mismatch",
                    &format!("This key is bound to '{}'.", permit.model_id),
                ),
            ));
        }

        // Record the (advanced) voucher as the latest settleable proof BEFORE
        // serving, so a crash after serving still settles what the consumer acked.
        {
            let mut j = self.state.lock().unwrap();
            let entry = j
                .voucher
                .entry(permit.session_key)
                .or_insert((0, String::new()));
            if voucher.cumulative >= entry.0 {
                *entry = (voucher.cumulative, voucher.signature.clone());
            }
            self.persist(&j);
        }

        let cap = body
            .max_tokens
            .unwrap_or(1024)
            .min(MAX_TOKENS_PER_REQUEST)
            .min(u32::try_from(remaining).unwrap_or(u32::MAX));
        let (status, completion) = self
            .venue
            .inference
            .chat_completion(&permit.model_id, &body.messages, cap)
            .await
            .map_err(|e| (StatusCode::BAD_GATEWAY, oai_err("upstream", &e)))?;
        if !status.is_success() {
            return Err((
                StatusCode::BAD_GATEWAY,
                oai_err("upstream", &completion.to_string()),
            ));
        }

        let usage_key = if permit.token_kind == "input" {
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
        let total = already_served + used;
        {
            let mut j = self.state.lock().unwrap();
            j.served.insert(permit.session_key, total);
            self.persist(&j);
        }

        // The gateway should now sign a voucher for `nextCumulative` so this
        // request becomes settleable; until it does, this request is our exposure.
        let mut out = completion;
        if let Some(obj) = out.as_object_mut() {
            obj.insert(
                "surplus".into(),
                json!({ "servedTokens": used, "nextCumulative": total }),
            );
        }
        Ok(out)
    }

    /// Record a trailing voucher WITHOUT serving. The voucher rides on the next
    /// chat request as a possession proof, so the operator's settleable voucher is
    /// always one request behind what it served; the gateway calls this after each
    /// response (and on shutdown) so the LAST request is settleable too. Without
    /// it the operator would serve the final request of every channel for free.
    pub fn ack(&self, voucher: VoucherHeader) -> Result<Value, (StatusCode, Value)> {
        let ctx = self.venue.settle_ctx_pub().map_err(|_| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                oai_err("unconfigured", "settlement not configured"),
            )
        })?;
        let chain_id = ctx.domain.chain_id.unwrap_or_default();

        let (permit, already_served) = {
            let j = self.state.lock().unwrap();
            let Some(p) = j.permits.get(&voucher.session_key).cloned() else {
                return Err((
                    StatusCode::UNAUTHORIZED,
                    oai_err("invalid_api_key", "Unknown session key."),
                ));
            };
            (p, j.served.get(&voucher.session_key).copied().unwrap_or(0))
        };
        let vsig = hex::decode(voucher.signature.trim_start_matches("0x")).map_err(|_| {
            (
                StatusCode::BAD_REQUEST,
                oai_err("bad_voucher", "voucher sig is not hex"),
            )
        })?;
        let vdigest = spend_voucher_digest(
            chain_id,
            ctx.contract,
            permit.lot_id,
            permit.session_key,
            voucher.cumulative,
        );
        if surplus_settlement::core::recover_signer(vdigest, &vsig) != Some(permit.session_key) {
            return Err((
                StatusCode::UNAUTHORIZED,
                oai_err("bad_voucher", "voucher not signed by the session key"),
            ));
        }
        if voucher.cumulative > permit.max_tokens {
            return Err((
                StatusCode::PAYMENT_REQUIRED,
                oai_err("cap_exceeded", "voucher exceeds the authorized cap"),
            ));
        }
        // Never store a voucher that acknowledges more than we served: settling it
        // would debit the holder's lot for tokens they never received.
        if voucher.cumulative > already_served {
            return Err((
                StatusCode::CONFLICT,
                oai_err("ahead_voucher", "voucher acknowledges more than served"),
            ));
        }
        let mut j = self.state.lock().unwrap();
        let entry = j
            .voucher
            .entry(permit.session_key)
            .or_insert((0, String::new()));
        if voucher.cumulative > entry.0 {
            *entry = (voucher.cumulative, voucher.signature.clone());
            self.persist(&j);
        }
        Ok(json!({ "acknowledged": voucher.cumulative }))
    }

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

    /// Settle every channel whose latest voucher is ahead of its settled total.
    /// Cumulative on-chain semantics make retries safe; failures stay queued by
    /// construction (voucher > settled persists until a flush succeeds).
    #[cfg(feature = "chain")]
    pub async fn flush(&self) -> Result<Value, VenueError> {
        let ctx = self.venue.settle_ctx_pub()?;
        let (rpc, op_key) = match (ctx.rpc_url.as_deref(), ctx.submitter_key()) {
            (Some(r), Some(k)) => (r, k),
            _ => {
                return Ok(
                    json!({ "mode": "dry", "hint": "set SURPLUS_RPC_URL + SURPLUS_SUBMITTER_KEY" }),
                )
            }
        };
        let pending: Vec<(StoredPermit, u64, String)> = {
            let j = self.state.lock().unwrap();
            j.permits
                .iter()
                .filter_map(|(sk, p)| {
                    let (vcum, vsig) = j.voucher.get(sk).cloned().unwrap_or((0, String::new()));
                    let settled = j.settled.get(sk).copied().unwrap_or(0);
                    (vcum > settled && !vsig.is_empty()).then(|| (p.clone(), vcum, vsig))
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
        for (permit, vcum, vsig) in pending {
            let (Ok(hsig), Ok(vsig_bytes)) = (
                hex::decode(permit.holder_sig.trim_start_matches("0x")),
                hex::decode(vsig.trim_start_matches("0x")),
            ) else {
                continue;
            };
            match client
                .settle_spend(
                    permit.lot_id,
                    permit.session_key,
                    permit.max_tokens,
                    permit.expiry,
                    hsig,
                    vcum,
                    vsig_bytes,
                )
                .await
            {
                Ok(tx) => {
                    let mut j = self.state.lock().unwrap();
                    j.settled.insert(permit.session_key, vcum);
                    self.persist(&j);
                    settled_count += 1;
                    tracing::info!(lot = %format!("{:#x}", permit.lot_id), served = vcum, tx = %format!("{tx:#x}"), "spend settled");
                }
                Err(e) => {
                    failures += 1;
                    tracing::warn!(lot = %format!("{:#x}", permit.lot_id), served = vcum, "settleSpend failed (will retry): {e}");
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
            .permits
            .keys()
            .map(|sk| {
                j.voucher.get(sk).map(|v| v.0).unwrap_or(0)
                    - j.settled.get(sk).copied().unwrap_or(0)
            })
            .sum();
        json!({
            "channels": j.permits.len(),
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
    pub session_key: Address,
    pub max_tokens: u64,
    pub expiry: u64,
    /// Holder's EIP-712 signature over the SpendPermit digest, 0x-hex.
    pub holder_sig: String,
}

/// The latest consumer-signed voucher, carried per request. The gateway sets
/// these headers; a vanilla client never sees them.
pub struct VoucherHeader {
    pub session_key: Address,
    pub cumulative: u64,
    pub signature: String,
}

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
        .route("/v1/spend/ack", post(ack))
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

/// Parse the three voucher headers the gateway sets on chat and ack requests.
fn voucher_from_headers(headers: &HeaderMap) -> Result<VoucherHeader, (StatusCode, Value)> {
    let hdr = |k: &str| {
        headers
            .get(k)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };
    let (Some(sk), Some(cum), Some(sig)) = (
        hdr("x-surplus-session"),
        hdr("x-surplus-voucher-cum"),
        hdr("x-surplus-voucher-sig"),
    ) else {
        return Err((
            StatusCode::UNAUTHORIZED,
            oai_err(
                "missing_voucher",
                "Use the surplus gateway; raw clients cannot drive a spend channel.",
            ),
        ));
    };
    let (Ok(session_key), Ok(cumulative)) = (sk.parse::<Address>(), cum.parse::<u64>()) else {
        return Err((
            StatusCode::BAD_REQUEST,
            oai_err("bad_voucher", "bad session/voucher header"),
        ));
    };
    Ok(VoucherHeader {
        session_key,
        cumulative,
        signature: sig,
    })
}

async fn chat(
    State(s): State<SharedSpend>,
    headers: HeaderMap,
    Json(b): Json<ChatBody>,
) -> impl IntoResponse {
    let voucher = match voucher_from_headers(&headers) {
        Ok(v) => v,
        Err((status, body)) => return (status, Json(body)).into_response(),
    };
    match s.complete(voucher, b).await {
        Ok(v) => Json(v).into_response(),
        Err((status, body)) => (status, Json(body)).into_response(),
    }
}

async fn ack(State(s): State<SharedSpend>, headers: HeaderMap) -> impl IntoResponse {
    let voucher = match voucher_from_headers(&headers) {
        Ok(v) => v,
        Err((status, body)) => return (status, Json(body)).into_response(),
    };
    match s.ack(voucher) {
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

/// Background settlement pump for vouchered-but-unsettled spend.
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
                Ok(report) if report["mode"] == "direct" => tracing::info!(%report, "spend flush"),
                Ok(_) => {}
                Err(e) => tracing::warn!("spend flush failed: {e}"),
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Cross-stack pin against contracts/test/Spend.t.sol::test_spendDigestPins —
    /// same fields, same domain (chain 3799, contract 0x1111…), same digests.
    #[test]
    fn digests_match_contract_pin() {
        let settlement: Address = "0x1111111111111111111111111111111111111111"
            .parse()
            .unwrap();
        let session: Address = "0x2222222222222222222222222222222222222222"
            .parse()
            .unwrap();
        let permit = spend_permit_digest(
            U256::from(3799u64),
            settlement,
            keccak256(b"pin-lot"),
            session,
            1_000_000,
            1_800_000_000,
        );
        assert_eq!(
            format!("{permit:#x}"),
            "0xd72728151c11d0185dc7253e7463f04a3e0294ff367a2c6b56f90679aba68209",
            "permit digest drifted from the contract's spendPermitDigest"
        );
        let voucher = spend_voucher_digest(
            U256::from(3799u64),
            settlement,
            keccak256(b"pin-lot"),
            session,
            12_345,
        );
        assert_eq!(
            format!("{voucher:#x}"),
            "0xa75906fa000d678d16c687c32cb65cc2a65cd27e8809c56d9bdf092b92f7d0df",
            "voucher digest drifted from the contract's spendVoucherDigest"
        );
    }
}
