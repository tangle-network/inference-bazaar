//! Types crossing the host/guest boundary of the batch-validity program.

use serde::{Deserialize, Serialize};
use surplus_settlement_core::alloy_primitives::{Address, B256};
use surplus_settlement_core::Order;

/// One signed order in the gossiped epoch set the guest matches in-circuit.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProvenOrder {
    pub order: Order,
    pub sig: Vec<u8>,
}

/// Program input for the match-in-circuit proven path.
///
/// chain id + contract pin the EIP-712 domain, so a proof can only verify against
/// the one SurplusSettlement deployment it was made for. `book_id` + `batch_nonce`
/// bind it to one book at one nonce. The guest verifies every order's signature,
/// runs `match_epoch` over the SET (the same kernel peers re-run and the venue
/// uses), and commits `(domainSeparator, bookId, batchNonce, ordersCommitment,
/// fillsHash)` — so the proof attests the fills are the canonical match of this
/// exact authentically-signed set, not merely that some chosen fills were signed.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProgramInput {
    pub chain_id: u64,
    pub verifying_contract: Address,
    pub book_id: B256,
    pub batch_nonce: u64,
    pub instrument_id: String,
    pub tick_size: i64,
    pub min_qty: i64,
    pub orders: Vec<ProvenOrder>,
}
