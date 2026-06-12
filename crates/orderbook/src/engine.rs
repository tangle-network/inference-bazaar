use alloc::vec::Vec;

use crate::types::{BookSnapshot, MatchError, Order, PlaceOutcome};

/// The matching-engine seam: a single instrument's price-time-priority book.
///
/// The canonical engine is [`crate::native::NativeBook`], and it is hand-rolled
/// **deliberately, for verifiability** — not for lack of a library. In the shared
/// book this engine is re-executed by peer operators to co-sign a batch
/// (`settleBatchAttested`) and reproduced inside an SP1 circuit
/// (`settleBatchProven`). That demands a matcher that is **deterministic by
/// construction**: single-threaded, integer-only, reads no clock (`Order::ts` is
/// caller-supplied), and small enough to mirror in a circuit. A throughput-first
/// concurrent engine (e.g. `orderbook-rs` — lock-free DashMap/SegQueue/skiplist,
/// ~20k SLoC) is the wrong tool here: its event order is decided by thread races,
/// so two peers can derive different (each internally valid) fills from the same
/// orders, and its surface is impractical to prove. `orderbook-rs` is a useful
/// *reference* for matching semantics and integer newtypes — not a drop-in.
///
/// The trait stays the seam so tests can substitute a double and a future
/// zk-settled engine can slot in. The bar for any impl is bit-identical
/// re-execution, not speed; matching here is operator quotes, not HFT flow.
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
