//! Cross-stack EIP-712 parity. These constants are asserted byte-identically by
//! `contracts/test/Eip712Parity.t.sol` — the Solidity test derives them from
//! the deployed contract's own hashing, this test from the Rust mirror. If
//! either side changes a struct, BOTH tests fail and point at the drift.

use alloy_primitives::{address, b256, Address, B256};
use inference_bazaar_settlement::{
    batch_digest, domain, fills_hash, instrument_hash, order_digest, receipt_digest, BatchFill,
    Order, SIDE_BUY, SIDE_SELL,
};

const CHAIN_ID: u64 = 3799; // Tangle testnet
const VERIFYING: Address = address!("1111111111111111111111111111111111111111");
// A fixed work commitment for the receipt parity fixture (shared with Solidity).
const WORK: B256 = b256!("0000000000000000000000000000000000000000000000000000000000000077");

fn fixture_buy() -> Order {
    Order {
        instrument: instrument_hash("anthropic/claude-opus-4-8:output"),
        side: SIDE_BUY,
        priceMicroPerM: 15_000_000,
        qtyTokens: 50_000,
        lotId: B256::ZERO,
        trader: address!("f39Fd6e51aad88F6F4ce6aB8827279cffFb92266"),
        expiry: 1_900_000_000,
        salt: b256!("00000000000000000000000000000000000000000000000000000000000000aa"),
    }
}

fn fixture_sell() -> Order {
    Order {
        instrument: instrument_hash("anthropic/claude-opus-4-8:output"),
        side: SIDE_SELL,
        priceMicroPerM: 14_000_000,
        qtyTokens: 50_000,
        lotId: B256::ZERO,
        trader: address!("70997970C51812dc3A010C7d01b50e0d17dc79C8"),
        expiry: 1_900_000_000,
        salt: b256!("00000000000000000000000000000000000000000000000000000000000000bb"),
    }
}

#[test]
fn print_fixture_values() {
    // Run with `cargo test -p inference-bazaar-settlement --test parity -- --nocapture`
    // to regenerate the constants pinned below and in Eip712Parity.t.sol.
    let dom = domain(CHAIN_ID, VERIFYING);
    let fills = vec![BatchFill {
        buy: fixture_buy(),
        sell: fixture_sell(),
        qtyTokens: 50_000,
        execPriceMicroPerM: 15_000_000,
    }];
    println!("domainSeparator: {}", dom.separator());
    println!("buyDigest:       {}", order_digest(&fixture_buy(), &dom));
    println!("sellDigest:      {}", order_digest(&fixture_sell(), &dom));
    println!("fillsHash:       {}", fills_hash(&fills));
    println!(
        "receiptDigest:   {}",
        receipt_digest(B256::with_last_byte(0x01), 20_000, WORK, &dom)
    );
    println!(
        "batchDigest:     {}",
        batch_digest(B256::ZERO, 0, fills_hash(&fills), &dom)
    );
}

#[test]
fn pinned_digests_match() {
    let dom = domain(CHAIN_ID, VERIFYING);
    let fills = vec![BatchFill {
        buy: fixture_buy(),
        sell: fixture_sell(),
        qtyTokens: 50_000,
        execPriceMicroPerM: 15_000_000,
    }];
    assert_eq!(
        dom.separator(),
        b256!("c67b5358a9a9d13922a738ee1200fa32b6d032e18e552410766ee7c3da4d020b"),
        "domain separator drifted"
    );
    assert_eq!(
        order_digest(&fixture_buy(), &dom),
        b256!("61fa3867c8944a9b0c4bd08bcde2ec0f8e32a60b6a4ed95297cdb902fd03bd48"),
        "buy order digest drifted"
    );
    // The sell order exercises different field values (side=1, salt=0xbb,
    // different trader); Eip712Parity.t.sol pins it too, so assert it here for
    // a symmetric cross-stack pin.
    assert_eq!(
        order_digest(&fixture_sell(), &dom),
        b256!("cc986c6927f2274a04ed697bc9d4b624cb32fd433f41cf756464e5e5cffe3766"),
        "sell order digest drifted"
    );
    assert_eq!(
        fills_hash(&fills),
        b256!("54d57a43d09d15471f4f864443bc63e10a0d05a12fa203f81941d036aa5ad334"),
        "fills hash drifted"
    );
    assert_eq!(
        receipt_digest(B256::with_last_byte(0x01), 20_000, WORK, &dom),
        b256!("53d4416fa58999e8515e4a695711f2e8c5e1c9801e99a1b9d983b94e969919ec"),
        "receipt digest drifted"
    );
    assert_eq!(
        batch_digest(B256::ZERO, 0, fills_hash(&fills), &dom),
        b256!("f6fa2ab8e1c2e9090ac39e20712ac33852b12a05f7492b97ef65b61054e7b8b1"),
        "batch digest drifted"
    );
}
