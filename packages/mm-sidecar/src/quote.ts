import {
  assessQuotes,
  computeQuotes,
  type QuoteParams,
  type RiskLimits,
} from '@surplus/market-core'

/**
 * The sidecar's per-tick contract. The Rust operator owns the venue (the
 * on-chain / in-operator order book and the buyer flow); each workflow tick it
 * POSTs the current market state here and gets back a risk-gated quote set.
 * Stateless and deterministic: inventory and reference price are inputs, so the
 * operator stays the single source of truth and the sidecar can be restarted or
 * replicated without losing state.
 */
export interface QuoteRequest {
  instrumentId: string
  /** Reference mid from the router list price, micro-tsUSD per 1M tokens. */
  refMid: number
  /** Operator's current signed inventory for this instrument, tokens. */
  inventoryTokens: number
  /** Session drawdown from peak, micro-tsUSD (>= 0). */
  drawdownMicro: number
  params: QuoteParams
  limits: RiskLimits
}

export interface QuoteResponse {
  instrumentId: string
  /** Null when that side is pulled (inventory cap, risk gate, or no ref mid). */
  bid: { price: number; qty: number } | null
  ask: { price: number; qty: number } | null
  rationale: string
  /** Risk verdict — false means the operator MUST NOT place these quotes. */
  valid: boolean
  score: number
  reasons: string[]
  killSwitch: boolean
}

/** Pure quote decision: Avellaneda–Stoikov quoting + the fail-closed risk gate. */
export function decideQuotes(req: QuoteRequest): QuoteResponse {
  const quotes = computeQuotes(req.refMid, req.inventoryTokens, req.params)
  const verdict = assessQuotes(quotes, {
    refMid: req.refMid,
    inventoryTokens: req.inventoryTokens,
    drawdown: req.drawdownMicro,
    limits: req.limits,
  })
  return {
    instrumentId: req.instrumentId,
    bid: quotes.bid ?? null,
    ask: quotes.ask ?? null,
    rationale: quotes.rationale,
    valid: verdict.valid,
    score: verdict.score,
    reasons: verdict.reasons,
    killSwitch: verdict.killSwitch,
  }
}

const REQUIRED_PARAMS: (keyof QuoteParams)[] = [
  'gamma',
  'sigma',
  'horizonTicks',
  'k',
  'size',
  'maxInventory',
  'tickSize',
]
const REQUIRED_LIMITS: (keyof RiskLimits)[] = [
  'maxInventory',
  'maxQuoteNotional',
  'maxDeviationBps',
  'minSpreadBps',
  'killSwitchDrawdown',
]

/** Validate + narrow an untrusted JSON body into a QuoteRequest. Throws on bad input. */
export function parseQuoteRequest(body: unknown): QuoteRequest {
  if (!body || typeof body !== 'object') throw new Error('body must be a JSON object')
  const b = body as Record<string, unknown>
  const num = (key: string): number => {
    const v = b[key]
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`missing/invalid number: ${key}`)
    return v
  }
  const obj = (key: string): Record<string, unknown> => {
    const v = b[key]
    if (!v || typeof v !== 'object') throw new Error(`missing/invalid object: ${key}`)
    return v as Record<string, unknown>
  }
  if (typeof b.instrumentId !== 'string') throw new Error('missing instrumentId')
  const params = obj('params')
  const limits = obj('limits')
  for (const key of REQUIRED_PARAMS) {
    if (typeof params[key] !== 'number') throw new Error(`params.${key} must be a number`)
  }
  for (const key of REQUIRED_LIMITS) {
    if (typeof limits[key] !== 'number') throw new Error(`limits.${key} must be a number`)
  }
  return {
    instrumentId: b.instrumentId,
    refMid: num('refMid'),
    inventoryTokens: num('inventoryTokens'),
    drawdownMicro: num('drawdownMicro'),
    params: params as unknown as QuoteParams,
    limits: limits as unknown as RiskLimits,
  }
}
