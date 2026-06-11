//! Epoch consensus for the shared book: proposer election, peer verification of a
//! proposed batch, and attestation aggregation.
//!
//! All pure and deterministic. The transport (blueprint-networking per-instance
//! gossip) and the chain (`settleBatchAttested` submit) live in the operator and
//! drive these functions; the functions themselves trust nothing — every node
//! runs the same logic over the same on-chain inputs (the bonded operator set,
//! the epoch number, the batch nonce) and converges without trusting each other.
//!
//! Because [`crate::match_epoch`] is set-deterministic, a peer can *recompute* a
//! proposer's claimed batch exactly. So the only two ways a proposer can cheat —
//! computing a wrong match, or omitting orders it received — are both caught here
//! ([`verify_proposal`]); it cannot reorder or front-run at all.

use std::collections::HashSet;

use surplus_settlement_core::{
    alloy_primitives::{Address, B256},
    batch_digest, instrument_hash, order_digest, recover_signer, Eip712Domain,
    Order as SignedOrder,
};

use crate::{match_epoch, EpochBatch};

/// Elect the proposer for an epoch: round-robin over the bonded operator set,
/// rotated by epoch number. Deterministic from the (canonicalised, deduped) set
/// and the epoch, so every node — and any auditor — agrees on who may propose,
/// and liveness handoff is just `epoch + 1`.
pub fn elect_proposer(operators: &[Address], epoch: u64) -> Option<Address> {
    if operators.is_empty() {
        return None;
    }
    let mut ops: Vec<Address> = operators.to_vec();
    ops.sort_unstable();
    ops.dedup();
    let idx = (epoch % ops.len() as u64) as usize;
    Some(ops[idx])
}

/// What the elected proposer broadcasts at epoch close: the input order set it
/// matched — verbatim, so peers recompute rather than trust — plus the contract
/// `batchNonce` it bound to. The fills are NOT sent; peers derive them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchProposal {
    pub epoch: u64,
    pub batch_nonce: u64,
    pub instrument_id: String,
    pub proposer: Address,
    /// The gossiped order set the proposer matched.
    pub orders: Vec<SignedOrder>,
    /// The proposer's claimed result. Redundant — peers recompute it — but it is
    /// what the co-signature commits to via [`batch_digest`].
    pub fills_hash: B256,
}

/// A peer's co-signature over the batch digest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attestation {
    pub attester: Address,
    pub signature: Vec<u8>,
}

/// The outcome of a peer independently checking a proposal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// Honest and complete — co-sign this batch digest.
    Sign(B256),
    /// The proposer's claimed match does not reproduce. Fraud; do not sign.
    FillsHashMismatch,
    /// The proposer omitted orders this peer holds (digests returned for a fraud
    /// claim). Censorship; do not sign.
    Censored(Vec<B256>),
}

/// A peer verifies a proposal against ITS view of the gossiped order set. Set-
/// determinism leaves a proposer exactly two ways to cheat, both checked here:
///   1. **Wrong match** — recompute over the proposer's claimed set; it must
///      reproduce the claimed `fillsHash`.
///   2. **Censorship** — every order this peer holds for the instrument must
///      appear in the proposer's set.
/// Only then co-sign `batch_digest(batch_nonce, fillsHash, domain)`.
pub fn verify_proposal(
    proposal: &BatchProposal,
    my_orders: &[SignedOrder],
    tick_size: i64,
    min_qty: i64,
    domain: &Eip712Domain,
) -> Verdict {
    let recomputed: EpochBatch = match_epoch(
        &proposal.instrument_id,
        tick_size,
        min_qty,
        domain,
        &proposal.orders,
    );
    if recomputed.fills_hash != proposal.fills_hash {
        return Verdict::FillsHashMismatch;
    }

    let want_instrument = instrument_hash(&proposal.instrument_id);
    let included: HashSet<B256> = proposal
        .orders
        .iter()
        .map(|o| order_digest(o, domain))
        .collect();
    let censored: Vec<B256> = my_orders
        .iter()
        .filter(|o| o.instrument == want_instrument)
        .map(|o| order_digest(o, domain))
        .filter(|d| !included.contains(d))
        .collect();
    if !censored.is_empty() {
        return Verdict::Censored(censored);
    }

    Verdict::Sign(batch_digest(
        proposal.batch_nonce,
        proposal.fills_hash,
        domain,
    ))
}

/// Aggregate the attestations a proposer has collected. Keeps only signatures
/// that recover to a *distinct bonded* operator over `digest`, and returns the
/// signature set once it reaches `threshold` — exactly what `settleBatchAttested`
/// re-verifies on-chain. `None` until quorum, so the proposer knows when to
/// submit. Signature order follows `attestations` (deterministic for the caller).
pub fn aggregate_attestation(
    digest: B256,
    attestations: &[Attestation],
    bonded: &[Address],
    threshold: usize,
) -> Option<Vec<Vec<u8>>> {
    let bonded: HashSet<Address> = bonded.iter().copied().collect();
    let mut counted: HashSet<Address> = HashSet::new();
    let mut sigs: Vec<Vec<u8>> = Vec::new();
    for a in attestations {
        if recover_signer(digest, &a.signature) == Some(a.attester)
            && bonded.contains(&a.attester)
            && counted.insert(a.attester)
        {
            sigs.push(a.signature.clone());
        }
    }
    (sigs.len() >= threshold).then_some(sigs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use surplus_settlement::Signer;
    use surplus_settlement_core::{domain, SIDE_BUY, SIDE_SELL};

    // Well-known Anvil private keys — test material only.
    const KEYS: [&str; 3] = [
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
        "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
        "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    ];

    fn dom() -> Eip712Domain {
        domain(84532, Address::with_last_byte(0xcc))
    }

    fn order(side: u8, price: u64, qty: u64, trader: u8) -> SignedOrder {
        SignedOrder {
            instrument: instrument_hash("m"),
            side,
            priceMicroPerM: price,
            qtyTokens: qty,
            lotId: B256::ZERO,
            trader: Address::with_last_byte(trader),
            expiry: u64::MAX,
            salt: B256::with_last_byte(trader),
        }
    }

    fn proposal_over(orders: Vec<SignedOrder>, batch_nonce: u64) -> BatchProposal {
        let d = dom();
        let batch = match_epoch("m", 1, 1, &d, &orders);
        BatchProposal {
            epoch: 7,
            batch_nonce,
            instrument_id: "m".into(),
            proposer: Address::with_last_byte(9),
            orders,
            fills_hash: batch.fills_hash,
        }
    }

    #[test]
    fn election_is_deterministic_rotates_and_order_free() {
        let a = Address::with_last_byte(1);
        let b = Address::with_last_byte(2);
        let c = Address::with_last_byte(3);
        let set = [c, a, b];
        let rev = [b, c, a];
        // Same set (any input order), same epoch → same proposer.
        assert_eq!(elect_proposer(&set, 5), elect_proposer(&rev, 5));
        // Rotates by epoch over the sorted set [a,b,c].
        assert_eq!(elect_proposer(&set, 0), Some(a));
        assert_eq!(elect_proposer(&set, 1), Some(b));
        assert_eq!(elect_proposer(&set, 2), Some(c));
        assert_eq!(elect_proposer(&set, 3), Some(a));
        assert_eq!(elect_proposer(&[], 0), None);
    }

    #[test]
    fn honest_complete_proposal_is_signed() {
        let orders = vec![order(SIDE_SELL, 100, 10, 2), order(SIDE_BUY, 100, 10, 1)];
        let p = proposal_over(orders.clone(), 42);
        // A peer with the same set signs the expected digest.
        let want = batch_digest(42, p.fills_hash, &dom());
        assert_eq!(
            verify_proposal(&p, &orders, 1, 1, &dom()),
            Verdict::Sign(want)
        );
    }

    #[test]
    fn wrong_match_is_rejected() {
        let orders = vec![order(SIDE_SELL, 100, 10, 2), order(SIDE_BUY, 100, 10, 1)];
        let mut p = proposal_over(orders.clone(), 1);
        p.fills_hash = B256::repeat_byte(0xde); // proposer lies about the result
        assert_eq!(
            verify_proposal(&p, &orders, 1, 1, &dom()),
            Verdict::FillsHashMismatch
        );
    }

    #[test]
    fn censorship_is_detected() {
        // Proposer matched only a subset; the peer also holds a third order the
        // proposer omitted → the peer refuses to sign and names the omission.
        let included = vec![order(SIDE_SELL, 100, 10, 2), order(SIDE_BUY, 100, 10, 1)];
        let p = proposal_over(included.clone(), 1);
        let omitted = order(SIDE_SELL, 101, 5, 3);
        let my_view = [included, vec![omitted.clone()]].concat();
        let verdict = verify_proposal(&p, &my_view, 1, 1, &dom());
        assert_eq!(
            verdict,
            Verdict::Censored(vec![order_digest(&omitted, &dom())])
        );
    }

    #[test]
    fn aggregation_gates_on_distinct_bonded_quorum() {
        let signers: Vec<Signer> = KEYS.iter().map(|k| Signer::from_hex(k).unwrap()).collect();
        let bonded: Vec<Address> = signers.iter().map(|s| s.address()).collect();
        let digest = B256::repeat_byte(0xab);

        let two: Vec<Attestation> = signers
            .iter()
            .take(2)
            .map(|s| Attestation {
                attester: s.address(),
                signature: s.sign_digest(digest).to_vec(),
            })
            .collect();

        assert!(aggregate_attestation(digest, &two, &bonded, 2).is_some());
        assert!(aggregate_attestation(digest, &two, &bonded, 3).is_none());

        // The same operator signing twice does not count twice.
        let dupe = [two.clone(), vec![two[0].clone()]].concat();
        assert!(aggregate_attestation(digest, &dupe, &bonded, 3).is_none());

        // A signature over the wrong digest is dropped.
        let wrong = Attestation {
            attester: signers[2].address(),
            signature: signers[2].sign_digest(B256::repeat_byte(0x01)).to_vec(),
        };
        let with_wrong = [two, vec![wrong]].concat();
        assert!(aggregate_attestation(digest, &with_wrong, &bonded, 3).is_none());

        // A non-bonded signer is ignored even with a valid signature.
        let outsider =
            Signer::from_hex("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6")
                .unwrap();
        let att = Attestation {
            attester: outsider.address(),
            signature: outsider.sign_digest(digest).to_vec(),
        };
        assert!(aggregate_attestation(digest, &[att], &bonded, 1).is_none());
    }
}
