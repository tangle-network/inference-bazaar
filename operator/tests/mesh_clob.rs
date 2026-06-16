//! Three-operator shared-CLOB e2e over the REAL blueprint-networking PKI mesh:
//! three whitelisted nodes handshake on a scoped topic, a crossing pair of
//! signed orders enters at two DIFFERENT operators and converges by gossip,
//! the elected proposer matches and broadcasts its proposal, both peers
//! independently re-verify and broadcast co-signatures, and the proposer
//! reaches quorum — the same consensus round the HTTP transport runs in
//! production, riding the mesh instead of peer URLs.
//!
//! Chain submission is exercised dry (no RPC); the on-chain leg of the same
//! digest/quorum flow is proven by Batch.t.sol and the live fleet.

use std::sync::Arc;
use std::time::Duration;

use blueprint_crypto::k256::K256Ecdsa;
use blueprint_networking::test_utils::{create_whitelisted_nodes, wait_for_all_handshakes};
use inference_bazaar_operator::clob::{Clob, ClobConfig, WireOrder};
use inference_bazaar_operator::config::{
    Instrument, OperatorConfig, QuoteParams, RiskLimits, SettlementConfig,
};
use inference_bazaar_operator::mesh::{spawn_mesh_loop, MeshNet};
use inference_bazaar_operator::Venue;
use inference_bazaar_settlement::core::alloy_primitives::{Address, B256};
use inference_bazaar_settlement::core::{instrument_hash, Order};
use inference_bazaar_settlement::{Signer, SIDE_BUY, SIDE_SELL};

const INSTRUMENT: &str = "anthropic/claude-opus-4-8:output";
const CONTRACT: &str = "0x00000000000000000000000000000000000000cc";
const CHAIN_ID: u64 = 31_337;

// Well-known Anvil keys — test material only.
const OP_KEYS: [&str; 3] = [
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
];
const SELLER_KEY: &str = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";
const BUYER_KEY: &str = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";

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
            submitter_key: None,
            rpc_url: None, // dry submit — the consensus round still runs fully
            rfq_ttl_secs: 120,
            from_block: 0,
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
    let dom = inference_bazaar_settlement::domain(CHAIN_ID, CONTRACT.parse().unwrap());
    let signed = signer.sign_order(&order, &dom);
    WireOrder {
        instrument_id: INSTRUMENT.into(),
        order: signed.order,
        signature: format!(
            "0x{}",
            inference_bazaar_settlement::core::hex::encode(signed.signature)
        ),
    }
}

fn elected_index(operators: &[(Address, String)], epoch: u64) -> usize {
    let mut addrs: Vec<Address> = operators.iter().map(|(a, _)| *a).collect();
    addrs.sort_unstable();
    let winner = addrs[(epoch % addrs.len() as u64) as usize];
    operators.iter().position(|(a, _)| *a == winner).unwrap()
}

fn pool_size(clob: &Clob) -> u64 {
    clob.status()["poolSize"].as_u64().unwrap_or(0)
}

/// The full consensus round over the real PKI mesh. Epoch length is one hour so
/// the elected proposer is stable for the whole test.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn three_nodes_gossip_cosign_over_pki_mesh() {
    blueprint_networking::test_utils::setup_log();
    // Three whitelisted mesh nodes: every node's handshake is verified against
    // the shared key set — the PKI gate the HTTP transport never had.
    let mut nodes =
        create_whitelisted_nodes::<K256Ecdsa>(3, "inference-bazaar-clob", "test", false);
    let mut handles = Vec::new();
    for n in &mut nodes {
        handles.push(n.start().await.expect("mesh node starts"));
    }
    {
        let refs: Vec<&mut _> = handles.iter_mut().collect();
        wait_for_all_handshakes(&refs, Duration::from_secs(60)).await;
    }

    let operators: Vec<(Address, String)> = OP_KEYS
        .iter()
        .map(|k| (Signer::from_hex(k).unwrap().address(), "mesh".to_string()))
        .collect();
    let cfg = ClobConfig {
        book_id: B256::ZERO,
        epoch_secs: 3600,
        threshold: 2,
        operators: operators.clone(),
    };

    let mut clobs: Vec<Arc<Clob>> = Vec::new();
    for (key, handle) in OP_KEYS.iter().zip(&handles) {
        let venue = Arc::new(venue_with(key));
        let net = MeshNet::new(handle.clone(), 3600);
        let clob = Arc::new(Clob::with_net(venue, cfg.clone(), net.clone()).unwrap());
        spawn_mesh_loop(clob.clone(), net, handle.clone());
        clobs.push(clob);
    }

    // A crossing pair entered at DIFFERENT operators. Resubmit on a timer until
    // every pool holds both orders — admission is idempotent by digest, and
    // gossipsub needs a beat to graft the topic mesh after handshakes.
    let sell = signed_wire(SIDE_SELL, 1_000_000, 10_000, SELLER_KEY, 1);
    let buy = signed_wire(SIDE_BUY, 1_000_000, 10_000, BUYER_KEY, 2);
    let converge_deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let _ = clobs[0].submit_order(sell.clone());
        let _ = clobs[1].submit_order(buy.clone());
        if clobs.iter().all(|c| pool_size(c) == 2) {
            break;
        }
        assert!(
            tokio::time::Instant::now() < converge_deadline,
            "order pools did not converge over the mesh: sizes {:?}",
            clobs.iter().map(|c| pool_size(c)).collect::<Vec<_>>()
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    // The elected proposer runs the epoch: match -> broadcast proposal over the
    // mesh -> peers independently re-verify + co-sign -> quorum (2-of-3).
    let epoch = clobs[0].current_epoch();
    let proposer = elected_index(&operators, epoch);
    let report = clobs[proposer].run_epoch(epoch).await;

    let batches = report["batches"].as_array().expect("batches array");
    assert_eq!(batches.len(), 1, "one instrument batch: {report}");
    assert_eq!(batches[0]["quorum"], true, "quorum over mesh: {report}");
    assert_eq!(batches[0]["fills"], 1, "one crossed fill: {report}");
    assert_eq!(batches[0]["tx"], "dry", "dry submit without RPC: {report}");

    // Finality pruning: the proposer pruned at quorum; peers pruned when they
    // co-signed. Filled orders must never re-match in a later epoch.
    let prune_deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while clobs.iter().any(|c| pool_size(c) != 0) {
        assert!(
            tokio::time::Instant::now() < prune_deadline,
            "pools not pruned after settlement: sizes {:?}",
            clobs.iter().map(|c| pool_size(c)).collect::<Vec<_>>()
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}
