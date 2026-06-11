//! Types crossing the host/guest boundary of the batch-validity program.

use serde::{Deserialize, Serialize};
use surplus_settlement_core::alloy_primitives::Address;
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
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProgramInput {
    pub chain_id: u64,
    pub verifying_contract: Address,
    pub fills: Vec<ProvenFill>,
}
