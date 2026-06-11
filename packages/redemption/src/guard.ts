import type { RedeemOutcome, RedemptionAdapter } from './adapter'
import { CreditBook } from './credit-book'
import type { Credit, DebitError, MeteredCall } from './types'
import { isDebitError } from './types'

/**
 * Abuse bounds at the redemption layer (G7): per-owner rolling-window rate
 * limits and spend caps, enforced before any debit. Deterministic like the
 * rest of the package — windows are computed from call timestamps, never a
 * clock, so the same call sequence always produces the same refusals.
 *
 * Fail-closed for funds, fail-open for service: an over-cap owner's
 * `selectCredit` returns null (the router falls back to normal balance
 * billing), and a direct `redeem` is refused without touching the book —
 * caps can delay spending a credit, never leak quota or money.
 */
export interface RedemptionLimits {
  /** Rolling window length, seconds. */
  windowSec: number
  /** Max redemption calls per owner per window. */
  maxCallsPerWindow?: number
  /** Max tokens debited per owner per window. */
  maxTokensPerWindow?: number
  /** Max operator payout (micro-tsUSD) per owner per window. */
  maxSpendMicroPerWindow?: number
}

export interface RedemptionRefusal {
  kind: 'rate-limited' | 'tokens-capped' | 'spend-capped'
  owner: string
  windowSec: number
  limit: number
  /** Usage already consumed inside the current window. */
  used: number
  /** Earliest ts at which the oldest window entry expires. */
  retryAtTs: number
}

export function isRedemptionRefusal(
  value: RedeemOutcome | DebitError | RedemptionRefusal,
): value is RedemptionRefusal {
  return (
    'kind' in value &&
    (value.kind === 'rate-limited' || value.kind === 'tokens-capped' || value.kind === 'spend-capped')
  )
}

interface WindowEntry {
  ts: number
  tokens: number
  spendMicro: number
}

/**
 * Wraps any RedemptionAdapter with per-owner limits. Usage is recorded only
 * for successful debits, with the actual debited amounts (a partially-covered
 * call counts its covered tokens, not the requested ones).
 *
 * Not an `implements RedemptionAdapter`: `redeem` deliberately widens the
 * return type with RedemptionRefusal so callers must handle the refusal case
 * explicitly. Routers that only consult `selectCredit` (which returns null
 * for capped owners) keep their existing fall-back-to-balance behavior.
 */
export class GuardedRedemptionAdapter {
  private readonly windows = new Map<string, WindowEntry[]>()

  constructor(
    private readonly inner: RedemptionAdapter,
    private readonly book: CreditBook,
    private readonly limits: RedemptionLimits,
  ) {
    if (!Number.isInteger(limits.windowSec) || limits.windowSec <= 0) {
      throw new Error(`windowSec must be a positive integer: ${limits.windowSec}`)
    }
  }

  selectCredit(owner: string, model: string, tokenKind: 'input' | 'output', ts: number): Credit | null {
    if (this.refusalFor(owner, ts)) return null
    return this.inner.selectCredit(owner, model, tokenKind, ts)
  }

  redeem(call: MeteredCall): RedeemOutcome | DebitError | RedemptionRefusal {
    const owner = this.book.get(call.creditId)?.owner
    // Unknown credits fall through to the inner adapter's own error.
    if (owner !== undefined) {
      const refusal = this.refusalFor(owner, call.ts)
      if (refusal) return refusal
    }
    const outcome = this.inner.redeem(call)
    if (isDebitError(outcome)) return outcome
    if (owner !== undefined) {
      this.record(owner, {
        ts: call.ts,
        tokens: outcome.debit.tokensDebited,
        spendMicro: outcome.debit.operatorPayoutMicro,
      })
    }
    return outcome
  }

  /** Current usage inside the window ending at `ts` — for telemetry/tests. */
  usage(owner: string, ts: number): { calls: number; tokens: number; spendMicro: number } {
    const entries = this.prune(owner, ts)
    return {
      calls: entries.length,
      tokens: entries.reduce((a, e) => a + e.tokens, 0),
      spendMicro: entries.reduce((a, e) => a + e.spendMicro, 0),
    }
  }

  private refusalFor(owner: string, ts: number): RedemptionRefusal | null {
    const entries = this.prune(owner, ts)
    const oldest = entries[0]
    const retryAtTs = oldest ? oldest.ts + this.limits.windowSec : ts
    const { maxCallsPerWindow, maxTokensPerWindow, maxSpendMicroPerWindow, windowSec } = this.limits

    if (maxCallsPerWindow !== undefined && entries.length >= maxCallsPerWindow) {
      return { kind: 'rate-limited', owner, windowSec, limit: maxCallsPerWindow, used: entries.length, retryAtTs }
    }
    const tokens = entries.reduce((a, e) => a + e.tokens, 0)
    if (maxTokensPerWindow !== undefined && tokens >= maxTokensPerWindow) {
      return { kind: 'tokens-capped', owner, windowSec, limit: maxTokensPerWindow, used: tokens, retryAtTs }
    }
    const spend = entries.reduce((a, e) => a + e.spendMicro, 0)
    if (maxSpendMicroPerWindow !== undefined && spend >= maxSpendMicroPerWindow) {
      return { kind: 'spend-capped', owner, windowSec, limit: maxSpendMicroPerWindow, used: spend, retryAtTs }
    }
    return null
  }

  private record(owner: string, entry: WindowEntry): void {
    const entries = this.windows.get(owner) ?? []
    entries.push(entry)
    this.windows.set(owner, entries)
  }

  private prune(owner: string, ts: number): WindowEntry[] {
    const cutoff = ts - this.limits.windowSec
    const entries = (this.windows.get(owner) ?? []).filter((e) => e.ts > cutoff)
    this.windows.set(owner, entries)
    return entries
  }
}
