use crate::types::{BookSnapshot, MatchError, Order, PlaceOutcome};

/// The swappable matching-engine seam.
///
/// The operator depends on THIS, never on a concrete engine. The default is
/// [`crate::native::NativeBook`] (price-time priority, no third-party deps). An
/// `orderbook-rs` adapter, or a future zk-rollup-settled engine, plugs in here
/// by implementing the same six methods — the operator code does not change.
///
/// Mapping onto `orderbook-rs` (v0.8) for the optional adapter:
///   `place`     → `OrderBook::add_order` (matches on insert) → map `TradeResult`
///   `cancel`    → `OrderBook::cancel_order`
///   `best_bid`  → `OrderBook::best_bid`     `best_ask` → `OrderBook::best_ask`
///   `snapshot`  → `OrderBook::depth(side, levels)`
///   `open_orders` → filter `enriched_snapshot()` by `user_id`
pub trait MatchingEngine {
    /// The instrument this engine makes a market in.
    fn instrument_id(&self) -> &str;

    /// Place an order: match against the book (price-time priority), then rest
    /// any remainder. Matching happens on insert.
    fn place(&mut self, order: Order) -> Result<PlaceOutcome, MatchError>;

    /// Cancel a resting order by id. Returns whether it was found.
    fn cancel(&mut self, order_id: &str) -> bool;

    fn best_bid(&self) -> Option<i64>;
    fn best_ask(&self) -> Option<i64>;

    /// Aggregated depth snapshot, up to `depth` levels per side.
    fn snapshot(&self, depth: usize) -> BookSnapshot;

    /// This owner's resting orders (for cancel-replace by a market maker).
    fn open_orders(&self, owner: &str) -> Vec<Order>;
}
