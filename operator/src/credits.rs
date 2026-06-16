//! Credit discovery: which lots a holder can spend on a given model right now.
//!
//! The router (or any client) asks `GET /credits?owner=&model=&kind=` to learn
//! whether the holder has a usable credit issued by THIS operator before routing
//! inference here. The on-chain scan lives in the settlement crate
//! (`lots_issued_to`, real contract reads); the selection logic below is pure so
//! it is unit-tested without a chain — it mirrors the redemption adapter's
//! `selectCredit`: drop the wrong instrument / empty / expired lots, prefer the
//! soonest-expiry credit so a holder spends the lot that would otherwise lapse.

use inference_bazaar_settlement::core::alloy_primitives::B256;
use serde::Serialize;

/// The on-chain lot fields this module needs, decoupled from the chain-feature
/// alloy binding so the selection is testable on its own.
#[derive(Clone, Copy)]
pub struct LotView {
    pub instrument: B256,
    pub qty_tokens: u64,
    pub locked_tokens: u64,
    pub expiry: u64,
    pub notional_micro: u128,
}

/// One spendable credit, as returned to the caller.
#[derive(Serialize)]
pub struct CreditEntry {
    #[serde(rename = "lotId")]
    pub lot_id: String,
    /// Tokens still spendable (qty − locked).
    #[serde(rename = "qtyRemaining")]
    pub qty_remaining: u64,
    /// Locked strike, micro-USD per 1M tokens — what the holder pre-paid.
    #[serde(rename = "strikeMicroPerM")]
    pub strike_micro_per_m: u128,
    pub expiry: u64,
}

/// Filter to the holder's lots for `want_instrument` that are still spendable
/// (remaining > 0) and unexpired at `now`, soonest-expiry first (ties broken by
/// lotId for determinism). The first entry is the one a client should spend.
pub fn select_credits(
    lots: &[(B256, LotView)],
    want_instrument: B256,
    now: u64,
) -> Vec<CreditEntry> {
    let mut picked: Vec<(B256, LotView, u64)> = lots
        .iter()
        .filter(|(_, l)| {
            l.instrument == want_instrument && l.qty_tokens > l.locked_tokens && l.expiry > now
        })
        .map(|(id, l)| (*id, *l, l.qty_tokens - l.locked_tokens))
        .collect();
    // Soonest-expiry first; lotId breaks ties so the order is stable.
    picked.sort_by(|a, b| a.1.expiry.cmp(&b.1.expiry).then_with(|| a.0.cmp(&b.0)));
    picked
        .into_iter()
        .map(|(id, l, remaining)| CreditEntry {
            lot_id: format!("{id:#x}"),
            qty_remaining: remaining,
            // Strike per 1M tokens: the notional backs the remaining qty, so
            // notional * 1e6 / qty is the per-million price the holder locked.
            strike_micro_per_m: if l.qty_tokens > 0 {
                l.notional_micro * 1_000_000 / l.qty_tokens as u128
            } else {
                0
            },
            expiry: l.expiry,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use inference_bazaar_settlement::core::alloy_primitives::B256;

    fn lot(instrument: B256, qty: u64, locked: u64, expiry: u64, notional: u128) -> LotView {
        LotView {
            instrument,
            qty_tokens: qty,
            locked_tokens: locked,
            expiry,
            notional_micro: notional,
        }
    }

    #[test]
    fn selects_matching_unexpired_spendable_soonest_first() {
        let want = B256::repeat_byte(0xAA);
        let other = B256::repeat_byte(0xBB);
        let id1 = B256::repeat_byte(0x01);
        let id2 = B256::repeat_byte(0x02);
        let id3 = B256::repeat_byte(0x03);
        let id4 = B256::repeat_byte(0x04);
        let id5 = B256::repeat_byte(0x05);
        let lots = vec![
            (id1, lot(want, 50_000, 0, 2_000, 600_000)), // ok, expiry 2000
            (id2, lot(want, 40_000, 0, 1_500, 500_000)), // ok, expiry 1500 — soonest
            (id3, lot(other, 99_000, 0, 9_000, 900_000)), // wrong instrument
            (id4, lot(want, 10_000, 10_000, 9_000, 100_000)), // fully locked → out
            (id5, lot(want, 30_000, 0, 500, 300_000)),   // expired at now=1000 → out
        ];
        let got = select_credits(&lots, want, 1_000);
        assert_eq!(
            got.len(),
            2,
            "only the two spendable matching unexpired lots"
        );
        assert_eq!(got[0].lot_id, format!("{id2:#x}"), "soonest-expiry first");
        assert_eq!(got[1].lot_id, format!("{id1:#x}"));
        // strike per 1M = notional * 1e6 / qty = 500_000 * 1e6 / 40_000 = 12_500_000
        assert_eq!(got[0].strike_micro_per_m, 12_500_000);
        assert_eq!(got[0].qty_remaining, 40_000);
    }

    #[test]
    fn no_match_returns_empty() {
        let want = B256::repeat_byte(0xAA);
        let lots = vec![(
            B256::repeat_byte(0x1),
            lot(B256::repeat_byte(0xBB), 10, 0, 9_999, 10),
        )];
        assert!(select_credits(&lots, want, 1).is_empty());
    }
}
