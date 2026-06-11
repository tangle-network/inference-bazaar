//! Batch-validity program: proves the ONE thing `settleBatchProven` skips —
//! that every fill in the batch is signed by both of its traders under the
//! settlement contract's EIP-712 domain.
//!
//! Everything else (price limits, crossing, cumulative fill caps, balance and
//! collateral invariants) the contract re-enforces on-chain from the calldata
//! fills, so the trusted computing base of the proven path is exactly:
//! "these orders were really signed". Public values bind the proof to one
//! deployment and one fill set: `abi.encode(domainSeparator, fillsHash)`.

#![no_main]
sp1_zkvm::entrypoint!(main);

use surplus_batch_types::ProgramInput;
use surplus_settlement_core::{
    batch_public_values, domain, fills_hash, verify_order, BatchFill,
};

fn main() {
    let input: ProgramInput = sp1_zkvm::io::read();
    let dom = domain(input.chain_id, input.verifying_contract);

    let mut fills: Vec<BatchFill> = Vec::with_capacity(input.fills.len());
    for f in input.fills {
        assert!(verify_order(&f.buy, &f.buy_sig, &dom), "bad buy signature");
        assert!(verify_order(&f.sell, &f.sell_sig, &dom), "bad sell signature");
        fills.push(BatchFill {
            buy: f.buy,
            sell: f.sell,
            qtyTokens: f.qty_tokens,
            execPriceMicroPerM: f.exec_price_micro_per_m,
        });
    }

    let public = batch_public_values(dom.separator(), fills_hash(&fills));
    sp1_zkvm::io::commit_slice(&public);
}
