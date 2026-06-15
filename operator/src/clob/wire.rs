//! The JSON wire types the transport carries: orders, cancels, proposals, and
//! co-signatures. All `camelCase` so the same body a client posts flows on to
//! peers unchanged.

use serde::{Deserialize, Serialize};
use inference_bazaar_settlement::core::alloy_primitives::{Address, B256};
use inference_bazaar_settlement::core::Order;
use inference_bazaar_settlement::SignedOrder;

use crate::market::SignedOrderBody;

/// Gossip relay body — identical shape to [`SignedOrderBody`] (which is
/// deserialize-only), so the same JSON a client posts to `/clob/order` flows on
/// to peers unchanged.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireOrder {
    pub instrument_id: String,
    pub order: Order,
    pub signature: String,
}

impl From<WireOrder> for SignedOrderBody {
    fn from(w: WireOrder) -> Self {
        SignedOrderBody {
            instrument_id: w.instrument_id,
            order: w.order,
            signature: w.signature,
        }
    }
}

/// A signed order cancel. `signature` is the trader's EIP-712 `InferenceBazaarCancel`
/// signature over `orderHash` (`cancel_digest`), the off-chain analogue of the
/// contract's `cancelOrder` (msg.sender == trader).
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireCancel {
    pub order_hash: B256,
    pub trader: Address,
    /// 65-byte r||s||v signature, 0x-hex.
    pub signature: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireProposal {
    pub epoch: u64,
    /// The matching domain (contract `Book`) — peers refuse foreign books.
    pub book_id: B256,
    pub batch_nonce: u64,
    pub instrument_id: String,
    pub proposer: Address,
    /// The proposer's 65-byte signature over `batch_digest(batchNonce,
    /// fillsHash)`, 0x-hex — the same signature it self-attests with. Proves
    /// the proposal really comes from the elected proposer; peers refuse
    /// co-sign side effects without it.
    pub proposer_sig: String,
    /// The matched order set, trader signatures included (`SignedOrder`
    /// serializes its signature as 0x-hex).
    pub orders: Vec<SignedOrder>,
    pub fills_hash: B256,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireAttestation {
    pub attester: Address,
    /// 65-byte r||s||v signature, 0x-hex.
    pub signature: String,
}
