import { CreditBook, instrumentId } from './credit-book'
import type { Credit, DebitError, DebitResult, MeteredCall } from './types'
import { isDebitError } from './types'

export interface RedeemOutcome {
  debit: DebitResult
  /** Metered beyond quota — the router bills these at list. */
  overflowTokens: number
  /** Payout instruction the router/settlement clears from backing. */
  payout: { operator: string; amountMicro: number }
}

/**
 * The contract the Tangle Router implements (or calls) so a Surplus credit is
 * spendable. The router still does the actual inference + token metering; this
 * only handles credit selection + debit + operator payout instruction. On its
 * `/v1/chat/completions` path the router calls `selectCredit` pre-flight; if a
 * credit is returned it serves and meters as today, then calls `redeem` with
 * the metered count. Only the source of funds changes when a credit applies.
 */
export interface RedemptionAdapter {
  /**
   * Before serving: does this user hold a credit that covers (model, tokenKind)?
   * Returns the credit to debit, or null to fall back to normal balance.
   * Selection policy (e.g. soonest-expiry-first) lives here.
   */
  selectCredit(owner: string, model: string, tokenKind: 'input' | 'output', ts: number): Credit | null

  /**
   * After serving + metering: debit the credit for the metered tokens. Returns
   * the payout instruction the router/settlement clears, plus any overflow
   * tokens the credit could not cover (bill normally).
   */
  redeem(call: MeteredCall): RedeemOutcome | DebitError
}

/**
 * Reference adapter over a CreditBook. Selection is soonest-expiry-first
 * (use the quota most at risk of refunding), tie-broken by credit id so the
 * same book state always selects the same credit.
 */
export class DefaultRedemptionAdapter implements RedemptionAdapter {
  constructor(private readonly book: CreditBook) {}

  selectCredit(owner: string, model: string, tokenKind: 'input' | 'output', ts: number): Credit | null {
    const wanted = instrumentId(model, tokenKind)
    const candidates = this.book
      .creditsOf(owner)
      .filter(
        (c) => instrumentId(c.model, c.tokenKind) === wanted && c.qtyRemaining > 0 && ts <= c.expiry,
      )
      .sort((a, b) => a.expiry - b.expiry || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    return candidates[0] ?? null
  }

  redeem(call: MeteredCall): RedeemOutcome | DebitError {
    const debit = this.book.debit(call)
    if (isDebitError(debit)) return debit
    return {
      debit,
      overflowTokens: call.tokens - debit.tokensDebited,
      payout: { operator: call.operator, amountMicro: debit.operatorPayoutMicro },
    }
  }
}
