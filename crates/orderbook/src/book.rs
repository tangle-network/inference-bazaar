//! The book *location* seam — orthogonal to [`crate::MatchingEngine`].
//!
//! `MatchingEngine` decides *how* orders match; `BookClient` decides *where* the
//! authoritative book lives. A venue holds a `BookClient` per instrument and does
//! not care whether the book runs in-process ([`LocalBook`]) or, in the shared
//! book, in the process of whichever operator is the elected matcher for the
//! epoch (a future `RemoteBook` forwarding signed orders over the wire). This is
//! what lets every operator market-make on **one** book without each running its
//! own — the per-operator-island problem the shared CLOB exists to fix.
//!
//! The trait is async because a remote book is a network round-trip. The local
//! impl is a thin lock over the sync, deterministic `NativeBook` kernel: matching
//! stays single-threaded so peers (Attested) and the SP1 circuit (Proven) can
//! re-execute it bit-for-bit.

use std::sync::Mutex;

use async_trait::async_trait;

use crate::engine::MatchingEngine;
use crate::native::NativeBook;
use crate::types::{BookSnapshot, MatchError, Order, PlaceOutcome};

/// Where a venue sends orders for one instrument. Held behind `Arc`/`Box`; the
/// venue is agnostic to local vs remote.
#[async_trait]
pub trait BookClient: Send + Sync {
    /// The instrument this book makes a market in.
    fn instrument_id(&self) -> &str;

    /// Place an order: match against the book (price-time priority), rest any
    /// remainder. Returns the prints produced plus the resting remainder.
    async fn place(&self, order: Order) -> Result<PlaceOutcome, MatchError>;

    /// Cancel a resting order by id. Returns whether it was found.
    async fn cancel(&self, order_id: &str) -> bool;

    /// Aggregated depth snapshot, up to `depth` levels per side.
    async fn snapshot(&self, depth: usize) -> BookSnapshot;

    async fn best_bid(&self) -> Option<i64>;
    async fn best_ask(&self) -> Option<i64>;

    /// This owner's resting orders (for cancel-replace by a market maker).
    async fn open_orders(&self, owner: &str) -> Vec<Order>;
}

/// In-process book: this operator owns and runs the matching engine. The single
/// case today, and in the shared book the case where this operator is the elected
/// matcher for the epoch. The `Mutex` serializes access so matching stays
/// single-threaded and deterministic — the property the Attested / Proven
/// settlement paths depend on.
pub struct LocalBook<E: MatchingEngine = NativeBook> {
    instrument_id: String,
    engine: Mutex<E>,
}

impl<E: MatchingEngine> LocalBook<E> {
    pub fn new(engine: E) -> Self {
        Self {
            instrument_id: engine.instrument_id().to_string(),
            engine: Mutex::new(engine),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, E> {
        // A poisoned lock means a prior panic mid-match; the book state is still
        // structurally valid (no await is ever held across this lock), so recover
        // rather than cascade the panic.
        self.engine.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[async_trait]
impl<E: MatchingEngine + Send> BookClient for LocalBook<E> {
    fn instrument_id(&self) -> &str {
        &self.instrument_id
    }

    async fn place(&self, order: Order) -> Result<PlaceOutcome, MatchError> {
        self.lock().place(order)
    }

    async fn cancel(&self, order_id: &str) -> bool {
        self.lock().cancel(order_id)
    }

    async fn snapshot(&self, depth: usize) -> BookSnapshot {
        self.lock().snapshot(depth)
    }

    async fn best_bid(&self) -> Option<i64> {
        self.lock().best_bid()
    }

    async fn best_ask(&self) -> Option<i64> {
        self.lock().best_ask()
    }

    async fn open_orders(&self, owner: &str) -> Vec<Order> {
        self.lock().open_orders(owner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Side;

    fn ord(id: &str, side: Side, price: i64, qty: i64, owner: &str, ts: i64) -> Order {
        Order {
            id: id.into(),
            instrument_id: "m".into(),
            side,
            price,
            qty,
            owner: owner.into(),
            ts,
        }
    }

    fn book() -> LocalBook {
        LocalBook::new(NativeBook::new("m", 1, 1))
    }

    /// LocalBook is a faithful pass-through: a crossing order produces exactly the
    /// engine's fills, and best-bid/ask reflect the resting remainder.
    #[tokio::test]
    async fn local_book_places_matches_and_rests() {
        let b = book();
        // Resting ask, then a crossing bid lifts it.
        let out = b
            .place(ord("a1", Side::Sell, 100, 10, "mm", 1))
            .await
            .unwrap();
        assert!(out.fills.is_empty());
        assert_eq!(b.best_ask().await, Some(100));

        let out = b
            .place(ord("b1", Side::Buy, 100, 6, "taker", 2))
            .await
            .unwrap();
        assert_eq!(out.fills.len(), 1);
        let f = &out.fills[0];
        assert_eq!(f.price, 100);
        assert_eq!(f.qty, 6);
        assert_eq!(f.maker_owner, "mm");
        assert_eq!(f.taker_owner, "taker");
        // 4 left resting on the ask.
        assert_eq!(b.best_ask().await, Some(100));
        let open = b.open_orders("mm").await;
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].qty, 4);
    }

    #[tokio::test]
    async fn local_book_cancel_and_snapshot() {
        let b = book();
        b.place(ord("a1", Side::Sell, 101, 5, "mm", 1))
            .await
            .unwrap();
        b.place(ord("b1", Side::Buy, 99, 5, "mm", 2)).await.unwrap();
        let snap = b.snapshot(10).await;
        assert_eq!(snap.bids.len(), 1);
        assert_eq!(snap.asks.len(), 1);
        assert!(b.cancel("a1").await);
        assert!(!b.cancel("a1").await); // already gone
        assert_eq!(b.best_ask().await, None);
        assert_eq!(b.best_bid().await, Some(99));
    }

    /// Behavioural parity: LocalBook fed the same orders yields the same fills as
    /// driving NativeBook directly — the wrapper adds no matching behaviour.
    #[tokio::test]
    async fn local_book_matches_native_engine() {
        let orders = [
            ord("a1", Side::Sell, 100, 10, "mm", 1),
            ord("a2", Side::Sell, 102, 10, "mm", 2),
            ord("b1", Side::Buy, 103, 15, "taker", 3),
        ];

        let mut native = NativeBook::new("m", 1, 1);
        let mut native_fills = Vec::new();
        for o in &orders {
            native_fills.extend(native.place(o.clone()).unwrap().fills);
        }

        let lb = book();
        let mut lb_fills = Vec::new();
        for o in &orders {
            lb_fills.extend(lb.place(o.clone()).await.unwrap().fills);
        }

        assert_eq!(native_fills, lb_fills);
        assert_eq!(native.best_ask(), lb.best_ask().await);
        assert_eq!(native.best_bid(), lb.best_bid().await);
    }
}
