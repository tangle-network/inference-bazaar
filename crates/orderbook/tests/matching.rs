use surplus_orderbook::{MatchError, MatchingEngine, NativeBook, Order, Side};

const INST: &str = "anthropic/claude-opus-4-8:output";

fn book() -> NativeBook {
    NativeBook::new(INST, 1000, 1000)
}

fn order(id: &str, side: Side, price: i64, qty: i64, owner: &str, ts: i64) -> Order {
    Order {
        id: id.to_string(),
        instrument_id: INST.to_string(),
        side,
        price,
        qty,
        owner: owner.to_string(),
        ts,
    }
}

#[test]
fn rests_non_crossing_and_reports_top_of_book() {
    let mut b = book();
    b.place(order("b1", Side::Buy, 99_000, 5000, "u1", 1))
        .unwrap();
    b.place(order("a1", Side::Sell, 101_000, 5000, "u2", 2))
        .unwrap();
    assert_eq!(b.best_bid(), Some(99_000));
    assert_eq!(b.best_ask(), Some(101_000));
    assert_eq!(b.mid(), Some(100_000));
}

#[test]
fn matches_at_maker_price_with_price_time_priority() {
    let mut b = book();
    b.place(order("a", Side::Sell, 100_000, 3000, "s", 1))
        .unwrap();
    b.place(order("b", Side::Sell, 100_000, 3000, "s", 2))
        .unwrap();
    b.place(order("c", Side::Sell, 99_000, 1000, "s", 3))
        .unwrap();

    let out = b
        .place(order("t", Side::Buy, 100_000, 5000, "buyer", 4))
        .unwrap();
    let prints: Vec<(&str, i64, i64)> = out
        .fills
        .iter()
        .map(|f| (f.maker_order_id.as_str(), f.qty, f.price))
        .collect();
    // best price first (c@99k), then time priority at 100k (a before b)
    assert_eq!(
        prints,
        vec![
            ("c", 1000, 99_000),
            ("a", 3000, 100_000),
            ("b", 1000, 100_000)
        ]
    );
    assert!(out.resting.is_none());
}

#[test]
fn rests_unfilled_remainder() {
    let mut b = book();
    b.place(order("a", Side::Sell, 100_000, 2000, "s", 1))
        .unwrap();
    let out = b
        .place(order("t", Side::Buy, 100_000, 5000, "buyer", 2))
        .unwrap();
    assert_eq!(out.fills.len(), 1);
    assert_eq!(out.resting.as_ref().unwrap().qty, 3000);
    assert_eq!(b.best_bid(), Some(100_000));
}

#[test]
fn prevents_self_match_by_cancelling_resting_maker() {
    let mut b = book();
    b.place(order("mine", Side::Sell, 100_000, 2000, "mm", 1))
        .unwrap();
    let out = b
        .place(order("t", Side::Buy, 100_000, 2000, "mm", 2))
        .unwrap();
    assert!(out.fills.is_empty());
    // resting maker cancelled, taker remainder rests as a bid
    assert_eq!(b.best_bid(), Some(100_000));
    assert!(b.open_orders("mm").iter().any(|o| o.id == "t"));
    assert!(!b.open_orders("mm").iter().any(|o| o.id == "mine"));
}

#[test]
fn validates_tick_and_min_qty_and_duplicate_id() {
    let mut b = book();
    assert!(matches!(
        b.place(order("x", Side::Buy, 99_500, 2000, "u", 1)),
        Err(MatchError::OffTick { .. })
    ));
    assert!(matches!(
        b.place(order("x", Side::Buy, 99_000, 10, "u", 1)),
        Err(MatchError::BelowMinQty { .. })
    ));
    b.place(order("dup", Side::Buy, 99_000, 2000, "u", 1))
        .unwrap();
    assert!(matches!(
        b.place(order("dup", Side::Buy, 98_000, 2000, "u", 2)),
        Err(MatchError::DuplicateId(_))
    ));
}

#[test]
fn cancel_and_depth_snapshot() {
    let mut b = book();
    b.place(order("x", Side::Buy, 99_000, 2000, "u", 1))
        .unwrap();
    b.place(order("y", Side::Buy, 99_000, 3000, "v", 2))
        .unwrap();
    b.place(order("z", Side::Buy, 98_000, 1000, "w", 3))
        .unwrap();
    let snap = b.snapshot(10);
    assert_eq!(snap.bids.len(), 2);
    assert_eq!(snap.bids[0].price, 99_000);
    assert_eq!(snap.bids[0].qty, 5000);
    assert_eq!(snap.bids[0].orders, 2);
    assert!(b.cancel("x"));
    assert!(!b.cancel("x"));
    assert_eq!(b.snapshot(10).bids[0].qty, 3000);
}

#[test]
fn two_sided_market_seller_lists_buyer_lifts() {
    // The product flow: a seller lists surplus tokens (ask), an MM posts a bid,
    // a buyer crosses the ask.
    let mut b = book();
    b.place(order(
        "seller",
        Side::Sell,
        14_800_000,
        100_000,
        "seller_op",
        1,
    ))
    .unwrap();
    b.place(order(
        "mm_bid",
        Side::Buy,
        14_700_000,
        50_000,
        "operator-mm",
        2,
    ))
    .unwrap();
    let out = b
        .place(order("buyer", Side::Buy, 14_800_000, 60_000, "buyer1", 3))
        .unwrap();
    assert_eq!(out.fills.len(), 1);
    let f = &out.fills[0];
    assert_eq!(f.maker_owner, "seller_op");
    assert_eq!(f.taker_owner, "buyer1");
    assert_eq!(f.price, 14_800_000);
    assert_eq!(f.qty, 60_000);
    // $1.48/M * 60k tokens = 888_000 micro-tsUSD = $0.888
    assert_eq!(f.notional_micro(), 888_000);
}
