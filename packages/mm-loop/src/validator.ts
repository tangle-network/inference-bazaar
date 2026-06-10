import { assessQuotes, type QuoteSet } from '@surplus/market-core'
import type { Validator } from '@tangle-network/agent-runtime/loops'
import type { MarketMakingSession } from './session'

/**
 * The risk gate as the loop's `Validator`. Every quote set — deterministic or
 * agent-authored — is scored against the session's live risk context, and the
 * verdict lands back on the session so the driver can act on a kill switch
 * the round after it trips. `valid: false` means the driver never applies
 * these quotes to the venue: fail-closed by wiring, not by convention.
 */
export function riskValidator(session: MarketMakingSession): Validator<QuoteSet> {
  return {
    async validate(output: QuoteSet) {
      const verdict = assessQuotes(output, session.riskContext())
      session.recordVerdict(verdict)
      return {
        valid: verdict.valid,
        score: verdict.score,
        scores: { risk: verdict.score, killSwitch: verdict.killSwitch ? 1 : 0 },
        notes: verdict.reasons.join('; ') || 'within limits',
      }
    },
  }
}
