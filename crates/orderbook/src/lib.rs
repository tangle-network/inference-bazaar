//! Open orderbook for inference-token credit markets.
//!
//! The blueprint's core market mechanic: a price-time-priority limit orderbook
//! that the operator hosts off-chain, with fills cleared on-chain by the
//! settlement layer (the SOTA hybrid — off-chain matching, on-chain settlement,
//! cf. 0x / dYdX v3).
//!
//! [`MatchingEngine`] is the swappable seam: [`NativeBook`] is the default
//! (no third-party deps); `orderbook-rs` or a future zk-settled engine plug in
//! behind the same trait without changing operator code.

mod engine;
mod native;
mod types;

pub use engine::MatchingEngine;
pub use native::NativeBook;
pub use types::{
    BookLevel, BookSnapshot, Fill, MatchError, Order, PlaceOutcome, Side,
};
