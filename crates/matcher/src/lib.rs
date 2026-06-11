//! Deterministic epoch-batch matcher — the heart of the shared CLOB.
//!
//! Given the gossiped **set** of signed orders for one instrument in an epoch,
//! produce the epoch's crossed fills as the on-chain `BatchFill[]` plus the
//! `fillsHash` the settlement contract recomputes from that calldata.
//!
//! The defining property is **set-determinism**: the result is a pure function
//! of the order *set*, independent of the order in which orders arrived. The
//! matcher imposes a canonical ordering derived from the orders themselves —
//! price priority, tiebroken by each order's EIP-712 digest — so it has **no
//! ordering discretion** at all. It is a batch *proposer*, not a sequencer. That
//! is what makes "peers recompute and co-sign" true rather than a comforting
//! story: any peer holding the same set (and the SP1 guest) derives the identical
//! `fillsHash`, and the only thing a dishonest proposer can do is *omit* an order
//! — detectable by diffing against the gossiped set, never reorder/front-run.
//!
//! Matching reuses the same integer-only [`NativeBook`] engine the venue runs
//! (one matching truth): sells (the liquidity providers) rest cheapest-ask-first,
//! buys then lift highest-bid-first at the maker's ask.

use std::collections::{HashMap, HashSet};

use surplus_orderbook::{MatchingEngine, NativeBook, Order as BookOrder, Side as BookSide};
use surplus_settlement_core::{
    alloy_primitives::B256, fills_hash, instrument_hash, order_digest, BatchFill, Eip712Domain,
    Order as SignedOrder, SIDE_BUY, SIDE_SELL,
};

/// The deterministic result of matching one epoch's order set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EpochBatch {
    /// Crossed fills in canonical order — the contract's `BatchFill[]` calldata.
    pub fills: Vec<BatchFill>,
    /// `keccak256(abi.encode(fills))` — what `settleBatch*` recomputes and what
    /// the SP1 program commits. Identical across any correct re-execution of the
    /// same set, in any input order.
    pub fills_hash: B256,
}

/// An order canonicalized for matching: validated, with its integer book values
/// and its unique EIP-712 digest (the deterministic ordering tiebreak) precomputed.
struct CanonOrder {
    order: SignedOrder,
    price: i64,
    qty: i64,
    digest: B256,
}

/// Match the gossiped order set for one instrument into the epoch's batch.
///
/// Set-deterministic: the result depends only on which orders are present, never
/// on their input order. Foreign-instrument, out-of-range, and off-tick/below-min
/// orders are dropped; duplicate submissions of the same signed order are deduped
/// by digest; self-matches (same `trader` both sides) are dropped, never washed.
/// `domain` is the settlement contract's EIP-712 domain — it binds each order's
/// digest (used both to dedup and as the canonical tiebreak) to this deployment.
pub fn match_epoch(
    instrument_id: &str,
    tick_size: i64,
    min_qty: i64,
    domain: &Eip712Domain,
    orders: &[SignedOrder],
) -> EpochBatch {
    let want_instrument = instrument_hash(instrument_id);

    // Canonicalize the SET: keep valid orders for this instrument, dedup by
    // identity, compute the digest used as the unique deterministic tiebreak.
    let mut seen: HashSet<B256> = HashSet::new();
    let mut canon: Vec<CanonOrder> = Vec::new();
    for o in orders {
        if o.instrument != want_instrument {
            continue;
        }
        let (Ok(price), Ok(qty)) = (i64::try_from(o.priceMicroPerM), i64::try_from(o.qtyTokens))
        else {
            continue; // outside the integer book domain — unmatchable
        };
        let digest = order_digest(o, domain);
        if !seen.insert(digest) {
            continue; // duplicate submission of the same signed order
        }
        canon.push(CanonOrder {
            order: o.clone(),
            price,
            qty,
            digest,
        });
    }

    // Canonical ordering — the whole point. Sells rest cheapest-ask-first; buys
    // lift highest-bid-first. The digest breaks price ties uniquely, so there is
    // no dependence on input order (and no stable-sort fallback to it).
    let (mut sells, mut buys): (Vec<CanonOrder>, Vec<CanonOrder>) =
        canon.into_iter().partition(|c| c.order.side == SIDE_SELL);
    sells.sort_by(|a, b| a.price.cmp(&b.price).then(a.digest.cmp(&b.digest)));
    buys.sort_by(|a, b| b.price.cmp(&a.price).then(a.digest.cmp(&b.digest)));

    // Replay the canonical order through the venue's own engine: ts = feed
    // position, so within-price FIFO follows the canonical (digest) order, not a
    // clock. Sells first (they become the resting makers), then buys lift them.
    let mut book = NativeBook::new(instrument_id, tick_size, min_qty);
    let mut by_id: HashMap<String, SignedOrder> = HashMap::new();
    let mut fills: Vec<BatchFill> = Vec::new();
    for (pos, c) in sells.into_iter().chain(buys).enumerate() {
        let id = format!("o{pos}");
        let book_order = BookOrder {
            id: id.clone(),
            instrument_id: instrument_id.to_string(),
            side: if c.order.side == SIDE_BUY {
                BookSide::Buy
            } else {
                BookSide::Sell
            },
            price: c.price,
            qty: c.qty,
            owner: format!("{:#x}", c.order.trader),
            ts: pos as i64,
        };
        let outcome = match book.place(book_order) {
            Ok(o) => o,
            Err(_) => continue, // off-tick / below-min / duplicate id
        };
        by_id.insert(id, c.order);
        for f in &outcome.fills {
            let (Some(maker), Some(taker)) =
                (by_id.get(&f.maker_order_id), by_id.get(&f.taker_order_id))
            else {
                continue; // unreachable: every printed fill names two known orders
            };
            let (buy, sell) = if taker.side == SIDE_BUY {
                (taker, maker)
            } else {
                (maker, taker)
            };
            fills.push(BatchFill {
                buy: buy.clone(),
                sell: sell.clone(),
                qtyTokens: f.qty as u64,
                execPriceMicroPerM: f.price as u64,
            });
        }
    }

    let fills_hash = fills_hash(&fills);
    EpochBatch { fills, fills_hash }
}

#[cfg(test)]
mod tests {
    use super::*;
    use surplus_settlement_core::alloy_primitives::Address;
    use surplus_settlement_core::{domain, SIDE_SELL};

    fn dom() -> Eip712Domain {
        domain(84532, Address::with_last_byte(0xcc))
    }

    fn order(side: u8, price: u64, qty: u64, trader: u8) -> SignedOrder {
        SignedOrder {
            instrument: instrument_hash("m"),
            side,
            priceMicroPerM: price,
            qtyTokens: qty,
            lotId: B256::ZERO,
            trader: Address::with_last_byte(trader),
            expiry: u64::MAX,
            salt: B256::with_last_byte(trader), // distinct identity per test order
        }
    }

    fn total_matched(b: &EpochBatch) -> u64 {
        b.fills.iter().map(|f| f.qtyTokens).sum()
    }

    /// A resting sell lifted by a crossing buy → one BatchFill at the maker's
    /// (resting sell's) price, buy/sell sides assigned from the signed orders.
    #[test]
    fn crossing_orders_produce_one_batchfill() {
        let orders = [order(SIDE_SELL, 100, 10, 2), order(SIDE_BUY, 100, 10, 1)];
        let batch = match_epoch("m", 1, 1, &dom(), &orders);
        assert_eq!(batch.fills.len(), 1);
        let f = &batch.fills[0];
        assert_eq!(f.buy.trader, Address::with_last_byte(1));
        assert_eq!(f.sell.trader, Address::with_last_byte(2));
        assert_eq!(f.qtyTokens, 10);
        assert_eq!(f.execPriceMicroPerM, 100); // maker (ask) price
    }

    /// THE load-bearing property: the batch is a pure function of the SET. Every
    /// permutation of the same orders yields a bit-identical fillsHash. Without
    /// this, "peers recompute and co-sign" is a story, not a guarantee.
    #[test]
    fn batch_is_order_independent() {
        let base = vec![
            order(SIDE_SELL, 100, 10, 2),
            order(SIDE_SELL, 102, 8, 3),
            order(SIDE_BUY, 103, 15, 1),
            order(SIDE_BUY, 99, 5, 4),
            order(SIDE_SELL, 101, 4, 5),
        ];
        let d = dom();
        let canonical = match_epoch("m", 1, 1, &d, &base);
        for perm in [
            [4, 3, 2, 1, 0],
            [2, 0, 4, 1, 3],
            [1, 4, 0, 3, 2],
            [3, 2, 1, 0, 4],
            [0, 2, 4, 1, 3],
        ] {
            let shuffled: Vec<_> = perm.iter().map(|&i| base[i].clone()).collect();
            let got = match_epoch("m", 1, 1, &d, &shuffled);
            assert_eq!(
                got.fills_hash, canonical.fills_hash,
                "permutation {perm:?} changed the batch"
            );
            assert_eq!(got.fills, canonical.fills);
        }
        // Non-trivial: the set actually crossed (15 demand vs 22 supply → 15).
        assert!(!canonical.fills.is_empty());
        assert_eq!(total_matched(&canonical), 15);
    }

    /// A duplicate submission of the very same signed order is deduped, not
    /// double-counted — the matcher consumes a set.
    #[test]
    fn duplicate_orders_deduped() {
        let s = order(SIDE_SELL, 100, 10, 2);
        let b = order(SIDE_BUY, 100, 10, 1);
        let with_dupes = [s.clone(), s.clone(), b.clone(), b.clone()];
        let once = [s, b];
        let d = dom();
        assert_eq!(
            match_epoch("m", 1, 1, &d, &with_dupes).fills_hash,
            match_epoch("m", 1, 1, &d, &once).fills_hash
        );
        assert_eq!(total_matched(&match_epoch("m", 1, 1, &d, &with_dupes)), 10);
    }

    /// Price priority with a digest tiebreak: a 15-token buy sweeps two 100-priced
    /// sells (10 + 5), deterministically — but which equal-priced sell fills first
    /// is digest order, not arrival, so we assert the volume, not the identity.
    #[test]
    fn price_priority_sweeps_best_levels() {
        let orders = [
            order(SIDE_SELL, 100, 10, 2),
            order(SIDE_SELL, 100, 10, 3),
            order(SIDE_BUY, 100, 15, 1),
        ];
        let batch = match_epoch("m", 1, 1, &dom(), &orders);
        assert_eq!(batch.fills.len(), 2);
        assert_eq!(total_matched(&batch), 15);
        assert!(batch.fills.iter().all(|f| f.execPriceMicroPerM == 100));
    }

    #[test]
    fn no_cross_no_fill() {
        let orders = [order(SIDE_BUY, 99, 10, 1), order(SIDE_SELL, 101, 10, 2)];
        let batch = match_epoch("m", 1, 1, &dom(), &orders);
        assert!(batch.fills.is_empty());
        assert_eq!(batch.fills_hash, fills_hash(&[]));
    }

    /// Same trader on both sides must not wash-trade, in any input order.
    #[test]
    fn self_match_is_not_washed() {
        let orders = [order(SIDE_SELL, 100, 10, 7), order(SIDE_BUY, 100, 10, 7)];
        let d = dom();
        assert!(match_epoch("m", 1, 1, &d, &orders).fills.is_empty());
        let rev = [orders[1].clone(), orders[0].clone()];
        assert!(match_epoch("m", 1, 1, &d, &rev).fills.is_empty());
    }

    /// Orders for another instrument are ignored, not matched.
    #[test]
    fn foreign_instrument_skipped() {
        let mut foreign = order(SIDE_SELL, 100, 10, 2);
        foreign.instrument = instrument_hash("other");
        let orders = [foreign, order(SIDE_BUY, 100, 10, 1)];
        assert!(match_epoch("m", 1, 1, &dom(), &orders).fills.is_empty());
    }
}
