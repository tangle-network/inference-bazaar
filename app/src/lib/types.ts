/**
 * Domain model for the inference-credit market. Prices are integers in
 * micro-tsUSD per 1M tokens (the router's native unit). A market is one model;
 * the tradeable instrument is (model, tokenKind). Sellers list credits through
 * venues; operators make markets.
 */

export type Capability =
  | 'text'
  | 'tools'
  | 'vision'
  | 'reasoning'
  | 'image'
  | 'audio'
  | 'video'
  | 'voice'

export type TokenKind = 'output' | 'input' | 'cache'

/** A lab that produces a model (identity/brand). */
export interface Lab {
  id: string
  name: string
  /** brand hue for the logo mark */
  hue: string
  glyph: string // ph icon name or short mark
}

/** Where inference is actually fulfilled (the reseller's source). */
export interface Venue {
  id: string
  name: string
  hue: string
}

export interface Price {
  input: number
  output: number
  cache: number
}

export interface Model {
  id: string // e.g. anthropic/claude-opus-4-8
  name: string // Claude Opus 4.8
  labId: string
  capabilities: Capability[]
  contextK: number // context window, thousands of tokens
  /** Router list price (the reference the market discounts to). */
  list: Price
}

/** One seller's standing offer on a model, fulfilled through a venue. */
export interface Offer {
  id: string
  modelId: string
  venueId: string
  seller: string // address or handle
  /** Full 0x address — identicon source. */
  sellerAddress: `0x${string}`
  sellerLabel: string
  verified: boolean
  /** discount to list, as a fraction (0.18 = 18% off). Same across kinds here. */
  discount: number
  /** effective sell price by kind, micro-tsUSD/1M. */
  price: Price
  offeredTokens: number
  soldTokens: number
  remainingTokens: number
  /** seconds since the offer last refreshed */
  ageS: number
}

export interface OrderLevel {
  price: number // micro-tsUSD/1M
  tokens: number // size at this level
  orders: number
}

export interface Trade {
  id: string
  modelId: string
  kind: TokenKind
  side: 'buy' | 'sell'
  price: number
  tokens: number
  venueId: string
  tsMs: number
}

/** Per-model market rollup (across all venues/sellers, for the active kind). */
export interface MarketStats {
  bestDiscount: number
  listOut: number
  bestOut: number
  liquidityTokens: number
  liquidityNotionalMicro: number
  volume24hMicro: number
  trades24h: number
  activeOffers: number
  venues: number
  spreadBps: number
  /** 24 sparkline points of the mid (micro/M), oldest first. */
  spark: number[]
}

export interface ModelMarket {
  model: Model
  lab: Lab
  stats: MarketStats
}
