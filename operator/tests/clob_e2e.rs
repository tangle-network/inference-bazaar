//! Two-operator shared-CLOB e2e over real HTTP: gossip a crossing pair of
//! signed orders to different nodes, run the epoch on the elected proposer, and
//! prove the full propose → independent re-verify → co-sign → quorum round —
//! plus rejection of forged orders and non-elected proposers.
//!
//! Chain submission is exercised dry here (no RPC); the on-chain leg of the
//! same digest/quorum flow is proven by Batch.t.sol and the live fleet.

use std::sync::Arc;

use surplus_operator::clob::{Clob, ClobConfig, WireOrder, WireProposal};
use surplus_operator::config::{
    Instrument, OperatorConfig, QuoteParams, RiskLimits, SettlementConfig,
};
use surplus_operator::Venue;
use surplus_settlement::core::alloy_primitives::{Address, B256};
use surplus_settlement::core::{instrument_hash, Order};
use surplus_settlement::{Signer, SIDE_BUY, SIDE_SELL};

const INSTRUMENT: &str = "anthropic/claude-opus-4-8:output";
const CONTRACT: &str = "0x00000000000000000000000000000000000000cc";
const CHAIN_ID: u64 = 31_337;

// Well-known Anvil keys — test material only.
const OP_KEYS: [&str; 2] = [
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
];
const SELLER_KEY: &str = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const BUYER_KEY: &str = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";

fn venue_with(operator_key: &str) -> Venue {
    Venue::new(OperatorConfig {
        sidecar_url: "http://unused".into(),
        router_url: "http://unused".into(),
        instruments: vec![Instrument {
            id: INSTRUMENT.into(),
            model_id: "anthropic/claude-opus-4-8".into(),
            token_kind: "output".into(),
            tick_size: 1000,
            min_qty: 1000,
        }],
        params: QuoteParams {
            gamma: 0.0000015,
            sigma: 22_500.0,
            horizon_ticks: 120.0,
            k: 1.5,
            size: 50_000.0,
            max_inventory: 300_000.0,
            tick_size: 1000.0,
        },
        limits: RiskLimits {
            max_inventory: 400_000.0,
            max_quote_notional: 2_000_000_000.0,
            max_deviation_bps: 300.0,
            min_spread_bps: 2.0,
            kill_switch_drawdown: 5_000_000.0,
        },
        settlement: Some(SettlementConfig {
            chain_id: CHAIN_ID,
            contract: CONTRACT.into(),
            operator_key: Some(operator_key.into()),
            rpc_url: None, // dry submit — the consensus round still runs fully
            rfq_ttl_secs: 120,
        }),
    })
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

fn signed_wire(side: u8, price: u64, qty: u64, key: &str, salt: u8) -> WireOrder {
    let signer = Signer::from_hex(key).unwrap();
    let order = Order {
        instrument: instrument_hash(INSTRUMENT),
        side,
        priceMicroPerM: price,
        qtyTokens: qty,
        lotId: B256::ZERO,
        trader: signer.address(),
        expiry: now() + 3600,
        salt: B256::with_last_byte(salt),
    };
    let dom = surplus_settlement::domain(CHAIN_ID, CONTRACT.parse().unwrap());
    let signed = signer.sign_order(&order, &dom);
    WireOrder {
        instrument_id: INSTRUMENT.into(),
        order: signed.order,
        signature: format!(
            "0x{}",
            surplus_settlement::core::hex::encode(signed.signature)
        ),
    }
}

/// Two clob nodes over real sockets. Epoch length is one hour so the elected
/// proposer is stable for the whole test.
async fn spawn_pair() -> (Vec<(Address, String)>, Vec<Arc<Clob>>) {
    let mut listeners = Vec::new();
    let mut urls = Vec::new();
    for _ in 0..2 {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        urls.push(format!("http://{}", l.local_addr().unwrap()));
        listeners.push(l);
    }
    let operators: Vec<(Address, String)> = OP_KEYS
        .iter()
        .zip(&urls)
        .map(|(k, u)| (Signer::from_hex(k).unwrap().address(), u.clone()))
        .collect();
    let cfg = ClobConfig {
        epoch_secs: 3600,
        threshold: 2,
        operators: operators.clone(),
    };

    let mut clobs = Vec::new();
    for (key, listener) in OP_KEYS.iter().zip(listeners) {
        let venue = Arc::new(venue_with(key));
        let clob = Arc::new(Clob::new(venue, cfg.clone()).unwrap());
        let app = surplus_operator::clob::router(clob.clone());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        clobs.push(clob);
    }
    (operators, clobs)
}

fn elected_index(operators: &[(Address, String)], epoch: u64) -> usize {
    let mut addrs: Vec<Address> = operators.iter().map(|(a, _)| *a).collect();
    addrs.sort_unstable();
    let winner = addrs[(epoch % addrs.len() as u64) as usize];
    operators.iter().position(|(a, _)| *a == winner).unwrap()
}

#[tokio::test]
async fn two_nodes_gossip_cosign_and_prune() {
    let (operators, _clobs) = spawn_pair().await;
    let http = reqwest::Client::new();

    // A crossing pair, entering the market at DIFFERENT nodes.
    let sell = signed_wire(SIDE_SELL, 15_000_000, 10_000, SELLER_KEY, 1);
    let buy = signed_wire(SIDE_BUY, 15_000_000, 10_000, BUYER_KEY, 2);
    let r = http
        .post(format!("{}/clob/order", operators[0].1))
        .json(&sell)
        .send()
        .await
        .unwrap();
    assert!(r.status().is_success(), "{}", r.text().await.unwrap());
    let r = http
        .post(format!("{}/clob/order", operators[1].1))
        .json(&buy)
        .send()
        .await
        .unwrap();
    assert!(r.status().is_success(), "{}", r.text().await.unwrap());

    // Gossip converges: both pools hold both orders.
    for url in [&operators[0].1, &operators[1].1] {
        let mut size = 0;
        for _ in 0..50 {
            let s: serde_json::Value = http
                .get(format!("{url}/clob/status"))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            size = s["poolSize"].as_u64().unwrap();
            if size == 2 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert_eq!(size, 2, "gossip did not converge at {url}");
    }

    // The elected proposer runs the epoch: propose → peer re-verifies → co-sign
    // → 2-of-2 quorum (dry submit).
    let epoch = now() / 3600;
    let leader = elected_index(&operators, epoch);
    let report: serde_json::Value = http
        .post(format!("{}/clob/run-epoch", operators[leader].1))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let batches = report["batches"].as_array().unwrap();
    assert_eq!(batches.len(), 1, "one instrument, one batch: {report}");
    assert_eq!(batches[0]["quorum"], true, "{report}");
    assert_eq!(batches[0]["fills"], 1, "{report}");
    assert_eq!(batches[0]["tx"], "dry");

    // The non-elected node refuses to run the epoch.
    let r = http
        .post(format!("{}/clob/run-epoch", operators[1 - leader].1))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), reqwest::StatusCode::CONFLICT);

    // Both nodes pruned the filled orders — the batch cannot re-match.
    for url in [&operators[0].1, &operators[1].1] {
        let s: serde_json::Value = http
            .get(format!("{url}/clob/status"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(
            s["poolSize"], 0,
            "filled orders must leave the pool at {url}"
        );
    }
}

#[tokio::test]
async fn forged_and_impersonated_proposals_rejected() {
    let (operators, _clobs) = spawn_pair().await;
    let http = reqwest::Client::new();
    let dom = surplus_settlement::domain(CHAIN_ID, CONTRACT.parse().unwrap());
    let epoch = now() / 3600;
    let leader = elected_index(&operators, epoch);
    let peer_url = &operators[1 - leader].1;

    // Forgery: an order claiming the buyer's address but signed by the seller —
    // a proposer trying to spend a balance it doesn't own. The peer must refuse.
    let honest_sell = signed_wire(SIDE_SELL, 15_000_000, 10_000, SELLER_KEY, 1);
    let mut forged_buy = signed_wire(SIDE_BUY, 15_000_000, 10_000, SELLER_KEY, 2);
    forged_buy.order.trader = Signer::from_hex(BUYER_KEY).unwrap().address();

    let to_signed = |w: &WireOrder| surplus_settlement::SignedOrder {
        order: w.order.clone(),
        signature: surplus_settlement::core::hex::decode(w.signature.trim_start_matches("0x"))
            .unwrap(),
    };
    let orders = vec![to_signed(&honest_sell), to_signed(&forged_buy)];
    let inner: Vec<Order> = orders.iter().map(|s| s.order.clone()).collect();
    let batch = surplus_matcher::match_epoch(INSTRUMENT, 1000, 1000, &dom, &inner);
    assert!(
        !batch.fills.is_empty(),
        "the forged pair must cross for the test to bite"
    );

    let proposal = WireProposal {
        epoch,
        batch_nonce: 0,
        instrument_id: INSTRUMENT.into(),
        proposer: operators[leader].0,
        orders: orders.clone(),
        fills_hash: batch.fills_hash,
    };
    let r = http
        .post(format!("{peer_url}/clob/propose"))
        .json(&proposal)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), reqwest::StatusCode::UNPROCESSABLE_ENTITY);
    let body: serde_json::Value = r.json().await.unwrap();
    assert_eq!(body["verdict"], "forged", "{body}");

    // Impersonation: correct content, wrong proposer for the epoch → refused.
    let impostor = WireProposal {
        epoch,
        batch_nonce: 0,
        instrument_id: INSTRUMENT.into(),
        proposer: operators[1 - leader].0,
        orders: vec![to_signed(&honest_sell)],
        fills_hash: surplus_matcher::match_epoch(
            INSTRUMENT,
            1000,
            1000,
            &dom,
            &[honest_sell.order.clone()],
        )
        .fills_hash,
    };
    let r = http
        .post(format!("{peer_url}/clob/propose"))
        .json(&impostor)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), reqwest::StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn tampered_fills_hash_rejected() {
    let (operators, _clobs) = spawn_pair().await;
    let http = reqwest::Client::new();
    let epoch = now() / 3600;
    let leader = elected_index(&operators, epoch);
    let peer_url = &operators[1 - leader].1;

    let sell = signed_wire(SIDE_SELL, 15_000_000, 10_000, SELLER_KEY, 1);
    let buy = signed_wire(SIDE_BUY, 15_000_000, 10_000, BUYER_KEY, 2);
    let to_signed = |w: &WireOrder| surplus_settlement::SignedOrder {
        order: w.order.clone(),
        signature: surplus_settlement::core::hex::decode(w.signature.trim_start_matches("0x"))
            .unwrap(),
    };

    // The proposer lies about the result (e.g., claims a different exec price).
    let proposal = WireProposal {
        epoch,
        batch_nonce: 0,
        instrument_id: INSTRUMENT.into(),
        proposer: operators[leader].0,
        orders: vec![to_signed(&sell), to_signed(&buy)],
        fills_hash: B256::repeat_byte(0xde),
    };
    let r = http
        .post(format!("{peer_url}/clob/propose"))
        .json(&proposal)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), reqwest::StatusCode::UNPROCESSABLE_ENTITY);
    let body: serde_json::Value = r.json().await.unwrap();
    assert_eq!(body["verdict"], "fills-hash-mismatch", "{body}");
}
