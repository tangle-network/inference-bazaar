//! Batch-validity program — the match-in-circuit proven path.
//!
//! Given the gossiped epoch order SET, the guest:
//!   1. verifies every order is signed by its `trader` under the settlement
//!      contract's EIP-712 domain (the authenticity the attested path delegates
//!      to a quorum);
//!   2. runs the SAME `match_epoch` the venue and peers run, in-circuit, to
//!      derive the canonical fills — so the prover has NO discretion over pairing,
//!      exec price, or which crossing orders settle;
//!   3. commits `abi.encode(domainSeparator, bookId, batchNonce, ordersCommitment,
//!      fillsHash)` as public values.
//!
//! The contract re-enforces the money rules (price limits, crossing, cumulative
//! fill caps, balances/collateral) from the calldata fills, so the proven path's
//! trusted computing base is exactly: "these fills are the canonical match of
//! this authentically-signed order set." `ordersCommitment` is emitted on-chain
//! for off-chain completeness/censorship auditing against the gossiped set.

#![no_main]
sp1_zkvm::entrypoint!(main);

use surplus_batch_types::ProgramInput;
use surplus_matcher::{match_epoch, orders_commitment};
use surplus_settlement_core::{batch_public_values, domain, verify_order, Order};

fn main() {
    let input: ProgramInput = sp1_zkvm::io::read();
    let dom = domain(input.chain_id, input.verifying_contract);

    // 1. Authenticity: every order in the set is really signed by its trader.
    let mut orders: Vec<Order> = Vec::with_capacity(input.orders.len());
    for o in &input.orders {
        assert!(verify_order(&o.order, &o.sig, &dom), "bad order signature");
        orders.push(o.order.clone());
    }

    // 2. Match in-circuit: the canonical, set-deterministic batch. No prover
    //    discretion — the fills are a pure function of the set.
    let batch = match_epoch(
        &input.instrument_id,
        input.tick_size,
        input.min_qty,
        &dom,
        &orders,
    );
    let oc = orders_commitment(&orders, &dom);

    // 3. Bind the proof to deployment, book, nonce, the matched set, and the fills.
    let public = batch_public_values(
        dom.separator(),
        input.book_id,
        input.batch_nonce,
        oc,
        batch.fills_hash,
    );
    sp1_zkvm::io::commit_slice(&public);
}
