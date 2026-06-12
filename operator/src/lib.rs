//! Surplus operator library.
//!
//! The venue (open orderbook + sidecar quoting + settlement intents) lives here
//! so BOTH bins drive the same market:
//!   - `surplus-operator-lite` (src/main.rs): HTTP venue only, no Tangle substrate.
//!   - `surplus-operator`      (src/bin/blueprint.rs, feature `blueprint`): the
//!     full BlueprintRunner — the venue runs as a BackgroundService and on-chain
//!     jobs (workflow_tick, list_instrument, status) drive it.

pub mod clob;
pub mod config;
pub mod http;
pub mod inference;
pub mod market;
#[cfg(feature = "mesh")]
pub mod mesh;
pub mod ratelimit;
pub mod redeem;
pub mod sidecar;
pub mod spend;
pub mod venue;

pub use venue::{Venue, VenueError};
