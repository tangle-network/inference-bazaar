//! `ClobConfig` — the bonded operator set, quorum threshold, epoch length, and
//! matching book this node settles through, parsed from `INFERENCE_BAZAAR_CLOB_*`.

use inference_bazaar_settlement::core::alloy_primitives::{Address, B256};

#[derive(Clone, Debug)]
pub struct ClobConfig {
    /// The matching domain (contract `Book`) this fleet settles through —
    /// `INFERENCE_BAZAAR_CLOB_BOOK`, 0x-hex bytes32. Must be registered on-chain via
    /// `registerBook` with exactly this operator set. Default: the zero book.
    pub book_id: B256,
    pub epoch_secs: u64,
    /// Quorum size — must equal the contract's `attesterThreshold`.
    pub threshold: usize,
    /// The full bonded operator set, THIS node included: (attester address,
    /// base URL). Election and quorum run over exactly this list, so every node
    /// must be configured with the same set — it is the off-chain mirror of the
    /// contract's attester set.
    pub operators: Vec<(Address, String)>,
}

impl ClobConfig {
    /// `INFERENCE_BAZAAR_CLOB_OPERATORS="0xabc..=http://h1:9500,0xdef..=http://h2:9400"`
    /// plus `INFERENCE_BAZAAR_CLOB_THRESHOLD` (default 2) and `INFERENCE_BAZAAR_CLOB_EPOCH_SECS`
    /// (default 10). `Ok(None)` when unset — the shared CLOB is opt-in. A SET
    /// but malformed value is an ERROR, never a silent skip: a node that boots
    /// green while quietly not participating also stalls every peer that needs
    /// its co-signature for quorum.
    pub fn from_env() -> anyhow::Result<Option<Self>> {
        let Ok(raw) = std::env::var("INFERENCE_BAZAAR_CLOB_OPERATORS") else {
            return Ok(None);
        };
        let mut operators = Vec::new();
        for entry in raw.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            let (addr, url) = entry.split_once('=').ok_or_else(|| {
                anyhow::anyhow!("INFERENCE_BAZAAR_CLOB_OPERATORS entry '{entry}' is not 0xaddr=url")
            })?;
            let addr: Address = addr.trim().parse().map_err(|_| {
                anyhow::anyhow!("INFERENCE_BAZAAR_CLOB_OPERATORS entry '{entry}' has a bad address")
            })?;
            operators.push((addr, url.trim().trim_end_matches('/').to_string()));
        }
        anyhow::ensure!(
            !operators.is_empty(),
            "INFERENCE_BAZAAR_CLOB_OPERATORS is set but lists no operators"
        );
        let threshold = match std::env::var("INFERENCE_BAZAAR_CLOB_THRESHOLD") {
            Ok(v) => v.parse().map_err(|_| {
                anyhow::anyhow!("INFERENCE_BAZAAR_CLOB_THRESHOLD '{v}' is not a number")
            })?,
            Err(_) => 2,
        };
        let epoch_secs = match std::env::var("INFERENCE_BAZAAR_CLOB_EPOCH_SECS") {
            Ok(v) => {
                let secs: u64 = v.parse().map_err(|_| {
                    anyhow::anyhow!("INFERENCE_BAZAAR_CLOB_EPOCH_SECS '{v}' is not a number")
                })?;
                anyhow::ensure!(
                    secs >= 2,
                    "INFERENCE_BAZAAR_CLOB_EPOCH_SECS must be >= 2, got {secs}"
                );
                secs
            }
            Err(_) => 10,
        };
        let book_id = match std::env::var("INFERENCE_BAZAAR_CLOB_BOOK") {
            Ok(v) => v.parse().map_err(|_| {
                anyhow::anyhow!("INFERENCE_BAZAAR_CLOB_BOOK '{v}' is not bytes32 hex")
            })?,
            Err(_) => B256::ZERO,
        };
        Ok(Some(ClobConfig {
            book_id,
            epoch_secs,
            threshold,
            operators,
        }))
    }

    pub(crate) fn addresses(&self) -> Vec<Address> {
        self.operators.iter().map(|(a, _)| *a).collect()
    }
}
