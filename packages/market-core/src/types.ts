/**
 * Surplus market domain types.
 *
 * Units, fixed across the whole system:
 * - quantity: tokens (integer)
 * - price: micro-tsUSD per 1M tokens (integer). tsUSD has 6 decimals, so a
 *   price of 3_000_000 = $3.00 per million tokens.
 * - notional: micro-tsUSD (integer, rounded half-up at fill time)
 * - timestamps: caller-supplied epoch ms. Nothing in this package reads a
 *   clock — determinism is a contract, not a convention.
 */

export type Side = 'buy' | 'sell'

export type TokenKind = 'input' | 'output'

/** One tradeable market: prepaid inference tokens for a model + token kind. */
export interface Instrument {
  /** Stable id, e.g. `anthropic/claude-opus-4-8:output`. */
  id: string
  /** Router model id this credit redeems against. */
  modelId: string
  tokenKind: TokenKind
  /** Price increment, micro-tsUSD per 1M tokens. */
  tickSize: number
  /** Minimum order quantity, tokens. */
  minQty: number
}

export interface Order {
  id: string
  instrumentId: string
  side: Side
  /** Limit price, micro-tsUSD per 1M tokens. */
  price: number
  /** Remaining open quantity, tokens. */
  qty: number
  owner: string
  /** Caller-supplied placement time (epoch ms) — time priority key. */
  ts: number
}

export interface Fill {
  instrumentId: string
  makerOrderId: string
  takerOrderId: string
  makerOwner: string
  takerOwner: string
  /** Execution price = maker's limit price. */
  price: number
  qty: number
  takerSide: Side
  ts: number
}

export interface BookLevel {
  price: number
  qty: number
  orders: number
}

export interface BookSnapshot {
  instrumentId: string
  /** Descending by price. */
  bids: BookLevel[]
  /** Ascending by price. */
  asks: BookLevel[]
  lastTradePrice?: number
  ts: number
}

/** Notional in micro-tsUSD for `qty` tokens at `price` per 1M tokens. */
export function notionalMicro(price: number, qty: number): number {
  return Math.round((price * qty) / 1_000_000)
}

export function bpsBetween(a: number, b: number): number {
  if (b === 0) return Number.POSITIVE_INFINITY
  return Math.abs((a - b) / b) * 10_000
}
