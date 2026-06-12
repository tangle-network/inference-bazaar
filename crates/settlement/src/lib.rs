//! Host-side settlement for the Surplus market.
//!
//! The venue matches *signed firm orders* (EIP-712 `Order`s — CLOB orders and
//! RFQ quotes alike) and joins each book fill back to the two signatures that
//! authorized it. The result, a [`SignedFill`], is the atomic unit the
//! `SurplusSettlement` contract clears trustlessly. Batching and attester
//! quorums compress that path; the digests live in `surplus-settlement-core`
//! so the SP1 guest proves the very same bytes.

pub use surplus_settlement_core as core;
pub use surplus_settlement_core::{
    batch_digest, batch_public_values, cost_micro, domain, fills_hash, instrument_hash,
    order_digest, receipt_digest, recover_signer, validate_pair, verify_order, BatchFill,
    Eip712Domain, Order, PairError, SIDE_BUY, SIDE_SELL,
};

use alloy_primitives::{keccak256, Address, B256};
use serde::{Deserialize, Serialize};

#[cfg(feature = "chain")]
pub mod chain;

// ─────────────────────────────── Signed orders ───────────────────────────────

/// A firm order plus the 65-byte signature that makes it settleable.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignedOrder {
    pub order: Order,
    /// `r || s || v`, hex `0x…` over JSON.
    #[serde(with = "hex_bytes")]
    pub signature: Vec<u8>,
}

impl SignedOrder {
    pub fn digest(&self, domain: &Eip712Domain) -> B256 {
        order_digest(&self.order, domain)
    }

    pub fn verify(&self, domain: &Eip712Domain) -> bool {
        verify_order(&self.order, &self.signature, domain)
    }
}

/// Two mutually-signed orders crossed at `exec_price` — the atomic settlement unit.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedFill {
    pub buy: SignedOrder,
    pub sell: SignedOrder,
    pub qty_tokens: u64,
    pub exec_price_micro_per_m: u64,
}

impl SignedFill {
    /// Pair a maker and taker after a cross. Validates signatures and the
    /// stateless pair rules; execution at the maker's price is the venue's
    /// policy and is enforced here by construction.
    pub fn pair(
        maker: SignedOrder,
        taker: SignedOrder,
        qty: u64,
        now_unix: u64,
        domain: &Eip712Domain,
    ) -> Result<SignedFill, FillError> {
        let exec_price = maker.order.priceMicroPerM;
        let (buy, sell) = match (taker.order.side, maker.order.side) {
            (SIDE_BUY, SIDE_SELL) => (taker, maker),
            (SIDE_SELL, SIDE_BUY) => (maker, taker),
            _ => return Err(FillError::Pair(PairError::InvalidOrderPair)),
        };
        if !buy.verify(domain) {
            return Err(FillError::BadSignature(buy.digest(domain)));
        }
        if !sell.verify(domain) {
            return Err(FillError::BadSignature(sell.digest(domain)));
        }
        validate_pair(&buy.order, &sell.order, qty, exec_price, now_unix)
            .map_err(FillError::Pair)?;
        Ok(SignedFill {
            buy,
            sell,
            qty_tokens: qty,
            exec_price_micro_per_m: exec_price,
        })
    }

    pub fn batch_fill(&self) -> BatchFill {
        BatchFill {
            buy: self.buy.order.clone(),
            sell: self.sell.order.clone(),
            qtyTokens: self.qty_tokens,
            execPriceMicroPerM: self.exec_price_micro_per_m,
        }
    }

    pub fn cost_micro(&self) -> u128 {
        cost_micro(self.exec_price_micro_per_m, self.qty_tokens).to::<u128>()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum FillError {
    #[error("invalid pair: {0:?}")]
    Pair(PairError),
    #[error("bad signature for order {0}")]
    BadSignature(B256),
}

// ─────────────────────────────────── Signer ──────────────────────────────────

/// secp256k1 signer for orders, receipts, and batch attestations.
pub struct Signer {
    key: k256::ecdsa::SigningKey,
    address: Address,
}

impl Signer {
    pub fn from_hex(hex_key: &str) -> Result<Self, SignerError> {
        let raw = alloy_primitives::hex::decode(hex_key.trim_start_matches("0x"))
            .map_err(|_| SignerError::BadKey)?;
        let key = k256::ecdsa::SigningKey::from_slice(&raw).map_err(|_| SignerError::BadKey)?;
        let encoded = key.verifying_key().to_encoded_point(false);
        let address = Address::from_slice(&keccak256(&encoded.as_bytes()[1..])[12..]);
        Ok(Signer { key, address })
    }

    pub fn address(&self) -> Address {
        self.address
    }

    pub fn sign_digest(&self, digest: B256) -> [u8; 65] {
        let (sig, rec) = self
            .key
            .sign_prehash_recoverable(digest.as_slice())
            .expect("prehash signing cannot fail on a 32-byte digest");
        let mut out = [0u8; 65];
        out[..64].copy_from_slice(&sig.to_bytes());
        out[64] = 27 + rec.to_byte();
        out
    }

    pub fn sign_order(&self, order: &Order, domain: &Eip712Domain) -> SignedOrder {
        debug_assert_eq!(
            order.trader, self.address,
            "order.trader must be the signer"
        );
        SignedOrder {
            signature: self.sign_digest(order_digest(order, domain)).to_vec(),
            order: order.clone(),
        }
    }

    pub fn sign_receipt(
        &self,
        redemption_id: B256,
        served: u64,
        domain: &Eip712Domain,
    ) -> [u8; 65] {
        self.sign_digest(receipt_digest(redemption_id, served, domain))
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SignerError {
    #[error("invalid secp256k1 private key")]
    BadKey,
}

// ─────────────────────────────────── Batches ─────────────────────────────────

/// Accumulates signed fills into a submission for any of the three settlement
/// paths: `settleFills` (signatures inline), `settleBatchAttested` (quorum over
/// the batch digest), or `settleBatchProven` (SP1 proof over the same fills).
#[derive(Default, Debug, Clone, Serialize, Deserialize)]
pub struct Batch {
    pub fills: Vec<SignedFill>,
}

impl Batch {
    pub fn push(&mut self, fill: SignedFill) {
        self.fills.push(fill);
    }

    pub fn is_empty(&self) -> bool {
        self.fills.is_empty()
    }

    pub fn len(&self) -> usize {
        self.fills.len()
    }

    pub fn batch_fills(&self) -> Vec<BatchFill> {
        self.fills.iter().map(SignedFill::batch_fill).collect()
    }

    pub fn fills_hash(&self) -> B256 {
        fills_hash(&self.batch_fills())
    }

    /// Digest an attester signs for `settleBatchAttested(fills, sigs)` at the
    /// given on-chain `batchNonce`.
    pub fn attestation_digest(&self, batch_nonce: u64, domain: &Eip712Domain) -> B256 {
        batch_digest(batch_nonce, self.fills_hash(), domain)
    }
}

// ─────────────────────────────── Attester quorum ─────────────────────────────

/// Mirror of the contract's `_verifyQuorum`: recovered signers strictly
/// ascending, every signer in the set, at least `threshold` signatures.
pub fn verify_quorum(
    digest: B256,
    sigs: &[Vec<u8>],
    attesters: &[Address],
    threshold: u16,
) -> bool {
    if threshold == 0 || sigs.len() < threshold as usize {
        return false;
    }
    let mut last = Address::ZERO;
    for sig in sigs {
        let Some(signer) = recover_signer(digest, sig) else {
            return false;
        };
        if signer <= last || !attesters.contains(&signer) {
            return false;
        }
        last = signer;
    }
    true
}

/// Order quorum signatures by recovered signer ascending — the layout
/// `_verifyQuorum` requires. Drops signatures that do not recover.
pub fn sort_quorum_sigs(digest: B256, mut sigs: Vec<Vec<u8>>) -> Vec<Vec<u8>> {
    sigs.retain(|s| recover_signer(digest, s).is_some());
    sigs.sort_by_key(|s| recover_signer(digest, s).expect("retained above"));
    sigs.dedup_by_key(|s| recover_signer(digest, s).expect("retained above"));
    sigs
}

mod hex_bytes {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], ser: S) -> Result<S::Ok, S::Error> {
        ser.serialize_str(&alloy_primitives::hex::encode_prefixed(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(de: D) -> Result<Vec<u8>, D::Error> {
        let s = String::deserialize(de)?;
        alloy_primitives::hex::decode(s.trim_start_matches("0x")).map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::B256;

    fn signer(byte: u8) -> Signer {
        Signer::from_hex(&alloy_primitives::hex::encode([byte; 32])).unwrap()
    }

    fn order(side: u8, price: u64, qty: u64, trader: Address) -> Order {
        Order {
            instrument: instrument_hash("anthropic/claude-opus-4-8:output"),
            side,
            priceMicroPerM: price,
            qtyTokens: qty,
            lotId: B256::ZERO,
            trader,
            expiry: 2_000_000_000,
            salt: B256::with_last_byte(7),
        }
    }

    #[test]
    fn pair_signed_fill_at_maker_price() {
        let dom = domain(31_337, Address::ZERO);
        let maker = signer(0x11);
        let taker = signer(0x22);
        let sell = maker.sign_order(&order(SIDE_SELL, 14_000_000, 50_000, maker.address()), &dom);
        let buy = taker.sign_order(&order(SIDE_BUY, 15_000_000, 50_000, taker.address()), &dom);
        let fill = SignedFill::pair(sell, buy, 50_000, 1_900_000_000, &dom).unwrap();
        assert_eq!(fill.exec_price_micro_per_m, 14_000_000, "maker price");
        assert_eq!(fill.cost_micro(), 700_000);
    }

    #[test]
    fn pair_rejects_forged_signature() {
        let dom = domain(31_337, Address::ZERO);
        let maker = signer(0x11);
        let taker = signer(0x22);
        let mut sell =
            maker.sign_order(&order(SIDE_SELL, 14_000_000, 50_000, maker.address()), &dom);
        sell.order.priceMicroPerM = 1; // tamper after signing
        let buy = taker.sign_order(&order(SIDE_BUY, 15_000_000, 50_000, taker.address()), &dom);
        assert!(matches!(
            SignedFill::pair(sell, buy, 50_000, 1_900_000_000, &dom),
            Err(FillError::BadSignature(_))
        ));
    }

    #[test]
    fn quorum_roundtrip_and_rejections() {
        let dom = domain(31_337, Address::ZERO);
        let atts: Vec<Signer> = vec![signer(0xA1), signer(0xA2), signer(0xA3)];
        let addrs: Vec<Address> = atts.iter().map(Signer::address).collect();
        let mut batch = Batch::default();
        let maker = signer(0x11);
        let taker = signer(0x22);
        let sell = maker.sign_order(&order(SIDE_SELL, 14_000_000, 50_000, maker.address()), &dom);
        let buy = taker.sign_order(&order(SIDE_BUY, 15_000_000, 50_000, taker.address()), &dom);
        batch.push(SignedFill::pair(sell, buy, 50_000, 1_900_000_000, &dom).unwrap());

        let digest = batch.attestation_digest(0, &dom);
        let sigs = sort_quorum_sigs(
            digest,
            atts.iter()
                .map(|a| a.sign_digest(digest).to_vec())
                .collect(),
        );
        assert!(verify_quorum(digest, &sigs, &addrs, 2));
        assert!(
            !verify_quorum(digest, &sigs[..1].to_vec(), &addrs, 2),
            "below threshold"
        );

        let outsider = signer(0xBB);
        let bad = sort_quorum_sigs(digest, vec![outsider.sign_digest(digest).to_vec()]);
        assert!(!verify_quorum(digest, &bad, &addrs, 1), "non-attester");

        // Different nonce, different digest: old sigs no longer verify.
        let digest2 = batch.attestation_digest(1, &dom);
        assert!(
            !verify_quorum(digest2, &sigs, &addrs, 2),
            "nonce binds attestation"
        );
    }

    #[test]
    fn signed_fill_json_roundtrip() {
        let dom = domain(31_337, Address::ZERO);
        let maker = signer(0x11);
        let taker = signer(0x22);
        let sell = maker.sign_order(&order(SIDE_SELL, 14_000_000, 50_000, maker.address()), &dom);
        let buy = taker.sign_order(&order(SIDE_BUY, 15_000_000, 50_000, taker.address()), &dom);
        let fill = SignedFill::pair(sell, buy, 50_000, 1_900_000_000, &dom).unwrap();
        let json = serde_json::to_string(&fill).unwrap();
        let back: SignedFill = serde_json::from_str(&json).unwrap();
        assert_eq!(fill, back);
    }
}
