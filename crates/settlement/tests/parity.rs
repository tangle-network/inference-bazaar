//! Cross-stack EIP-712 parity. These constants are asserted byte-identically by
//! `contracts/test/Eip712Parity.t.sol` — the Solidity test derives them from
//! the deployed contract's own hashing, this test from the Rust mirror. If
//! either side changes a struct, BOTH tests fail and point at the drift.

use alloy_primitives::{address, b256, Address, B256};
use surplus_settlement::{
    batch_digest, domain, fills_hash, instrument_hash, order_digest, receipt_digest, BatchFill,
    Order, SIDE_BUY, SIDE_SELL,
};

const CHAIN_ID: u64 = 3799; // Tangle testnet
const VERIFYING: Address = address!("1111111111111111111111111111111111111111");

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
    // Run with `cargo test -p surplus-settlement --test parity -- --nocapture`
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
        receipt_digest(B256::with_last_byte(0x01), 20_000, &dom)
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
        b256!("0de24ff3d7a13aaf2d2f45a220740d46c8e4f672e6ec27ec07f887383aec631e"),
        "domain separator drifted"
    );
    assert_eq!(
        order_digest(&fixture_buy(), &dom),
        b256!("42429ee1902dced9a55e9d57665f224d30760bf116a4a5fb433667bd411da720"),
        "buy order digest drifted"
    );
    // The sell order exercises different field values (side=1, salt=0xbb,
    // different trader); Eip712Parity.t.sol pins it too, so assert it here for
    // a symmetric cross-stack pin.
    assert_eq!(
        order_digest(&fixture_sell(), &dom),
        b256!("68a403f61ba389d67aaeb883f03a9e441dc347b3b0ec9f47dca89cb5be0fc2aa"),
        "sell order digest drifted"
    );
    assert_eq!(
        fills_hash(&fills),
        b256!("54d57a43d09d15471f4f864443bc63e10a0d05a12fa203f81941d036aa5ad334"),
        "fills hash drifted"
    );
    assert_eq!(
        receipt_digest(B256::with_last_byte(0x01), 20_000, &dom),
        b256!("fdd98e90c60c3ff8de5ea5b9b3f80fb9bfaddd19c4829c2eed440e883a33b6b7"),
        "receipt digest drifted"
    );
    assert_eq!(
        batch_digest(B256::ZERO, 0, fills_hash(&fills), &dom),
        b256!("bf7f321f498636d52728a1ea71a7fac4116795252c2299103f4d989278b36dbd"),
        "batch digest drifted"
    );
}
