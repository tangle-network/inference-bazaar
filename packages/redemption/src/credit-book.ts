import { tokenLotCostBaseUnits } from '@inference-bazaar/router-bridge'
import type { Credit, DebitError, DebitResult, MeteredCall, RefundIntent } from './types'

/** Cost of `qty` tokens at the locked strike, micro-tsUSD (number-safe range). */
export function costMicro(strikeMicroPerM: number, qtyTokens: number): number {
  return Number(tokenLotCostBaseUnits(strikeMicroPerM, qtyTokens))
}

export function instrumentId(model: string, tokenKind: 'input' | 'output'): string {
  return `${model}:${tokenKind}`
}

/**
 * The pure debit engine. Deterministic, no clock reads (ts is passed in), no
 * money movement — it computes what should move and emits intents; the
 * settlement side executes them.
 *
 * Rounding invariant: a debit pays the operator
 * `cost(strike, qtyBefore) - cost(strike, qtyAfter)` — the difference of
 * cumulative cost, not a per-call ceil. Per-call rounding would leak
 * micro-units (ceil(a) + ceil(b) >= ceil(a + b)) and drain backing before the
 * quota exhausts; the cumulative form keeps `backingMicro ==
 * cost(strike, qtyRemaining)` exact after every debit, so the quota and the
 * money exhaust on the same call.
 */
export class CreditBook {
  private readonly credits = new Map<string, Credit>()
  private readonly closed = new Set<string>()

  /** Accept a credit minted by settlement. Rejects malformed credits outright. */
  issue(credit: Credit): void {
    if (this.credits.has(credit.id)) throw new Error(`credit already issued: ${credit.id}`)
    if (!Number.isInteger(credit.qtyIssued) || credit.qtyIssued <= 0)
      throw new Error(`qtyIssued must be a positive integer: ${credit.qtyIssued}`)
    if (!Number.isInteger(credit.qtyRemaining) || credit.qtyRemaining < 0 || credit.qtyRemaining > credit.qtyIssued)
      throw new Error(`qtyRemaining out of range: ${credit.qtyRemaining} of ${credit.qtyIssued}`)
    if (!Number.isInteger(credit.strikeMicroPerM) || credit.strikeMicroPerM <= 0)
      throw new Error(`strikeMicroPerM must be a positive integer: ${credit.strikeMicroPerM}`)
    const expectedBacking = costMicro(credit.strikeMicroPerM, credit.qtyRemaining)
    if (credit.backingMicro !== expectedBacking)
      throw new Error(
        `backing does not match quota: have ${credit.backingMicro}, need ${expectedBacking} ` +
          `(${credit.qtyRemaining} tokens @ ${credit.strikeMicroPerM} micro/M)`,
      )
    this.credits.set(credit.id, { ...credit })
  }

  /** Snapshot of a credit's current state, or undefined. The book is the only mutator. */
  get(creditId: string): Credit | undefined {
    const credit = this.credits.get(creditId)
    return credit ? { ...credit } : undefined
  }

  /** Snapshots of all open (non-closed) credits held by `owner`. */
  creditsOf(owner: string): Credit[] {
    const out: Credit[] = []
    for (const credit of this.credits.values()) {
      if (credit.owner === owner && !this.closed.has(credit.id)) out.push({ ...credit })
    }
    return out
  }

  /**
   * Debit a metered call against its credit at the locked strike. Partial-call
   * semantics: if the call meters more tokens than remain, debit what remains
   * and mark exhausted — the caller sees `tokensDebited < call.tokens` and
   * falls back to the next credit / balance for the overflow. NEVER over-debits.
   */
  debit(call: MeteredCall): DebitResult | DebitError {
    if (!Number.isInteger(call.tokens) || call.tokens <= 0)
      throw new Error(`metered tokens must be a positive integer: ${call.tokens}`)
    const credit = this.credits.get(call.creditId)
    if (!credit || this.closed.has(call.creditId))
      return { kind: 'unknown-credit', creditId: call.creditId }
    const expected = instrumentId(credit.model, credit.tokenKind)
    const got = instrumentId(call.model, call.tokenKind)
    if (expected !== got) return { kind: 'wrong-instrument', expected, got }
    if (call.ts > credit.expiry) return { kind: 'expired', expiry: credit.expiry, ts: call.ts }
    if (credit.qtyRemaining === 0)
      return { kind: 'insufficient-quota', qtyRemaining: 0, requested: call.tokens }

    const tokensDebited = Math.min(call.tokens, credit.qtyRemaining)
    const qtyAfter = credit.qtyRemaining - tokensDebited
    const backingAfter = costMicro(credit.strikeMicroPerM, qtyAfter)
    const operatorPayoutMicro = credit.backingMicro - backingAfter
    credit.qtyRemaining = qtyAfter
    credit.backingMicro = backingAfter
    return {
      creditId: credit.id,
      tokensDebited,
      operatorPayoutMicro,
      qtyRemaining: qtyAfter,
      backingRemaining: backingAfter,
      exhausted: qtyAfter === 0,
    }
  }

  /**
   * Close a credit (expiry or explicit) and emit the refund of its unspent
   * backing. Idempotent: a second close, or closing an unknown credit, returns
   * undefined. The refund destination is the issuance side's call — we only
   * state the amount.
   */
  close(creditId: string, ts: number): RefundIntent | undefined {
    const credit = this.credits.get(creditId)
    if (!credit || this.closed.has(creditId)) return undefined
    this.closed.add(creditId)
    const reason: RefundIntent['reason'] =
      ts > credit.expiry ? 'expired' : credit.qtyRemaining === 0 ? 'exhausted' : 'closed'
    const amountMicro = credit.backingMicro
    credit.qtyRemaining = 0
    credit.backingMicro = 0
    return { creditId, owner: credit.owner, amountMicro, reason, ts }
  }
}
