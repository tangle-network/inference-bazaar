/**
 * Inventory-aware two-sided quoting, Avellaneda–Stoikov style.
 *
 * The reservation price shifts away from the side we are long: holding
 * inventory q (in lots), r = mid − q·γ·σ²·τ. The half-spread is
 * γσ²τ/2 + (1/γ)·ln(1 + γ/k). γ is risk aversion, σ the per-tick reference
 * volatility (price units), τ the remaining horizon in ticks, k the fill
 * intensity decay. This is the deterministic strategy the algorithmic MM mode
 * runs; the agentic mode may override it but is risk-checked identically.
 */

export interface QuoteParams {
  /** Risk aversion γ > 0. Higher = wider spread, stronger inventory skew. */
  gamma: number
  /** Reference price volatility per tick, in price units (micro-tsUSD/1M tok). */
  sigma: number
  /** Remaining session horizon, in ticks. */
  horizonTicks: number
  /** Fill-intensity decay k > 0 from the A–S order-flow model. */
  k: number
  /** Quote size per side, tokens. */
  size: number
  /** Hard inventory cap, absolute tokens. One side drops when breached. */
  maxInventory: number
  /** Price tick to round to. */
  tickSize: number
}

export interface Quote {
  price: number
  qty: number
}

export interface QuoteSet {
  bid?: Quote
  ask?: Quote
  /** Why these quotes (or why a side is missing). For the decision trace. */
  rationale: string
}

export function computeQuotes(refMid: number, inventoryTokens: number, p: QuoteParams): QuoteSet {
  if (refMid <= 0) return { rationale: 'no reference mid — not quoting' }
  const q = inventoryTokens / p.size
  const tau = Math.max(p.horizonTicks, 1)
  const reservation = refMid - q * p.gamma * p.sigma * p.sigma * tau
  const halfSpread =
    (p.gamma * p.sigma * p.sigma * tau) / 2 + (1 / p.gamma) * Math.log(1 + p.gamma / p.k)

  const roundTo = (raw: number, side: 'bid' | 'ask'): number => {
    const fn = side === 'bid' ? Math.floor : Math.ceil
    return Math.max(p.tickSize, fn(raw / p.tickSize) * p.tickSize)
  }

  const bidPrice = roundTo(reservation - halfSpread, 'bid')
  const askPrice = roundTo(reservation + halfSpread, 'ask')

  const longCapped = inventoryTokens >= p.maxInventory
  const shortCapped = -inventoryTokens >= p.maxInventory

  const set: QuoteSet = {
    rationale:
      `q=${q.toFixed(2)} lots, reservation=${Math.round(reservation)}, ` +
      `halfSpread=${Math.round(halfSpread)}` +
      (longCapped ? ' — long cap hit, bid pulled' : '') +
      (shortCapped ? ' — short cap hit, ask pulled' : ''),
  }
  if (!longCapped) set.bid = { price: bidPrice, qty: p.size }
  if (!shortCapped) set.ask = { price: askPrice, qty: p.size }
  return set
}
