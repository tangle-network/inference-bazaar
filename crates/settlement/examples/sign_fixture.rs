//! Generate a signed ORDER-SET fixture for the SP1 batch prover (match-in-circuit).
//!
//!   cargo run -p surplus-settlement --example sign_fixture -- \
//!       --chain-id 84532 --contract 0x… > orders.json
//!   cd zk && cargo build --release -p surplus-batch-prover
//!   ./target/release/prove --orders ../orders.json \
//!       --instrument anthropic/claude-opus-4-8:output --tick 1 --min-qty 1 \
//!       --chain-id 84532 --contract 0x… --book-id 0x00…00 --mode execute
//!
//! A real mutually-signed crossing pair under the SurplusSettlement EIP-712
//! domain — the guest re-verifies every signature AND runs match_epoch, so the
//! fixture must be a real, crossable order set.

use surplus_settlement::core::alloy_primitives::{Address, B256};
use surplus_settlement::core::{instrument_hash, Order};
use surplus_settlement::{domain, Signer, SIDE_BUY, SIDE_SELL};

// Well-known Anvil keys — fixture material only.
const SELLER_KEY: &str = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const BUYER_KEY: &str = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";

fn arg(name: &str, default: &str) -> String {
    let mut it = std::env::args();
    while let Some(a) = it.next() {
        if a == name {
            return it.next().unwrap_or_else(|| default.to_string());
        }
    }
    default.to_string()
}

fn main() {
    let chain_id: u64 = arg("--chain-id", "84532").parse().expect("chain-id");
    let contract: Address = arg("--contract", "0x3fa622488fD970ECdE23b8384a98de6fFa5A1763")
        .parse()
        .expect("contract");
    let dom = domain(chain_id, contract);

    let seller = Signer::from_hex(SELLER_KEY).unwrap();
    let buyer = Signer::from_hex(BUYER_KEY).unwrap();
    let order = |side: u8, trader: Address, salt: u8| Order {
        instrument: instrument_hash("anthropic/claude-opus-4-8:output"),
        side,
        priceMicroPerM: 15_000_000,
        qtyTokens: 10_000,
        lotId: B256::ZERO,
        trader,
        expiry: u64::MAX,
        salt: B256::with_last_byte(salt),
    };

    // The gossiped epoch order SET (the prover/guest matches it in-circuit).
    let orders = [
        seller.sign_order(&order(SIDE_SELL, seller.address(), 1), &dom),
        buyer.sign_order(&order(SIDE_BUY, buyer.address(), 2), &dom),
    ];

    let out = serde_json::json!({ "orders": orders });
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}
