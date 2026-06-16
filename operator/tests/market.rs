//! Venue-level integration of the firm-quote market: RFQ quoting against a
//! stub sidecar, countersign + fill, signed CLOB crossing, and the outbox.

use inference_bazaar_operator::config::{
    Instrument, OperatorConfig, QuoteParams, RiskLimits, SettlementConfig,
};
use inference_bazaar_operator::market::{RfqFillBody, SignedOrderBody};
use inference_bazaar_operator::Venue;
use inference_bazaar_settlement::core::alloy_primitives::B256;
use inference_bazaar_settlement::{domain, instrument_hash, Order, Signer, SIDE_BUY};
use std::sync::Arc;

const INSTRUMENT: &str = "anthropic/claude-opus-4-8:output";
const CONTRACT: &str = "0x1111111111111111111111111111111111111111";
const OPERATOR_KEY: &str = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BUYER_KEY: &str = "0x2222222222222222222222222222222222222222222222222222222222222222";

/// Stub mm-sidecar: always quotes a tight, valid two-sided market.
async fn spawn_stub_sidecar() -> String {
    use axum::{routing::post, Json, Router};
    let app = Router::new().route(
        "/quote",
        post(|| async {
            Json(serde_json::json!({
                "instrumentId": INSTRUMENT,
                "bid": { "price": 14_990_000.0, "qty": 50_000.0 },
                "ask": { "price": 15_010_000.0, "qty": 50_000.0 },
                "rationale": "stub",
                "valid": true,
                "score": 1.0,
                "reasons": [],
                "killSwitch": false
            }))
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

fn venue_with(sidecar_url: String) -> Venue {
    Venue::new(OperatorConfig {
        sidecar_url,
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
            chain_id: 31_337,
            contract: CONTRACT.into(),
            operator_key: Some(OPERATOR_KEY.into()),
            submitter_key: None,
            rpc_url: None,
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

#[tokio::test]
async fn rfq_quote_countersign_fill_outbox() {
    let venue = Arc::new(venue_with(spawn_stub_sidecar().await));
    venue.set_ref(INSTRUMENT, 15_000_000.0).unwrap();

    // 1. RFQ: buyer asks to buy 30k tokens; operator returns a signed firm ask.
    let quote = venue
        .rfq_quote(INSTRUMENT, inference_bazaar_orderbook::Side::Buy, 30_000)
        .await
        .unwrap();
    assert_eq!(quote["quoting"], true);
    let maker_order: Order = serde_json::from_value(quote["order"].clone()).unwrap();
    assert_eq!(maker_order.side, 1, "taker buys => maker sells");
    assert_eq!(maker_order.qtyTokens, 30_000);
    assert_eq!(maker_order.priceMicroPerM % 1000, 0, "tick aligned");
    assert!(
        maker_order.priceMicroPerM >= 15_010_000,
        "ask never better than risk gate"
    );
    assert!(maker_order.expiry >= now() + 100, "firm TTL");

    // The signature is real and verifies under the settlement domain.
    let dom = domain(31_337, CONTRACT.parse().unwrap());
    let sig = quote["signature"].as_str().unwrap();
    let sig_bytes =
        inference_bazaar_settlement::core::hex::decode(sig.trim_start_matches("0x")).unwrap();
    assert!(inference_bazaar_settlement::verify_order(
        &maker_order,
        &sig_bytes,
        &dom
    ));

    // 2. Buyer countersigns and hits the quote.
    let buyer = Signer::from_hex(BUYER_KEY).unwrap();
    let taker = buyer.sign_order(
        &Order {
            instrument: instrument_hash(INSTRUMENT),
            side: SIDE_BUY,
            priceMicroPerM: maker_order.priceMicroPerM,
            qtyTokens: 30_000,
            lotId: B256::ZERO,
            trader: buyer.address(),
            expiry: now() + 300,
            salt: B256::with_last_byte(9),
        },
        &dom,
    );
    let result = venue
        .rfq_fill(RfqFillBody {
            maker: SignedOrderBody {
                instrument_id: INSTRUMENT.into(),
                order: maker_order.clone(),
                signature: sig.to_string(),
            },
            taker: SignedOrderBody {
                instrument_id: INSTRUMENT.into(),
                order: taker.order.clone(),
                signature: inference_bazaar_settlement::core::hex::encode_prefixed(
                    &taker.signature,
                ),
            },
        })
        .unwrap();
    assert_eq!(result["filled"], true);
    assert_eq!(result["qtyTokens"], 30_000);
    assert_eq!(
        result["execPriceMicroPerM"], maker_order.priceMicroPerM,
        "maker price"
    );
    assert_eq!(result["outboxLen"], 1);

    // Operator sold 30k => inventory -30k.
    let snap = venue.snapshot(INSTRUMENT).unwrap();
    assert_eq!(snap["inventoryTokens"], -30_000);

    // 3. Refilling the same pair only has 0 remaining on the taker => rejected.
    let again = venue.rfq_fill(RfqFillBody {
        maker: SignedOrderBody {
            instrument_id: INSTRUMENT.into(),
            order: maker_order,
            signature: sig.to_string(),
        },
        taker: SignedOrderBody {
            instrument_id: INSTRUMENT.into(),
            order: taker.order,
            signature: inference_bazaar_settlement::core::hex::encode_prefixed(&taker.signature),
        },
    });
    assert!(again.is_err(), "venue-side fill bookkeeping caps reuse");

    // 4. Outbox carries the settleable fill; dry flush keeps it.
    let outbox = venue.outbox_json();
    assert_eq!(outbox["count"], 1);
    let flush = venue.flush_settlement().await.unwrap();
    assert_eq!(flush["mode"], "dry");
    assert_eq!(
        venue.outbox_json()["count"],
        1,
        "dry flush preserves the outbox"
    );
}

#[tokio::test]
async fn signed_clob_orders_cross_and_pair() {
    let venue = Arc::new(venue_with(spawn_stub_sidecar().await));
    venue.set_ref(INSTRUMENT, 15_000_000.0).unwrap();
    let dom = domain(31_337, CONTRACT.parse().unwrap());

    let seller =
        Signer::from_hex("0x3333333333333333333333333333333333333333333333333333333333333333")
            .unwrap();
    let buyer = Signer::from_hex(BUYER_KEY).unwrap();

    let ask = seller.sign_order(
        &Order {
            instrument: instrument_hash(INSTRUMENT),
            side: 1,
            priceMicroPerM: 15_000_000,
            qtyTokens: 40_000,
            lotId: B256::ZERO,
            trader: seller.address(),
            expiry: now() + 300,
            salt: B256::with_last_byte(1),
        },
        &dom,
    );
    let resting = venue
        .place_signed(SignedOrderBody {
            instrument_id: INSTRUMENT.into(),
            order: ask.order.clone(),
            signature: inference_bazaar_settlement::core::hex::encode_prefixed(&ask.signature),
        })
        .unwrap();
    assert!(resting["resting"].is_object(), "ask rests");
    assert_eq!(resting["signedFills"], 0);

    // Tampered signature is rejected at intake.
    let mut bad = ask.order.clone();
    bad.qtyTokens = 99_999;
    assert!(venue
        .place_signed(SignedOrderBody {
            instrument_id: INSTRUMENT.into(),
            order: bad,
            signature: inference_bazaar_settlement::core::hex::encode_prefixed(&ask.signature),
        })
        .is_err());

    // Crossing buy pairs into a settleable fill at the maker's price.
    let bid = buyer.sign_order(
        &Order {
            instrument: instrument_hash(INSTRUMENT),
            side: 0,
            priceMicroPerM: 15_200_000,
            qtyTokens: 25_000,
            lotId: B256::ZERO,
            trader: buyer.address(),
            expiry: now() + 300,
            salt: B256::with_last_byte(2),
        },
        &dom,
    );
    let crossed = venue
        .place_signed(SignedOrderBody {
            instrument_id: INSTRUMENT.into(),
            order: bid.order,
            signature: inference_bazaar_settlement::core::hex::encode_prefixed(&bid.signature),
        })
        .unwrap();
    assert_eq!(crossed["signedFills"], 1);
    assert_eq!(crossed["fills"][0]["price"], 15_000_000, "maker price");
    assert_eq!(crossed["fills"][0]["qty"], 25_000);
    assert_eq!(venue.outbox_json()["count"], 1);
}

/// The operator-control jobs (configure / start_making / stop_making): a stopped
/// market refuses to quote BEFORE touching the sidecar, and configure retunes
/// the live knobs. Mirrors the blueprint job handlers that call these.
#[tokio::test]
async fn jobs_configure_start_stop_making() {
    let venue = Arc::new(venue_with(spawn_stub_sidecar().await));
    venue.set_ref(INSTRUMENT, 15_000_000.0).unwrap();

    // configure (job 1): the supplied knobs become the effective values.
    let cfg = venue.configure(Some(123_000.0), Some(900_000.0), Some(7.0));
    assert_eq!(cfg["size"].as_f64().unwrap(), 123_000.0);
    assert_eq!(cfg["maxInventory"].as_f64().unwrap(), 900_000.0);
    assert_eq!(cfg["minSpreadBps"].as_f64().unwrap(), 7.0);
    // omitted knobs are preserved on a later partial configure.
    let cfg2 = venue.configure(Some(50_000.0), None, None);
    assert_eq!(cfg2["size"].as_f64().unwrap(), 50_000.0);
    assert_eq!(
        cfg2["maxInventory"].as_f64().unwrap(),
        900_000.0,
        "max inventory kept"
    );

    // stop_making (job 3): mm_tick short-circuits to "stopped" before the sidecar.
    venue.stop_making(INSTRUMENT).unwrap();
    let stopped = venue.mm_tick(INSTRUMENT).await.unwrap();
    assert_eq!(stopped["quoting"], false);
    assert_eq!(stopped["reasons"][0], "stopped");

    // start_making (job 2): quoting re-enabled — mm_tick reaches the sidecar and
    // quotes (the stub returns a valid two-sided quote), so it's no longer "stopped".
    venue.start_making(INSTRUMENT).unwrap();
    let resumed = venue.mm_tick(INSTRUMENT).await.unwrap();
    assert_ne!(resumed["reasons"][0], "stopped", "no longer stopped");
}
