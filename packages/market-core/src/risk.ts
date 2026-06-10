import type { QuoteSet } from './quoting'
import { bpsBetween, notionalMicro } from './types'

/**
 * Pre-trade risk gate. Every quote set — algorithmic or agent-authored —
 * passes through here before it touches the venue. Fail-closed: a hard
 * violation invalidates the whole set; the loop records the tick and quotes
 * nothing.
 */

export interface RiskLimits {
  /** Hard absolute inventory cap, tokens. */
  maxInventory: number
  /** Max notional per quote, micro-tsUSD. */
  maxQuoteNotional: number
  /** Max quote deviation from the reference mid, bps. */
  maxDeviationBps: number
  /** Quotes must not cross each other or invert around their own mid. */
  minSpreadBps: number
  /** Session drawdown (micro-tsUSD) that trips the kill switch. */
  killSwitchDrawdown: number
}

export interface RiskContext {
  refMid: number
  inventoryTokens: number
  /** Session PnL drawdown from peak, micro-tsUSD (>= 0). */
  drawdown: number
  limits: RiskLimits
}

export interface RiskVerdict {
  valid: boolean
  /** [0,1] — quality of the quote set; loop winner selection key. */
  score: number
  reasons: string[]
  killSwitch: boolean
}

export function assessQuotes(quotes: QuoteSet, ctx: RiskContext): RiskVerdict {
  const reasons: string[] = []
  const { limits } = ctx
  let killSwitch = false

  if (ctx.drawdown >= limits.killSwitchDrawdown) {
    killSwitch = true
    reasons.push(
      `kill switch: drawdown ${ctx.drawdown} >= ${limits.killSwitchDrawdown} micro-tsUSD`,
    )
  }

  if (quotes.bid && quotes.ask && quotes.bid.price >= quotes.ask.price) {
    reasons.push(`crossed quotes: bid ${quotes.bid.price} >= ask ${quotes.ask.price}`)
  }
  if (quotes.bid && quotes.ask) {
    const ownMid = (quotes.bid.price + quotes.ask.price) / 2
    const spreadBps = ((quotes.ask.price - quotes.bid.price) / ownMid) * 10_000
    if (spreadBps < limits.minSpreadBps) {
      reasons.push(`spread ${spreadBps.toFixed(1)}bps below floor ${limits.minSpreadBps}bps`)
    }
  }

  for (const [side, quote] of [
    ['bid', quotes.bid],
    ['ask', quotes.ask],
  ] as const) {
    if (!quote) continue
    if (quote.price <= 0 || quote.qty <= 0 || !Number.isFinite(quote.price)) {
      reasons.push(`${side}: malformed quote ${JSON.stringify(quote)}`)
      continue
    }
    const deviation = bpsBetween(quote.price, ctx.refMid)
    if (deviation > limits.maxDeviationBps) {
      reasons.push(
        `${side} ${quote.price} deviates ${deviation.toFixed(0)}bps from ref ${ctx.refMid} ` +
          `(max ${limits.maxDeviationBps})`,
      )
    }
    const notional = notionalMicro(quote.price, quote.qty)
    if (notional > limits.maxQuoteNotional) {
      reasons.push(`${side} notional ${notional} > cap ${limits.maxQuoteNotional}`)
    }
    const projected =
      side === 'bid' ? ctx.inventoryTokens + quote.qty : ctx.inventoryTokens - quote.qty
    if (Math.abs(projected) > limits.maxInventory) {
      reasons.push(
        `${side} fill would take inventory to ${projected} tokens (cap ${limits.maxInventory})`,
      )
    }
  }

  const valid = reasons.length === 0
  return { valid, score: scoreQuotes(quotes, ctx, reasons.length), reasons, killSwitch }
}

/**
 * Quality score for winner selection among valid quote sets: two-sided and
 * tight-around-reference scores higher; each violation already costs heavily.
 */
function scoreQuotes(quotes: QuoteSet, ctx: RiskContext, violations: number): number {
  if (violations > 0) return Math.max(0, 0.3 - violations * 0.1)
  let score = 0.5
  if (quotes.bid && quotes.ask) {
    score += 0.3
    const spreadBps = ((quotes.ask.price - quotes.bid.price) / ctx.refMid) * 10_000
    score += 0.2 * Math.max(0, 1 - spreadBps / ctx.limits.maxDeviationBps)
  } else if (quotes.bid || quotes.ask) {
    score += 0.15
  }
  return Math.min(1, score)
}
