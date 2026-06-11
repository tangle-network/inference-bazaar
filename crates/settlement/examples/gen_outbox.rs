//! Generate a signed-fill outbox JSON for the SP1 prover's execute/prove modes
//! and for e2e smoke. Mirrors what `GET /settlement/outbox` returns.
//!
//!   cargo run -p surplus-settlement --example gen_outbox -- <chain-id> <contract> > outbox.json

use alloy_primitives::{Address, B256};
use surplus_settlement::{domain, instrument_hash, Batch, Order, SignedFill, Signer, SIDE_BUY, SIDE_SELL};

fn main() {
    let mut args = std::env::args().skip(1);
    let chain_id: u64 = args.next().and_then(|a| a.parse().ok()).unwrap_or(31_337);
    let contract: Address = args
        .next()
        .and_then(|a| a.parse().ok())
        .unwrap_or_else(|| "0x1111111111111111111111111111111111111111".parse().unwrap());
    let dom = domain(chain_id, contract);

    let maker = Signer::from_hex(&"11".repeat(32)).unwrap();
    let taker = Signer::from_hex(&"22".repeat(32)).unwrap();
    let instrument = instrument_hash("anthropic/claude-opus-4-8:output");

    let mut batch = Batch::default();
    for (i, qty) in [(0u8, 30_000u64), (1u8, 20_000u64)] {
        let sell = Order {
            instrument,
            side: SIDE_SELL,
            priceMicroPerM: 14_000_000,
            qtyTokens: 50_000,
            lotId: B256::ZERO,
            trader: maker.address(),
            expiry: 4_000_000_000,
            salt: B256::with_last_byte(i),
        };
        let buy = Order {
            instrument,
            side: SIDE_BUY,
            priceMicroPerM: 15_000_000,
            qtyTokens: 50_000,
            lotId: B256::ZERO,
            trader: taker.address(),
            expiry: 4_000_000_000,
            salt: B256::with_last_byte(0x10 + i),
        };
        let fill = SignedFill::pair(
            maker.sign_order(&sell, &dom),
            taker.sign_order(&buy, &dom),
            qty,
            1_900_000_000,
            &dom,
        )
        .expect("fixture fill must pair");
        batch.push(fill);
    }

    let out = serde_json::json!({
        "count": batch.len(),
        "fillsHash": format!("{:#x}", batch.fills_hash()),
        "fills": batch.fills,
    });
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}
