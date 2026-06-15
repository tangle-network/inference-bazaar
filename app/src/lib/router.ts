/**
 * Smart order router (SOR) — the cross-venue execution layer of the locked
 * two-layer market (docs/PAYMENT-ARCHITECTURE.md). NBBO aggregation
 * (`fetchAggBook`) merges every venue's book into one price-sorted ladder; this
 * walks that ladder best-first and decomposes one order into a *split plan*
 * across venues, so a buyer sweeps the genuinely-cheapest liquidity wherever it
 * sits instead of taking a single venue's best quote.
 *
 * Pure and venue-agnostic: each leg names the operator whose liquidity it lifts,
 * and the caller executes each leg as a portable signed order that clears on the
 * one global InferenceBazaarSettlement contract. Type-only imports keep this runnable in
 * isolation (no React/wallet graph), so it is directly unit-checkable.
 */
import type { Address } from 'viem'
import type { AggBook } from './venues'

export interface RouteLeg {
  /** The venue (operator) whose resting liquidity this leg lifts. */
  operator: Address
  /** Execution price, micro-tsUSD per 1M tokens (the level's resting price). */
  priceMicroPerM: number
  qtyTokens: number
}

export interface Route {
  side: 'buy' | 'sell'
  requestedTokens: number
  /** May be < requested when the book is too thin or the limit too tight. */
  filledTokens: number
  legs: RouteLeg[]
  /** Size-weighted average execution price across the legs. */
  avgPriceMicroPerM: number
  /** Total cost (buy) / proceeds (sell), micro-tsUSD, rounded half-up per leg. */
  notionalMicro: number
  partial: boolean
}

const HALF: bigint = 500_000n
const MICRO: bigint = 1_000_000n

/** Notional of one (price, qty) leg in micro-tsUSD, half-up — mirrors the Rust
 * `Fill::notional_micro` so the app and the operator agree to the unit. */
function legNotionalMicro(priceMicroPerM: number, qtyTokens: number): bigint {
  return (BigInt(priceMicroPerM) * BigInt(qtyTokens) + HALF) / MICRO
}

/**
 * Plan a route for `qtyTokens` on `side`, walking the merged NBBO ladder
 * best-first (a buy lifts asks ascending; a sell hits bids descending) and
 * splitting across venues. `limitPriceMicroPerM`, if given, stops the walk once
 * the price is worse than the limit (so the route never crosses it) — the result
 * is then `partial`. Consecutive same-(operator, price) levels coalesce into one
 * leg so the plan has one entry per venue price point.
 */
export function planRoute(
  book: AggBook,
  side: 'buy' | 'sell',
  qtyTokens: number,
  limitPriceMicroPerM?: number,
): Route {
  const ladder = side === 'buy' ? book.asks : book.bids
  const legs: RouteLeg[] = []
  let remaining = Math.max(0, Math.floor(qtyTokens))

  for (const level of ladder) {
    if (remaining <= 0) break
    if (limitPriceMicroPerM != null) {
      const worseThanLimit =
        side === 'buy' ? level.price > limitPriceMicroPerM : level.price < limitPriceMicroPerM
      if (worseThanLimit) break
    }
    const take = Math.min(remaining, level.qty)
    if (take <= 0) continue
    const last = legs[legs.length - 1]
    if (last && last.operator === level.operator && last.priceMicroPerM === level.price) {
      last.qtyTokens += take
    } else {
      legs.push({ operator: level.operator, priceMicroPerM: level.price, qtyTokens: take })
    }
    remaining -= take
  }

  const filledTokens = Math.max(0, Math.floor(qtyTokens)) - remaining
  // notional = actual settlement cost (rounded half-up per leg, to the unit);
  // avg price = the size-weighted average from the UNROUNDED price·qty sum, so a
  // small route's average is not distorted by per-leg rounding.
  const notional = legs.reduce(
    (sum, l) => sum + legNotionalMicro(l.priceMicroPerM, l.qtyTokens),
    0n,
  )
  const gross = legs.reduce((sum, l) => sum + BigInt(l.priceMicroPerM) * BigInt(l.qtyTokens), 0n)
  const avgPriceMicroPerM = filledTokens > 0 ? Number(gross / BigInt(filledTokens)) : 0

  return {
    side,
    requestedTokens: Math.max(0, Math.floor(qtyTokens)),
    filledTokens,
    legs,
    avgPriceMicroPerM,
    notionalMicro: Number(notional),
    partial: filledTokens < Math.max(0, Math.floor(qtyTokens)),
  }
}

/** The single best price available for `side` across all venues (NBBO touch),
 * or null when that side is empty. */
export function nbboTouch(book: AggBook, side: 'buy' | 'sell'): number | null {
  const ladder = side === 'buy' ? book.asks : book.bids
  return ladder[0]?.price ?? null
}
