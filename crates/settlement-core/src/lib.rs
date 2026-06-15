//! Mirror of `InferenceBazaarSettlement.sol`'s typed-data surface: EIP-712 structs,
//! digests, signature recovery, and the stateless half of fill validity.
//!
//! The contract is the source of truth. Everything here must hash byte-for-byte
//! identically to it — the parity fixture test (`eip712_parity`) pins that.
//! `no_std`-compatible (disable default features) so the SP1 batch program can
//! reuse the exact same digest + recovery code the venue runs.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

use alloc::vec::Vec;
use alloy_primitives::{keccak256, Address, B256, U256};
use alloy_sol_types::{eip712_domain, sol, SolStruct, SolValue};

// Re-exported so downstream crates (operator, SP1 guest) use the exact same
// primitive types without pinning alloy themselves.
pub use alloy_primitives::{self, hex};
pub use alloy_sol_types::Eip712Domain;

sol! {
    /// A firm commitment to trade. CLOB orders and RFQ quotes are the same
    /// struct: side 0 = buy (pay cash, receive credit), side 1 = sell (deliver
    /// credit; lotId == 0 mints against the seller's collateral).
    #[derive(Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
    struct Order {
        bytes32 instrument;
        uint8 side;
        uint64 priceMicroPerM;
        uint64 qtyTokens;
        bytes32 lotId;
        address trader;
        uint64 expiry;
        bytes32 salt;
    }

    /// A fill whose signatures travel out-of-band (batch paths).
    #[derive(Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
    struct BatchFill {
        Order buy;
        Order sell;
        uint64 qtyTokens;
        uint64 execPriceMicroPerM;
    }

    /// `workCommitment = keccak256(modelIdHash, messagesHash, outputHash)` binds
    /// the receipt to the exact model, request, and output served — proof of
    /// WHAT was served, not just how many tokens.
    #[derive(Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
    struct RedemptionReceipt {
        bytes32 redemptionId;
        uint64 servedTokens;
        bytes32 workCommitment;
    }

    /// What an attester quorum signs. `bookId` is the matching domain — one
    /// shared book per service instance — so a quorum signature is single-use
    /// within its own book's nonce sequence and meaningless in any other book.
    #[derive(Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
    struct SettlementBatch {
        bytes32 bookId;
        uint64 batchNonce;
        bytes32 fillsHash;
    }
}

pub const SIDE_BUY: u8 = 0;
pub const SIDE_SELL: u8 = 1;

/// The contract's EIP-712 domain: `EIP712("InferenceBazaarSettlement", "1")`.
pub fn domain(chain_id: u64, verifying_contract: Address) -> Eip712Domain {
    eip712_domain! {
        name: "InferenceBazaarSettlement",
        version: "1",
        chain_id: chain_id,
        verifying_contract: verifying_contract,
    }
}

pub fn order_digest(order: &Order, domain: &Eip712Domain) -> B256 {
    order.eip712_signing_hash(domain)
}

/// The EIP-712 STRUCT hash of an order — `hashOrder(o)` on-chain, which is the
/// key the contract's `filled` and `cancelled` mappings use (NOT the signing
/// digest). Off-chain settlement pre-checks must read those mappings by this.
pub fn order_struct_hash(order: &Order) -> B256 {
    order.eip712_hash_struct()
}

pub fn receipt_digest(
    redemption_id: B256,
    served_tokens: u64,
    work_commitment: B256,
    domain: &Eip712Domain,
) -> B256 {
    RedemptionReceipt {
        redemptionId: redemption_id,
        servedTokens: served_tokens,
        workCommitment: work_commitment,
    }
    .eip712_signing_hash(domain)
}

/// `workCommitment = keccak256(modelIdHash ‖ messagesHash ‖ outputHash)` — the
/// receipt's proof of WHAT was served. `modelIdHash = keccak256(model_id)`,
/// `messagesHash = keccak256(exact request bytes)`, `outputHash = keccak256(the
/// served output bytes)`. Both holder and issuer derive it identically.
pub fn work_commitment(model_id_hash: B256, messages_hash: B256, output_hash: B256) -> B256 {
    let mut buf = [0u8; 96];
    buf[..32].copy_from_slice(model_id_hash.as_slice());
    buf[32..64].copy_from_slice(messages_hash.as_slice());
    buf[64..].copy_from_slice(output_hash.as_slice());
    keccak256(buf)
}

pub fn batch_digest(
    book_id: B256,
    batch_nonce: u64,
    fills_hash: B256,
    domain: &Eip712Domain,
) -> B256 {
    SettlementBatch {
        bookId: book_id,
        batchNonce: batch_nonce,
        fillsHash: fills_hash,
    }
    .eip712_signing_hash(domain)
}

/// `keccak256(abi.encode(fills))` — exactly what `settleBatch*` computes from
/// calldata, and what the SP1 program commits as a public value.
pub fn fills_hash(fills: &[BatchFill]) -> B256 {
    keccak256(fills.abi_encode())
}

/// The public values the SP1 batch program commits:
/// `abi.encode(domainSeparator, bookId, batchNonce, ordersCommitment, fillsHash)`.
///
/// - `bookId` + `batchNonce` bind a proof to exactly one book at exactly one
///   nonce, so a proof cannot be replayed under a different (e.g. higher-fee)
///   book, nor re-submitted after the book's nonce advances (a partial-fill proof
///   is otherwise replayable until the orders are exhausted).
/// - `ordersCommitment` is the hash of the input order set the guest *matched*
///   (see `inference_bazaar_matcher::orders_commitment`). Because the guest runs the match
///   in-circuit, the proof attests `fillsHash` is the canonical match of exactly
///   that set — the prover cannot mis-pair, pick an exec price within the spread,
///   or drop a crossing order from the set. The contract emits it for off-chain
///   completeness/censorship auditing against the gossiped set.
///
/// `settleBatchProven` re-derives the tuple from `(bookId, book.nonce,
/// ordersCommitment, fillsHash)` and reverts on mismatch.
pub fn batch_public_values(
    domain_separator: B256,
    book_id: B256,
    batch_nonce: u64,
    orders_commitment: B256,
    fills_hash: B256,
) -> Vec<u8> {
    (
        domain_separator,
        book_id,
        batch_nonce,
        orders_commitment,
        fills_hash,
    )
        .abi_encode()
}

/// A commitment to the exact input order SET a match ran over — the inclusion
/// commitment for the proven path.
///
/// `keccak256(sorted unique order digests)`. Order-independent and dedup-stable,
/// exactly like the matcher, so any party holding the same set derives the
/// identical commitment. The SP1 guest commits this alongside `fillsHash`, so a
/// proof says not just "these fills are signed" but "these fills are the
/// canonical match of *this* committed set" — a lone prover can no longer
/// mis-pair, pick an exec price within the spread, or omit a crossing order
/// *within the set* without breaking the proof.
///
/// What this does NOT prove by itself: that the committed set is the *complete*
/// gossiped set (a prover can still leave an order out of the input). That last
/// gap — censorship/completeness — is closed off-chain by checking this
/// commitment against the gossiped set (the attested path's peers do the
/// equivalent in `verify_proposal`); the commitment is emitted on-chain
/// (`BatchSettled.ordersCommitment`) so any watcher can perform that check, and
/// an inclusion-receipt / DA layer is the eventual on-chain enforcement.
pub fn orders_commitment(orders: &[Order], domain: &Eip712Domain) -> B256 {
    let mut digests: Vec<B256> = orders.iter().map(|o| order_digest(o, domain)).collect();
    digests.sort_unstable();
    digests.dedup();
    let mut buf: Vec<u8> = Vec::with_capacity(digests.len() * 32);
    for d in &digests {
        buf.extend_from_slice(d.as_slice());
    }
    keccak256(&buf)
}

pub fn instrument_hash(instrument_id: &str) -> B256 {
    keccak256(instrument_id.as_bytes())
}

/// Recover the signer of `digest` from a 65-byte `r || s || v` signature.
/// Byte-for-byte mirror of OpenZeppelin `ECDSA.recover` on the 65-byte path:
/// rejects high-`s` (malleable) values, and accepts v ONLY in {27, 28}. v=0/1
/// is deliberately rejected — OZ forwards those to `ecrecover`, which returns
/// `address(0)` and makes `ECDSA.recover` revert. Accepting them here would let
/// an order pass venue intake yet revert the whole atomic `settleFills` batch.
pub fn recover_signer(digest: B256, signature: &[u8]) -> Option<Address> {
    use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
    use k256::elliptic_curve::scalar::IsHigh;

    if signature.len() != 65 {
        return None;
    }
    let v = match signature[64] {
        27 | 28 => signature[64] - 27,
        _ => return None,
    };
    let sig = Signature::from_slice(&signature[..64]).ok()?;
    if sig.s().is_high().into() {
        return None;
    }
    let rec_id = RecoveryId::from_byte(v)?;
    let key = VerifyingKey::recover_from_prehash(digest.as_slice(), &sig, rec_id).ok()?;
    let encoded = key.to_encoded_point(false);
    Some(Address::from_slice(
        &keccak256(&encoded.as_bytes()[1..])[12..],
    ))
}

/// Verify an order's signature against its EIP-712 digest.
pub fn verify_order(order: &Order, signature: &[u8], domain: &Eip712Domain) -> bool {
    recover_signer(order_digest(order, domain), signature) == Some(order.trader)
}

// ─────────────────────────── Fill validity (stateless) ───────────────────────

/// Why a buy/sell pair cannot fill. Mirrors `_applyFill`'s stateless checks; the
/// stateful half (cumulative fill caps, balances, collateral) lives on-chain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairError {
    InvalidOrderPair,
    SelfFill,
    ZeroAmount,
    OrderExpired,
    PriceOutsideLimits,
    QtyExceedsOrder,
}

pub fn validate_pair(
    buy: &Order,
    sell: &Order,
    qty: u64,
    exec_price: u64,
    now_unix: u64,
) -> Result<(), PairError> {
    if buy.side != SIDE_BUY
        || sell.side != SIDE_SELL
        || buy.instrument != sell.instrument
        || buy.lotId != B256::ZERO
    {
        return Err(PairError::InvalidOrderPair);
    }
    if buy.trader == sell.trader {
        return Err(PairError::SelfFill);
    }
    if qty == 0 || exec_price == 0 {
        return Err(PairError::ZeroAmount);
    }
    if now_unix > buy.expiry || now_unix > sell.expiry {
        return Err(PairError::OrderExpired);
    }
    if exec_price > buy.priceMicroPerM || exec_price < sell.priceMicroPerM {
        return Err(PairError::PriceOutsideLimits);
    }
    if qty > buy.qtyTokens || qty > sell.qtyTokens {
        return Err(PairError::QtyExceedsOrder);
    }
    Ok(())
}

/// Fill notional in micro-tsUSD, rounded half-up — mirrors the contract and
/// `Fill::notional_micro` in the orderbook crate.
pub fn cost_micro(exec_price: u64, qty: u64) -> U256 {
    (U256::from(exec_price) * U256::from(qty) + U256::from(500_000u64)) / U256::from(1_000_000u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::{address, b256};

    fn test_order() -> Order {
        Order {
            instrument: instrument_hash("anthropic/claude-opus-4-8:output"),
            side: SIDE_BUY,
            priceMicroPerM: 15_000_000,
            qtyTokens: 50_000,
            lotId: B256::ZERO,
            trader: address!("f39Fd6e51aad88F6F4ce6aB8827279cffFb92266"),
            expiry: 1_700_000_000,
            salt: b256!("00000000000000000000000000000000000000000000000000000000000000aa"),
        }
    }

    #[test]
    fn typehash_matches_contract() {
        // keccak256("Order(bytes32 instrument,uint8 side,uint64 priceMicroPerM,
        //   uint64 qtyTokens,bytes32 lotId,address trader,uint64 expiry,bytes32 salt)")
        assert_eq!(
            Order::eip712_type_hash(&test_order()),
            keccak256(
                "Order(bytes32 instrument,uint8 side,uint64 priceMicroPerM,uint64 qtyTokens,bytes32 lotId,address trader,uint64 expiry,bytes32 salt)"
            )
        );
    }

    #[test]
    fn sign_and_recover_roundtrip() {
        use k256::ecdsa::SigningKey;
        let key = SigningKey::from_slice(&[0x42u8; 32]).unwrap();
        let dom = domain(31_337, Address::ZERO);
        let mut order = test_order();
        let encoded = key.verifying_key().to_encoded_point(false);
        order.trader = Address::from_slice(&keccak256(&encoded.as_bytes()[1..])[12..]);
        let digest = order_digest(&order, &dom);
        let (sig, rec) = key.sign_prehash_recoverable(digest.as_slice()).unwrap();
        let mut bytes = [0u8; 65];
        bytes[..64].copy_from_slice(&sig.to_bytes());
        bytes[64] = 27 + rec.to_byte();
        assert!(verify_order(&order, &bytes, &dom));
        // Tampering breaks recovery.
        let mut tampered = order.clone();
        tampered.qtyTokens += 1;
        assert!(!verify_order(&tampered, &bytes, &dom));

        // v in {0,1} must be REJECTED to match OZ ECDSA.recover exactly — a
        // signature the venue accepts but the contract reverts on would wedge
        // the atomic settleFills batch. A v=27 sig flipped to v=0 recovers the
        // same key off-chain but the contract reverts; reject it at the source.
        let mut v0 = bytes;
        v0[64] = bytes[64] - 27; // 27/28 -> 0/1
        assert!(recover_signer(order_digest(&order, &dom), &v0).is_none());
    }

    #[test]
    fn pair_validation() {
        let now = 1_600_000_000;
        let buy = test_order();
        let mut sell = test_order();
        sell.side = SIDE_SELL;
        sell.priceMicroPerM = 14_000_000;
        sell.trader = address!("70997970C51812dc3A010C7d01b50e0d17dc79C8");
        assert_eq!(validate_pair(&buy, &sell, 50_000, 15_000_000, now), Ok(()));
        assert_eq!(
            validate_pair(&buy, &sell, 50_000, 15_000_001, now),
            Err(PairError::PriceOutsideLimits)
        );
        assert_eq!(
            validate_pair(&buy, &sell, 50_001, 15_000_000, now),
            Err(PairError::QtyExceedsOrder)
        );
        assert_eq!(
            validate_pair(&buy, &sell, 50_000, 15_000_000, 1_700_000_001),
            Err(PairError::OrderExpired)
        );
        let mut self_sell = sell.clone();
        self_sell.trader = buy.trader;
        assert_eq!(
            validate_pair(&buy, &self_sell, 50_000, 15_000_000, now),
            Err(PairError::SelfFill)
        );
    }

    #[test]
    fn cost_rounds_half_up() {
        assert_eq!(cost_micro(15_000_000, 50_000), U256::from(750_000u64));
        assert_eq!(cost_micro(1_000, 1_500), U256::from(2u64)); // 1.5 -> 2
        assert_eq!(cost_micro(1_000, 1_400), U256::from(1u64)); // 1.4 -> 1
    }
}
