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
use inference_bazaar_settlement::core::alloy_primitives::{keccak256, Address, B256, U256};
use inference_bazaar_settlement::core::hex;

use crate::venue::{Venue, VenueError};

/// Never serve within this margin of the permit's or lot's expiry: the
/// settlement transaction must still land before either clock runs out.
const SPEND_EXPIRY_MARGIN_SECS: u64 = 120;
/// Per-request completion cap, mirroring `/redeem`.
const MAX_TOKENS_PER_REQUEST: u32 = 8192;
/// How far in the future a signed usage query may be dated — bounds replay of a
/// captured `/v1/usage` signature to a short window.
const USAGE_QUERY_MAX_AGE_SECS: u64 = 600;

// ─────────────────────────────── Digests ─────────────────────────────────────

const PERMIT_TYPE: &[u8] =
    b"SpendPermit(bytes32 lotId,address sessionKey,uint64 maxTokens,uint64 expiry)";
const VOUCHER_TYPE: &[u8] =
    b"SpendVoucher(bytes32 lotId,address sessionKey,uint64 servedCumulative)";
/// Off-chain only (no contract counterpart): the message a holder signs to read
/// their own spend on a venue. Bound to the settlement domain so a signature
/// can't be replayed against a different deployment.
const USAGE_QUERY_TYPE: &[u8] = b"UsageQuery(address holder,uint64 expiry)";

fn settlement_domain_separator(chain_id: U256, settlement: Address) -> B256 {
    let mut dom = Vec::with_capacity(160);
    dom.extend_from_slice(
        keccak256(
            b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
        )
        .as_slice(),
    );
    dom.extend_from_slice(keccak256(b"InferenceBazaarSettlement").as_slice());
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

/// The digest a HOLDER signs to read their own spend on a venue. Off-chain only,
/// but bound to the settlement domain (chain + contract) so the signature is
/// non-replayable across deployments.
pub fn usage_query_digest(
    chain_id: U256,
    settlement: Address,
    holder: Address,
    expiry: u64,
) -> B256 {
    let mut st = Vec::with_capacity(96);
    st.extend_from_slice(keccak256(USAGE_QUERY_TYPE).as_slice());
    st.extend_from_slice(&[0u8; 12]);
    st.extend_from_slice(holder.as_slice());
    st.extend_from_slice(&U256::from(expiry).to_be_bytes::<32>());
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
    /// Set once the deployed contract's EIP-712 domain separator has been verified
    /// against this node's. For a spend-only operator (no CLOB/direct fills) the
    /// spend flush is the sole chain path, so it must fail closed on domain drift.
    domain_checked: std::sync::atomic::AtomicBool,
}

pub type SharedSpend = Arc<SpendSvc>;

fn journal_path() -> Option<std::path::PathBuf> {
    std::env::var("DATA_DIR")
        .or_else(|_| std::env::var("INFERENCE_BAZAAR_DATA_DIR"))
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
            domain_checked: std::sync::atomic::AtomicBool::new(false),
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
        use inference_bazaar_settlement::core::recover_signer;

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
            inference_bazaar_settlement::chain::SettlementClient::connect(rpc, op_key, ctx.contract)
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
            .find(|i| inference_bazaar_settlement::instrument_hash(&i.id) == lot.instrument)
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
        crate::metrics::inc(crate::metrics::names::SPEND_KEYS);
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

    /// Shared money-path gate for BOTH the buffered and streamed serve paths, so
    /// they cannot diverge. Verifies the voucher (per-request possession proof AND
    /// payment ack — session-signed, monotone, within cap), enforces expiry/quota/
    /// model, records the voucher as the latest settleable proof, and returns
    /// `(permit, already_served, per-request cap)`. Both paths meter identically
    /// afterwards via `record_served`.
    fn authorize(
        &self,
        voucher: &VoucherHeader,
        body: &ChatBody,
    ) -> Result<(StoredPermit, u64, u32), (StatusCode, Value)> {
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
        if inference_bazaar_settlement::core::recover_signer(vdigest, &vsig) != Some(permit.session_key) {
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
        Ok((permit, already_served, cap))
    }

    /// Meter served tokens into the journal — money-shaped state, persisted.
    fn record_served(&self, session: Address, total: u64, used: u64) {
        let mut j = self.state.lock().unwrap();
        j.served.insert(session, total);
        crate::metrics::inc_by(crate::metrics::names::SPEND_SERVED_TOKENS, used);
        self.persist(&j);
    }

    /// One buffered OpenAI-compatible chat completion billed to a spend channel.
    pub async fn complete(
        &self,
        voucher: VoucherHeader,
        body: ChatBody,
    ) -> Result<Value, (StatusCode, Value)> {
        let (permit, already_served, cap) = self.authorize(&voucher, &body)?;
        let remaining = permit.max_tokens.saturating_sub(already_served);
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

        let used = completion
            .get("usage")
            .and_then(|u| u.get(usage_key(&permit)))
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(remaining);
        let total = already_served + used;
        self.record_served(permit.session_key, total, used);

        // The gateway should now sign a voucher for `nextCumulative` so this
        // request becomes settleable; until it does, this request is our exposure.
        let mut out = completion;
        if let Some(obj) = out.as_object_mut() {
            obj.insert(
                "inference-bazaar".into(),
                json!({ "servedTokens": used, "nextCumulative": total }),
            );
        }
        Ok(out)
    }

    /// One STREAMED chat completion (`stream: true`): forward the upstream's SSE
    /// chunks token-by-token while tee-ing the final `usage` chunk to meter, then
    /// emit a private `inference-bazaar` event (the gateway consumes+strips it to advance
    /// its voucher) followed by `[DONE]`. Billing is identical to the buffered
    /// path — authorization, cap, and metering go through the same gates.
    pub async fn complete_stream(
        self: &SharedSpend,
        voucher: VoucherHeader,
        body: ChatBody,
    ) -> Result<axum::response::Response, (StatusCode, Value)> {
        use futures::StreamExt;
        let (permit, already_served, cap) = self.authorize(&voucher, &body)?;
        let resp = self
            .venue
            .inference
            .chat_completion_stream(&permit.model_id, &body.messages, cap)
            .await
            .map_err(|e| (StatusCode::BAD_GATEWAY, oai_err("upstream", &e)))?;
        if !resp.status().is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err((StatusCode::BAD_GATEWAY, oai_err("upstream", &text)));
        }

        let remaining = permit.max_tokens.saturating_sub(already_served);
        let session = permit.session_key;
        let key = usage_key(&permit);
        let svc = std::sync::Arc::clone(self);
        let (tx, rx) =
            futures::channel::mpsc::unbounded::<Result<axum::body::Bytes, std::io::Error>>();

        tokio::spawn(async move {
            let mut stream = resp.bytes_stream();
            let mut pending = String::new();
            let mut used: u64 = 0;
            let mut finalized = false;
            'read: while let Some(chunk) = stream.next().await {
                let Ok(bytes) = chunk else { break };
                pending.push_str(&String::from_utf8_lossy(&bytes));
                while let Some(idx) = pending.find("\n\n") {
                    let event: String = pending.drain(..idx + 2).collect();
                    let data = event
                        .lines()
                        .find_map(|l| l.strip_prefix("data:").map(str::trim));
                    match data {
                        Some("[DONE]") => {
                            let u = used.min(remaining);
                            svc.record_served(session, already_served + u, u);
                            let _ = tx.unbounded_send(Ok(inference_bazaar_event(u, already_served + u)));
                            let _ =
                                tx.unbounded_send(Ok(axum::body::Bytes::from_static(DONE_EVENT)));
                            finalized = true;
                            break 'read;
                        }
                        Some(json_str) => {
                            // Tee: capture usage from the final chunk; forward the
                            // chunk to the client verbatim (token-by-token).
                            if let Ok(v) = serde_json::from_str::<Value>(json_str) {
                                if let Some(n) = v
                                    .get("usage")
                                    .and_then(|x| x.get(key))
                                    .and_then(Value::as_u64)
                                {
                                    used = n;
                                }
                            }
                            let _ = tx.unbounded_send(Ok(event.into_bytes().into()));
                        }
                        None => {
                            let _ = tx.unbounded_send(Ok(event.into_bytes().into()));
                        }
                    }
                }
            }
            // Upstream ended without an explicit [DONE] (or errored mid-stream):
            // meter what we saw and close the SSE so the client/gateway terminate.
            if !finalized {
                let u = used.min(remaining);
                svc.record_served(session, already_served + u, u);
                let _ = tx.unbounded_send(Ok(inference_bazaar_event(u, already_served + u)));
                let _ = tx.unbounded_send(Ok(axum::body::Bytes::from_static(DONE_EVENT)));
            }
        });

        axum::response::Response::builder()
            .header("content-type", "text/event-stream")
            .header("cache-control", "no-cache")
            .body(axum::body::Body::from_stream(rx))
            .map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    oai_err("stream", &e.to_string()),
                )
            })
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
        if inference_bazaar_settlement::core::recover_signer(vdigest, &vsig) != Some(permit.session_key) {
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
            .map(|i| json!({ "id": i.model_id, "object": "model", "owned_by": "inference-bazaar" }))
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
                    json!({ "mode": "dry", "hint": "set INFERENCE_BAZAAR_RPC_URL + INFERENCE_BAZAAR_SUBMITTER_KEY" }),
                )
            }
        };
        // Cheap exit (no RPC) when there are no channels at all: nothing to settle
        // and nothing to reconcile. We connect whenever channels exist — even with
        // no pending vouchers — so on-chain revocation/resale is honored on idle
        // channels too.
        let has_channels = { !self.state.lock().unwrap().permits.is_empty() };
        if !has_channels {
            return Ok(json!({ "mode": "noop", "settled": 0 }));
        }
        let client =
            inference_bazaar_settlement::chain::SettlementClient::connect(rpc, op_key, ctx.contract)
                .await
                .map_err(|e| VenueError::Chain(e.to_string()))?;
        // Verify the on-chain domain separator once before settling — a wrong chain
        // id / contract address would make every settleSpend digest unverifiable.
        if !self
            .domain_checked
            .load(std::sync::atomic::Ordering::Relaxed)
        {
            client
                .assert_domain()
                .await
                .map_err(|e| VenueError::Chain(e.to_string()))?;
            self.domain_checked
                .store(true, std::sync::atomic::Ordering::Relaxed);
        }
        // Mirror on-chain revocation/resale BEFORE settling: drop any channel the
        // holder revoked or whose lot changed hands, so the serve path stops
        // accepting it (settleSpend would revert → unbillable inference). The
        // free-serve window is bounded to one flush interval — this is the doc's
        // "operator must mirror these checks before serving" (spend-rail.md).
        let dropped = self.reconcile_revocations(&client).await;
        // Build pending AFTER reconciliation so we never attempt to settle a
        // just-dropped (revoked/resold) channel.
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
                    let delta = vcum - j.settled.get(&permit.session_key).copied().unwrap_or(0);
                    j.settled.insert(permit.session_key, vcum);
                    crate::metrics::inc_by(crate::metrics::names::SPEND_SETTLED_TOKENS, delta);
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
        Ok(
            json!({ "mode": "direct", "settled": settled_count, "failed": failures, "dropped": dropped.len() }),
        )
    }

    /// Drop any spend channel the holder revoked on-chain (`revokeSpendKey`) or
    /// whose lot was resold (current `lot.holder` no longer matches the permit's
    /// holder). For both, `settleSpend` reverts — `SpendKeyIsRevoked` / `BadSpendAuth`
    /// — so continuing to serve is unbillable (free) inference. On a transient RPC
    /// error we keep the channel (fail-open on uncertainty so a flaky node never
    /// nukes live channels); the next flush re-checks. Returns the dropped session
    /// keys so the caller can exclude them from the settle pass.
    #[cfg(feature = "chain")]
    async fn reconcile_revocations(
        &self,
        client: &inference_bazaar_settlement::chain::SettlementClient,
    ) -> Vec<Address> {
        let Ok(ctx) = self.venue.settle_ctx_pub() else {
            return Vec::new();
        };
        let chain_id = ctx.domain.chain_id.unwrap_or_default();
        let permits: Vec<StoredPermit> = {
            let j = self.state.lock().unwrap();
            j.permits.values().cloned().collect()
        };
        let mut dead: Vec<(Address, B256, bool, bool)> = Vec::new();
        for p in permits {
            let pd = spend_permit_digest(
                chain_id,
                ctx.contract,
                p.lot_id,
                p.session_key,
                p.max_tokens,
                p.expiry,
            );
            let revoked = match client.spend_revoked(pd).await {
                Ok(v) => v,
                Err(_) => continue, // transient: re-check next flush
            };
            let resold = match client.get_lot(p.lot_id).await {
                Ok(lot) => lot.holder != p.holder,
                Err(_) => continue,
            };
            if revoked || resold {
                dead.push((p.session_key, p.lot_id, revoked, resold));
            }
        }
        if dead.is_empty() {
            return Vec::new();
        }
        let mut sessions = Vec::with_capacity(dead.len());
        {
            let mut j = self.state.lock().unwrap();
            for (sk, lot_id, revoked, resold) in &dead {
                j.permits.remove(sk);
                j.voucher.remove(sk);
                j.served.remove(sk);
                j.settled.remove(sk);
                sessions.push(*sk);
                tracing::warn!(
                    lot = %format!("{:#x}", lot_id),
                    revoked, resold,
                    "spend channel dropped — refusing further service (settleSpend would revert)"
                );
            }
            self.persist(&j);
        }
        sessions
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

    /// A holder-authenticated read of their live spend on THIS venue. The holder
    /// signs a short-lived `UsageQuery { holder, expiry }`; we return per-lot
    /// metered/settled counters for every channel they opened here. This is the
    /// real-time meter — `served` runs ahead of on-chain `settled` by exactly the
    /// in-flight, vouchered-but-unsettled tokens, which the app can't see from the
    /// chain alone. The signature is the gate: no signature, no read, and a holder
    /// can only ever see their own channels (never another holder's).
    pub fn usage(
        &self,
        holder: Address,
        expiry: u64,
        sig_hex: &str,
    ) -> Result<Value, (StatusCode, Value)> {
        let ctx = self.venue.settle_ctx_pub().map_err(|_| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                oai_err("unconfigured", "settlement not configured"),
            )
        })?;
        let now = Self::now();
        if expiry <= now {
            return Err((
                StatusCode::UNAUTHORIZED,
                oai_err("expired_query", "usage query has expired"),
            ));
        }
        if expiry > now + USAGE_QUERY_MAX_AGE_SECS {
            return Err((
                StatusCode::BAD_REQUEST,
                oai_err("bad_query", "usage query expiry is too far out"),
            ));
        }
        let sig = hex::decode(sig_hex.trim_start_matches("0x"))
            .map_err(|_| (StatusCode::BAD_REQUEST, oai_err("bad_sig", "signature is not hex")))?;
        let chain_id = ctx.domain.chain_id.unwrap_or_default();
        let digest = usage_query_digest(chain_id, ctx.contract, holder, expiry);
        if inference_bazaar_settlement::core::recover_signer(digest, &sig) != Some(holder) {
            return Err((
                StatusCode::UNAUTHORIZED,
                oai_err("bad_sig", "query not signed by the holder"),
            ));
        }
        let j = self.state.lock().unwrap();
        Ok(usage_rows(&j, holder))
    }
}

/// Pure projection of one holder's channels out of the journal — separated from
/// `usage` so it's testable without a venue or a live signature. `served` is the
/// live meter; `settled` is on-chain truth; their difference is in-flight.
fn usage_rows(j: &SpendJournal, holder: Address) -> Value {
    let mut lots = Vec::new();
    let (mut t_max, mut t_served, mut t_settled) = (0u64, 0u64, 0u64);
    for (sk, p) in j.permits.iter() {
        if p.holder != holder {
            continue;
        }
        let served = j.served.get(sk).copied().unwrap_or(0);
        let settled = j.settled.get(sk).copied().unwrap_or(0);
        t_max += p.max_tokens;
        t_served += served;
        t_settled += settled;
        lots.push(json!({
            "lotId": format!("{:#x}", p.lot_id),
            "sessionKey": format!("{:#x}", sk),
            "model": p.model_id,
            "instrument": p.instrument_id,
            "maxTokens": p.max_tokens,
            "servedTokens": served,
            "settledTokens": settled,
            "inflightTokens": served.saturating_sub(settled),
            "remainingTokens": p.max_tokens.saturating_sub(served),
            "expiry": p.expiry,
        }));
    }
    json!({
        "holder": format!("{:#x}", holder),
        "channels": lots.len(),
        "totals": {
            "maxTokens": t_max,
            "servedTokens": t_served,
            "settledTokens": t_settled,
            "inflightTokens": t_served.saturating_sub(t_settled),
            "remainingTokens": t_max.saturating_sub(t_served),
        },
        "lots": lots,
    })
}

/// OpenAI-style error envelope so SDKs surface the message verbatim.
fn oai_err(code: &str, message: &str) -> Value {
    json!({ "error": { "type": code, "code": code, "message": message } })
}

/// Which `usage` field bills this channel — the lot's token kind.
fn usage_key(permit: &StoredPermit) -> &'static str {
    if permit.token_kind == "input" {
        "prompt_tokens"
    } else {
        "completion_tokens"
    }
}

/// The streamed SSE terminator the client's OpenAI SDK stops on.
const DONE_EVENT: &[u8] = b"data: [DONE]\n\n";

/// The operator's private settlement event, injected into the stream right before
/// `[DONE]`. The gateway parses it to advance its voucher and STRIPS it, so the
/// developer's vanilla OpenAI client never sees it.
fn inference_bazaar_event(served: u64, next: u64) -> axum::body::Bytes {
    format!("data: {{\"inference-bazaar\":{{\"servedTokens\":{served},\"nextCumulative\":{next}}}}}\n\n")
        .into_bytes()
        .into()
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageBody {
    pub holder: Address,
    pub expiry: u64,
    /// Holder's EIP-712 signature over the UsageQuery digest, 0x-hex.
    pub sig: String,
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
        .route("/v1/usage", post(usage_handler))
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
        hdr("x-inference-bazaar-session"),
        hdr("x-inference-bazaar-voucher-cum"),
        hdr("x-inference-bazaar-voucher-sig"),
    ) else {
        return Err((
            StatusCode::UNAUTHORIZED,
            oai_err(
                "missing_voucher",
                "Use the inference-bazaar gateway; raw clients cannot drive a spend channel.",
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
    if b.stream.unwrap_or(false) {
        match s.complete_stream(voucher, b).await {
            Ok(resp) => resp,
            Err((status, body)) => (status, Json(body)).into_response(),
        }
    } else {
        match s.complete(voucher, b).await {
            Ok(v) => Json(v).into_response(),
            Err((status, body)) => (status, Json(body)).into_response(),
        }
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

/// The developer-facing meter: a holder's own live spend across the channels
/// they opened here. Holder-authenticated (signed `UsageQuery`); reachable
/// through the venue's privacy front like every other `/v1/*` route.
async fn usage_handler(
    State(s): State<SharedSpend>,
    Json(b): Json<UsageBody>,
) -> impl IntoResponse {
    match s.usage(b.holder, b.expiry, &b.sig) {
        Ok(v) => Json(v).into_response(),
        Err((code, v)) => (code, Json(v)).into_response(),
    }
}

async fn spend_flush(State(s): State<SharedSpend>) -> impl IntoResponse {
    match s.flush().await {
        Ok(v) => Json(v).into_response(),
        Err(e) => (crate::http::err_status_pub(&e), e.to_string()).into_response(),
    }
}

/// Background settlement pump for vouchered-but-unsettled spend.
pub fn spawn_spend_flush(svc: SharedSpend) {
    let interval = std::env::var("INFERENCE_BAZAAR_FLUSH_INTERVAL_SECS")
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
            "0xd915cc914ae9c69618ef09dbdeb9d9626922d546624d48352e3583b5adcc1856",
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
            "0x8ea3a19053e267d4ef473ea2e9c3c04bd8a381915437467dbc53b20e3b843559",
            "voucher digest drifted from the contract's spendVoucherDigest"
        );
    }

    fn permit_for(holder: Address, session: Address, max_tokens: u64) -> StoredPermit {
        StoredPermit {
            lot_id: keccak256(session.as_slice()),
            session_key: session,
            max_tokens,
            expiry: 1_800_000_000,
            holder_sig: String::new(),
            holder,
            instrument_id: "anthropic/claude-opus-4-8:output".into(),
            model_id: "anthropic/claude-opus-4-8".into(),
            token_kind: "output".into(),
        }
    }

    /// usage_rows returns ONLY the queried holder's channels and reports
    /// in-flight = served − settled.
    #[test]
    fn usage_rows_are_per_holder_and_report_inflight() {
        let me: Address = "0x1111111111111111111111111111111111111111".parse().unwrap();
        let other: Address = "0x2222222222222222222222222222222222222222".parse().unwrap();
        let s_a: Address = "0xaaaa000000000000000000000000000000000000".parse().unwrap();
        let s_b: Address = "0xbbbb000000000000000000000000000000000000".parse().unwrap();
        let s_c: Address = "0xcccc000000000000000000000000000000000000".parse().unwrap();

        let mut j = SpendJournal::default();
        j.permits.insert(s_a, permit_for(me, s_a, 1_000));
        j.permits.insert(s_b, permit_for(me, s_b, 4_000));
        j.permits.insert(s_c, permit_for(other, s_c, 9_000));
        j.served.insert(s_a, 600);
        j.settled.insert(s_a, 500);
        j.served.insert(s_b, 1_000);
        j.settled.insert(s_b, 1_000);
        j.served.insert(s_c, 7_000); // other holder — must not leak in

        let v = usage_rows(&j, me);
        assert_eq!(v["channels"], 2, "only the holder's two channels");
        assert_eq!(v["totals"]["maxTokens"], 5_000);
        assert_eq!(v["totals"]["servedTokens"], 1_600);
        assert_eq!(v["totals"]["settledTokens"], 1_500);
        assert_eq!(v["totals"]["inflightTokens"], 100, "served − settled");
        assert_eq!(v["totals"]["remainingTokens"], 3_400, "max − served");
        let lots = v["lots"].as_array().unwrap();
        assert!(
            lots.iter().all(|l| l["sessionKey"] != format!("{s_c:#x}")),
            "another holder's channel must never appear"
        );
    }

    /// The usage digest is stable and distinct from the permit/voucher digests
    /// over the same domain, so signatures can't be cross-used.
    #[test]
    fn usage_query_digest_is_distinct() {
        let settlement: Address = "0x1111111111111111111111111111111111111111".parse().unwrap();
        let holder: Address = "0x3333333333333333333333333333333333333333".parse().unwrap();
        let d = usage_query_digest(U256::from(3799u64), settlement, holder, 1_800_000_000);
        let permit = spend_permit_digest(
            U256::from(3799u64),
            settlement,
            keccak256(holder.as_slice()),
            holder,
            1_000_000,
            1_800_000_000,
        );
        assert_ne!(d, permit, "usage digest must not collide with permit digest");
    }
}
