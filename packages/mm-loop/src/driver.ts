import type { QuoteSet } from '@surplus/market-core'
import type { Driver, Iteration } from '@tangle-network/agent-runtime/loops'
import type { MarketMakingSession } from './session'
import type { MarketTick, MMDecision } from './types'

export interface MarketMakerDriverOptions {
  session: MarketMakingSession
  /** Session length, ticks. The loop's `maxIterations` must be >= this + 1. */
  horizonTicks: number
}

/**
 * The market-making topology: a refine chain where each round is one market
 * tick. `plan()` is the only place venue state moves —
 *
 *   round N plan:  commit round N-1's quotes (iff the risk gate passed),
 *                  advance market time, observe → next tick task
 *   round N batch: executor (deterministic quoter or sandboxed agent) quotes
 *   round N validate: risk gate scores the quote set
 *
 * `plan()` returning `[]` ends the session (horizon or kill switch);
 * `decide()` then names the terminal state: 'done' on a completed horizon,
 * 'fail' on a kill switch.
 */
export function marketMakerDriver(opts: MarketMakerDriverOptions): Driver<MarketTick, QuoteSet, MMDecision> {
  const { session, horizonTicks } = opts
  return {
    name: 'surplus-market-maker',

    async plan(_task: MarketTick, history: ReadonlyArray<Iteration<MarketTick, QuoteSet>>) {
      if (session.killed()) return []
      if (history.length > 0) {
        const last = history[history.length - 1]!
        if (last.output && last.verdict?.valid === true) {
          session.applyQuotes(last.output)
        } else {
          // Failed gate or executor error: pull stale quotes rather than let
          // them ride a market view the maker no longer holds.
          session.pullQuotes()
        }
        session.advance()
        if (session.killed()) {
          session.pullQuotes()
          return []
        }
      }
      if (session.ticksCompleted() >= horizonTicks) {
        session.pullQuotes()
        return []
      }
      return [session.currentTick()]
    },

    decide(): MMDecision {
      if (session.killed()) return 'fail'
      if (session.ticksCompleted() >= horizonTicks) return 'done'
      return 'continue'
    },
  }
}
