import type { QuoteParams, QuoteSet, RiskLimits } from '@surplus/market-core'
import {
  type AgentRunSpec,
  type LoopResult,
  type LoopTraceEmitter,
  runLoop,
  type SandboxClient,
} from '@tangle-network/agent-runtime/loops'
import { marketMakerDriver } from './driver'
import { algorithmicQuoterClient, algorithmicRunSpec } from './executors'
import { quoteSetOutput } from './output'
import { MarketMakingSession } from './session'
import type { MarketTick, MarketVenue, MMDecision, SessionReport } from './types'
import { riskValidator } from './validator'

export interface MMLoopOptions {
  venue: MarketVenue
  params: QuoteParams
  limits: RiskLimits
  horizonTicks: number
  /** Ledger/order owner id. Default 'surplus-mm'. */
  owner?: string
  /**
   * Algorithmic (default): deterministic A–S quoter, no sandbox, no tokens.
   * Agentic: BYO sandbox client + agent run spec (see `agenticRunSpec`).
   */
  mode?: 'algorithmic' | 'agentic'
  sandboxClient?: SandboxClient
  agentRun?: AgentRunSpec<MarketTick>
  traceEmitter?: LoopTraceEmitter
  signal?: AbortSignal
  runId?: string
}

export interface MMLoopResult {
  decision: MMDecision
  report: SessionReport
  loop: LoopResult<MarketTick, QuoteSet, MMDecision>
}

/**
 * One market-making session as one `runLoop` run: tick in, quotes out,
 * risk-gated, fully traced. This is the loop — point it at the simulator
 * to develop, at the marketplace venue to make markets.
 */
export async function runMarketMakingLoop(opts: MMLoopOptions): Promise<MMLoopResult> {
  const mode = opts.mode ?? 'algorithmic'
  const session = new MarketMakingSession({
    venue: opts.venue,
    owner: opts.owner ?? 'surplus-mm',
    params: opts.params,
    limits: opts.limits,
  })

  let sandboxClient: SandboxClient
  let agentRun: AgentRunSpec<MarketTick>
  if (mode === 'algorithmic') {
    sandboxClient = opts.sandboxClient ?? algorithmicQuoterClient()
    agentRun = opts.agentRun ?? algorithmicRunSpec()
  } else {
    if (!opts.sandboxClient || !opts.agentRun) {
      throw new Error('agentic mode requires `sandboxClient` and `agentRun` (see agenticRunSpec)')
    }
    sandboxClient = opts.sandboxClient
    agentRun = opts.agentRun
  }

  const loop = await runLoop<MarketTick, QuoteSet, MMDecision>({
    driver: marketMakerDriver({ session, horizonTicks: opts.horizonTicks }),
    agentRun,
    output: quoteSetOutput,
    validator: riskValidator(session),
    task: session.currentTick(),
    ctx: {
      sandboxClient,
      ...(opts.traceEmitter ? { traceEmitter: opts.traceEmitter } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    },
    // One extra round so the final plan() can commit the last tick's quotes,
    // advance, observe the horizon, and end the loop with a clean 'done'.
    maxIterations: opts.horizonTicks + 1,
    maxConcurrency: 1,
    ...(opts.runId ? { runId: opts.runId } : {}),
  })

  return { decision: loop.decision, report: session.report(), loop }
}
