//! Redemption serving — the consumption rail (gate G1).
//!
//! A lot holder opens a redemption on-chain (`requestRedemption`); the issuer
//! serves real inference through the Tangle Router and meters it; the holder
//! signs the `RedemptionReceipt`; `settleRedemption` decrements the lot and
//! releases the served notional. Unserved quantity stays redeemable; a missed
//! deadline pays the holder from issuer collateral (`claimDefault`).
//!
//! HTTP surface (feature `chain` + `SURPLUS_ROUTER_API_KEY`):
//!   POST /redeem          { redemptionId, messages, maxTokens? } → completion + receipt digest
//!   POST /redeem/receipt  { redemptionId, servedTokens, signature } → settle tx

use surplus_settlement::instrument_hash;
use surplus_settlement::core::alloy_primitives::B256;
use crate::venue::{Venue, VenueError};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedeemServeBody {
    pub redemption_id: String,
    /// OpenAI-style messages array, passed through to the router verbatim.
    pub messages: Value,
    pub max_tokens: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedeemReceiptBody {
    pub redemption_id: String,
    pub served_tokens: u64,
    /// Holder's signature over `receiptDigest(redemptionId, servedTokens)`.
    pub signature: String,
}

impl Venue {
    /// Serve one inference call against an open redemption of a lot we issued.
    #[cfg(feature = "chain")]
    pub async fn redeem_serve(&self, body: RedeemServeBody) -> Result<Value, VenueError> {
        use surplus_settlement::core::hex;

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

        let client =
            surplus_settlement::chain::SettlementClient::connect(rpc, key, ctx.contract)
                .await
                .map_err(|e| VenueError::Chain(e.to_string()))?;

        // The redemption must be open, in deadline, and on a lot WE issued.
        let r = client.get_redemption(rid).await.map_err(|e| VenueError::Chain(e.to_string()))?;
        if r.state != 1 {
            return Err(VenueError::Rejected("redemption is not open".into()));
        }
        let now = crate::market::now_unix();
        if now > r.deadline {
            return Err(VenueError::Rejected("redemption deadline passed".into()));
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

        let already = {
            let served = self.redeem_served.lock().unwrap();
            *served.get(&body.redemption_id).unwrap_or(&0)
        };
        let remaining = r.qtyTokens.saturating_sub(already);
        if remaining == 0 {
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
            .await
            .map_err(|e| VenueError::Chain(format!("router: {e}")))?;
        let status = resp.status();
        let completion: Value = resp
            .json()
            .await
            .map_err(|e| VenueError::Chain(format!("router body: {e}")))?;
        if !status.is_success() {
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
            let mut served = self.redeem_served.lock().unwrap();
            served.insert(body.redemption_id.clone(), total);
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
        self.redeem_served.lock().unwrap().remove(&body.redemption_id);

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
