//! Redemption serving — the consumption rail (gate G1), abuse-bounded (G7).
//!
//! A lot holder opens a redemption on-chain (`requestRedemption`); the issuer
//! serves real inference through the Tangle Router and meters it; the holder
//! signs the `RedemptionReceipt`; `settleRedemption` decrements the lot and
//! releases the served notional. Unserved quantity stays redeemable; a missed
//! deadline pays the holder from issuer collateral (`claimDefault`).
//!
//! Serving costs the issuer real router spend, so `/redeem` is HOLDER-GATED:
//! the request carries an EIP-712 `ServeRequest` signature from the lot
//! holder, binding the redemption id, the exact messages payload, the token
//! cap, and an expiry. Knowing a redemptionId (it is public in the
//! `RedemptionRequested` event) is not enough to burn the holder's quota or
//! read their completions, and a captured authorization cannot be replayed.
//!
//! HTTP surface (feature `chain` + `SURPLUS_ROUTER_API_KEY`):
//!   POST /redeem          { redemptionId, messages, maxTokens?, auth } → completion + receipt digest
//!   POST /redeem/receipt  { redemptionId, servedTokens, signature } → settle tx

use surplus_settlement::core::alloy_primitives::{keccak256, Address, B256, U256};
use surplus_settlement::instrument_hash;
use crate::venue::{Venue, VenueError};
use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{json, Value};

/// EIP-712 domain `SurplusServe/1`, bound to the settlement contract + chain so
/// an authorization for one deployment is meaningless on another.
const SERVE_DOMAIN_NAME: &[u8] = b"SurplusServe";
const SERVE_REQUEST_TYPE: &[u8] =
    b"ServeRequest(bytes32 redemptionId,bytes32 messagesHash,uint64 maxTokens,uint64 expiry)";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServeAuth {
    /// Unix seconds; the authorization's TTL (also the replay horizon).
    pub expiry: u64,
    /// Holder's EIP-712 signature over the ServeRequest.
    pub signature: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedeemServeBody {
    pub redemption_id: String,
    /// OpenAI-style messages array. Kept as the raw transmitted bytes: the
    /// signed `messagesHash` is keccak256 of EXACTLY these bytes, so the
    /// payload the holder authorized is the payload that gets served.
    pub messages: Box<RawValue>,
    pub max_tokens: Option<u32>,
    pub auth: ServeAuth,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedeemReceiptBody {
    pub redemption_id: String,
    pub served_tokens: u64,
    /// Holder's signature over `receiptDigest(redemptionId, servedTokens)`.
    pub signature: String,
}

/// keccak256(\x19\x01 ‖ domainSeparator ‖ structHash) for the ServeRequest.
pub fn serve_digest(
    chain_id: U256,
    settlement: Address,
    redemption_id: B256,
    messages_hash: B256,
    max_tokens: u64,
    expiry: u64,
) -> B256 {
    let mut dom = Vec::with_capacity(160);
    dom.extend_from_slice(
        keccak256(b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
            .as_slice(),
    );
    dom.extend_from_slice(keccak256(SERVE_DOMAIN_NAME).as_slice());
    dom.extend_from_slice(keccak256(b"1").as_slice());
    dom.extend_from_slice(&chain_id.to_be_bytes::<32>());
    dom.extend_from_slice(&[0u8; 12]);
    dom.extend_from_slice(settlement.as_slice());
    let domain_separator = keccak256(&dom);

    let mut st = Vec::with_capacity(160);
    st.extend_from_slice(keccak256(SERVE_REQUEST_TYPE).as_slice());
    st.extend_from_slice(redemption_id.as_slice());
    st.extend_from_slice(messages_hash.as_slice());
    st.extend_from_slice(&U256::from(max_tokens).to_be_bytes::<32>());
    st.extend_from_slice(&U256::from(expiry).to_be_bytes::<32>());
    let struct_hash = keccak256(&st);

    let mut out = Vec::with_capacity(66);
    out.extend_from_slice(b"\x19\x01");
    out.extend_from_slice(domain_separator.as_slice());
    out.extend_from_slice(struct_hash.as_slice());
    keccak256(&out)
}

impl Venue {
    /// Serve one inference call against an open redemption of a lot we issued.
    #[cfg(feature = "chain")]
    pub async fn redeem_serve(&self, body: RedeemServeBody) -> Result<Value, VenueError> {
        use surplus_settlement::core::{hex, recover_signer};

        let ctx = self.settle_ctx_pub()?;
        let (rpc, key) = match (ctx.rpc_url.as_deref(), ctx.operator_key.as_deref()) {
            (Some(r), Some(k)) => (r, k),
            _ => return Err(VenueError::SettlementUnconfigured("rpc + operator key")),
        };
        let api_key = std::env::var("SURPLUS_ROUTER_API_KEY")
            .map_err(|_| VenueError::SettlementUnconfigured("SURPLUS_ROUTER_API_KEY"))?;

        let rid: B256 = body
            .redemption_id
            .parse()
            .map_err(|_| VenueError::Rejected("redemptionId is not bytes32".into()))?;
        let now = crate::market::now_unix();
        if body.auth.expiry < now {
            return Err(VenueError::Rejected("serve authorization expired".into()));
        }
        if body.auth.expiry > now + 3600 {
            return Err(VenueError::Rejected("serve authorization expiry too far out".into()));
        }
        let sig = hex::decode(body.auth.signature.trim_start_matches("0x"))
            .map_err(|_| VenueError::Rejected("auth signature is not hex".into()))?;
        let messages_hash = keccak256(body.messages.get().as_bytes());
        let max_tokens = u64::from(body.max_tokens.unwrap_or(0));
        let chain_id = ctx.domain.chain_id.unwrap_or_default();
        let digest = serve_digest(chain_id, ctx.contract, rid, messages_hash, max_tokens, body.auth.expiry);
        let signer = recover_signer(digest, &sig)
            .ok_or_else(|| VenueError::Rejected("unrecoverable auth signature".into()))?;

        let client =
            surplus_settlement::chain::SettlementClient::connect(rpc, key, ctx.contract)
                .await
                .map_err(|e| VenueError::Chain(e.to_string()))?;

        // The redemption must be open, in deadline, holder-authorized, and on a
        // lot WE issued.
        let r = client.get_redemption(rid).await.map_err(|e| VenueError::Chain(e.to_string()))?;
        if r.state != 1 {
            return Err(VenueError::Rejected("redemption is not open".into()));
        }
        if now > r.deadline {
            return Err(VenueError::Rejected("redemption deadline passed".into()));
        }
        if signer != r.holder {
            return Err(VenueError::Rejected("serve authorization is not from the lot holder".into()));
        }
        let lot = client.get_lot(r.lotId).await.map_err(|e| VenueError::Chain(e.to_string()))?;
        let me = ctx
            .operator_address_hex()
            .ok_or(VenueError::SettlementUnconfigured("operator key"))?;
        if format!("{:#x}", lot.issuer).to_lowercase() != me.to_lowercase() {
            return Err(VenueError::Rejected("lot was not issued by this operator".into()));
        }
        // Resolve the instrument (model + token kind) from its on-chain hash.
        let inst = self
            .instruments()
            .into_iter()
            .find(|i| instrument_hash(&i.id) == lot.instrument)
            .ok_or_else(|| VenueError::Rejected("unknown instrument hash on lot".into()))?;

        // Reserve the authorization atomically with the quota check: a digest
        // serves at most once, and two concurrent copies of the same request
        // cannot both pass.
        let already = {
            let mut redeem = self.redeem.lock().unwrap();
            let prog = redeem.entry(body.redemption_id.clone()).or_default();
            if !prog.used_auths.insert(digest) {
                return Err(VenueError::Rejected("serve authorization already used".into()));
            }
            prog.served
        };
        let release_auth = || {
            let mut redeem = self.redeem.lock().unwrap();
            if let Some(prog) = redeem.get_mut(&body.redemption_id) {
                prog.used_auths.remove(&digest);
            }
        };
        let remaining = r.qtyTokens.saturating_sub(already);
        if remaining == 0 {
            release_auth();
            return Err(VenueError::Rejected(
                "redemption quota fully served — submit the receipt".into(),
            ));
        }

        // Serve REAL inference through the Tangle Router with the issuer's key.
        let cap = body.max_tokens.unwrap_or(1024).min(8192);
        let resp = reqwest::Client::new()
            .post(format!("{}/v1/chat/completions", self.cfg.router_url))
            .bearer_auth(&api_key)
            .json(&json!({
                "model": inst.model_id,
                "messages": body.messages,
                "max_tokens": cap,
            }))
            .timeout(std::time::Duration::from_secs(120))
            .send()
            .await;
        let resp = match resp {
            Ok(r) => r,
            Err(e) => {
                release_auth();
                return Err(VenueError::Chain(format!("router: {e}")));
            }
        };
        let status = resp.status();
        let completion: Value = match resp.json().await {
            Ok(v) => v,
            Err(e) => {
                release_auth();
                return Err(VenueError::Chain(format!("router body: {e}")));
            }
        };
        if !status.is_success() {
            release_auth();
            return Err(VenueError::Rejected(format!("router {status}: {completion}")));
        }

        // Meter the lot's token kind; never serve past the redemption quota.
        let usage_key =
            if inst.token_kind == "input" { "prompt_tokens" } else { "completion_tokens" };
        let used = completion
            .get("usage")
            .and_then(|u| u.get(usage_key))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let served_now = used.min(remaining);
        let total = already + served_now;
        {
            let mut redeem = self.redeem.lock().unwrap();
            redeem.entry(body.redemption_id.clone()).or_default().served = total;
        }

        let digest = client
            .receipt_digest(rid, total)
            .await
            .map_err(|e| VenueError::Chain(e.to_string()))?;

        Ok(json!({
            "completion": completion,
            "instrumentId": inst.id,
            "meteredTokens": used,
            "servedTokens": served_now,
            "totalServedTokens": total,
            "remainingQuota": r.qtyTokens - total,
            "receiptDigest": format!("{digest:#x}"),
            "holder": format!("{:#x}", r.holder),
            "deadline": r.deadline,
            "hint": "sign receiptDigest with the holder key and POST /redeem/receipt",
        }))
    }

    /// Submit the holder's signed receipt; settles the redemption on-chain.
    #[cfg(feature = "chain")]
    pub async fn redeem_receipt(&self, body: RedeemReceiptBody) -> Result<Value, VenueError> {
        use surplus_settlement::core::hex;

        let ctx = self.settle_ctx_pub()?;
        let (rpc, key) = match (ctx.rpc_url.as_deref(), ctx.operator_key.as_deref()) {
            (Some(r), Some(k)) => (r, k),
            _ => return Err(VenueError::SettlementUnconfigured("rpc + operator key")),
        };
        let rid: B256 = body
            .redemption_id
            .parse()
            .map_err(|_| VenueError::Rejected("redemptionId is not bytes32".into()))?;
        let sig = hex::decode(body.signature.trim_start_matches("0x"))
            .map_err(|_| VenueError::Rejected("signature is not hex".into()))?;

        let client =
            surplus_settlement::chain::SettlementClient::connect(rpc, key, ctx.contract)
                .await
                .map_err(|e| VenueError::Chain(e.to_string()))?;
        client
            .settle_redemption(rid, body.served_tokens, sig)
            .await
            .map_err(|e| VenueError::Chain(e.to_string()))?;
        self.redeem.lock().unwrap().remove(&body.redemption_id);

        Ok(json!({ "ok": true, "redemptionId": body.redemption_id, "servedTokens": body.served_tokens }))
    }

    #[cfg(not(feature = "chain"))]
    pub async fn redeem_serve(&self, _body: RedeemServeBody) -> Result<Value, VenueError> {
        Err(VenueError::SettlementUnconfigured("build with --features chain"))
    }

    #[cfg(not(feature = "chain"))]
    pub async fn redeem_receipt(&self, _body: RedeemReceiptBody) -> Result<Value, VenueError> {
        Err(VenueError::SettlementUnconfigured("build with --features chain"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use surplus_settlement::core::recover_signer;
    use surplus_settlement::Signer;

    #[test]
    fn serve_digest_signs_and_recovers() {
        let signer = Signer::from_hex(
            "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
        )
        .unwrap();
        let rid = B256::repeat_byte(0x11);
        let mh = keccak256(br#"[{"role":"user","content":"hi"}]"#);
        let settlement: Address =
            "0x1cD49739e9CF48C4906aDb44021dd8cE0d8aBa64".parse().unwrap();
        let digest = serve_digest(U256::from(84532u64), settlement, rid, mh, 200, 1_900_000_000);
        let sig = signer.sign_digest(digest);
        assert_eq!(recover_signer(digest, &sig), Some(signer.address()));

        // Every signed field perturbs the digest.
        let variants = [
            serve_digest(U256::from(1u64), settlement, rid, mh, 200, 1_900_000_000),
            serve_digest(U256::from(84532u64), Address::ZERO, rid, mh, 200, 1_900_000_000),
            serve_digest(U256::from(84532u64), settlement, B256::ZERO, mh, 200, 1_900_000_000),
            serve_digest(U256::from(84532u64), settlement, rid, B256::ZERO, 200, 1_900_000_000),
            serve_digest(U256::from(84532u64), settlement, rid, mh, 201, 1_900_000_000),
            serve_digest(U256::from(84532u64), settlement, rid, mh, 200, 1_900_000_001),
        ];
        for v in variants {
            assert_ne!(v, digest);
        }
    }
}
