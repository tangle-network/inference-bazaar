//! Types crossing the host/guest boundary of the batch-validity program.

use serde::{Deserialize, Serialize};
use surplus_settlement_core::alloy_primitives::{Address, B256};
use surplus_settlement_core::Order;

/// One fill whose signatures the program verifies.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProvenFill {
    pub buy: Order,
    pub buy_sig: Vec<u8>,
    pub sell: Order,
    pub sell_sig: Vec<u8>,
    pub qty_tokens: u64,
    pub exec_price_micro_per_m: u64,
}

/// Program input. chain id + contract pin the EIP-712 domain, so a proof can
/// only verify against the one SurplusSettlement deployment it was made for —
/// the program commits the resulting domain separator as a public value.
/// `book_id` + `batch_nonce` are committed too, binding the proof to one book at
/// one nonce (`settleBatchProven` re-derives them from on-chain book state).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProgramInput {
    pub chain_id: u64,
    pub verifying_contract: Address,
    pub book_id: B256,
    pub batch_nonce: u64,
    pub fills: Vec<ProvenFill>,
}
