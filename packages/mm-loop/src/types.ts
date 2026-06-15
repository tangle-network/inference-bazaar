import type {
  BookSnapshot,
  Fill,
  Instrument,
  QuoteParams,
  QuoteSet,
  RiskLimits,
} from '@inference-bazaar/market-core'

/**
 * One tick of market-making work — the loop's `Task` type. A tick is a full
 * snapshot of what the maker may know: nothing here reaches back into live
 * venue state, so a tick serializes losslessly into an agent prompt and a
 * recorded session replays.
 */
export interface MarketTick {
  tickIndex: number
  instrument: Instrument
  /** Reference mid from the routing layer (router list price), micro-tsUSD/1M tok. */
  refMid: number
  book: BookSnapshot
  inventoryTokens: number
  equityMicro: number
  drawdownMicro: number
  params: QuoteParams
  limits: RiskLimits
}

/**
 * Venue port the session trades through. The simulator implements it for
 * tests/dev; the marketplace blueprint's HTTP API implements it in production.
 */
export interface MarketVenue {
  instrument(): Instrument
  referenceMid(): number
  snapshot(ts: number): BookSnapshot
  /** Cancel-replace this owner's quotes. Returns any immediate fills. */
  replaceQuotes(owner: string, quotes: QuoteSet, ts: number): Fill[]
  /** Pull all of this owner's resting orders. */
  cancelAll(owner: string): void
  /** Advance one tick of market time. Returns all fills that printed. */
  step(): { refMid: number; fills: Fill[]; tick: number }
}

export type MMDecision = 'continue' | 'done' | 'fail'

export interface SessionReport {
  owner: string
  instrumentId: string
  ticksCompleted: number
  fills: number
  positionTokens: number
  equityMicro: number
  realizedMicro: number
  maxDrawdownMicro: number
  killSwitch: boolean
  /** Ticks whose quote set failed the risk gate (quotes pulled, tick still ran). */
  rejectedTicks: number
  finalRefMid: number
}
