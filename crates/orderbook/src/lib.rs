//! Open orderbook for inference-token credit markets.
//!
//! The blueprint's core market mechanic: a price-time-priority limit orderbook
//! that the operator hosts off-chain, with fills cleared on-chain by the
//! settlement layer (the SOTA hybrid — off-chain matching, on-chain settlement,
//! cf. 0x / dYdX v3).
//!
//! Two seams, two axes:
//!   - [`MatchingEngine`] — *how* orders match. [`NativeBook`] is the canonical
//!     engine, hand-rolled for **verifiable re-execution** (deterministic,
//!     integer-only, clockless) so peers and an SP1 circuit reproduce its fills
//!     bit-for-bit. `orderbook-rs` is a semantics reference, not a swap-in.
//!   - [`BookClient`] — *where* the book lives. [`LocalBook`] runs the engine
//!     in-process (single operator, or the epoch-matcher itself); a future
//!     `RemoteBook` will forward to the elected matcher over the wire, so a
//!     venue can market-make on one shared book it does not own. This seam is
//!     async and std-only (feature `std`); the matching kernel below is no_std.
//!
//! The crate is `no_std` (with `alloc`) by default-off: the kernel
//! ([`NativeBook`], [`MatchingEngine`], [`types`]) builds in the SP1 zkVM guest
//! so the proven path can reproduce a match in-circuit. The `std` feature adds
//! the async [`BookClient`] location seam used off-chain by the operator.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

#[cfg(feature = "std")]
mod book;
mod engine;
mod native;
mod types;

#[cfg(feature = "std")]
pub use book::{BookClient, LocalBook};
pub use engine::MatchingEngine;
pub use native::NativeBook;
pub use types::{BookLevel, BookSnapshot, Fill, MatchError, Order, PlaceOutcome, Side};
