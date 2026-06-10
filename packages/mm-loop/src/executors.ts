import { computeQuotes } from '@surplus/market-core'
import {
  type AgentProfile,
  type AgentRunSpec,
  inlineSandboxClient,
  type SandboxClient,
} from '@tangle-network/agent-runtime/loops'
import type { MarketTick } from './types'

/**
 * Algorithmic mode: the Avellaneda–Stoikov quoter as an inline `Executor`,
 * adapted to a `SandboxClient` via the runtime's own `inlineSandboxClient`
 * shell. Each "prompt" is the serialized tick; the "final text" is the quote
 * JSON. Zero tokens, zero USD, deterministic — and it flows through the exact
 * same kernel, adapter, and risk gate as the agentic mode.
 */
export function algorithmicQuoterClient(): SandboxClient {
  return inlineSandboxClient(() => {
    let artifact: {
      outRef: string
      out: { content: string }
      spent: { iterations: number; tokens: { input: number; output: number }; usd: number; ms: number }
    } = {
      outRef: 'quotes-unset',
      out: { content: '' },
      spent: { iterations: 0, tokens: { input: 0, output: 0 }, usd: 0, ms: 0 },
    }
    return {
      runtime: 'inline',
      budgetExempt: true,
      async execute(task: unknown) {
        const tick = JSON.parse(String(task)) as MarketTick
        const quotes = computeQuotes(tick.refMid, tick.inventoryTokens, tick.params)
        artifact = {
          outRef: `quotes-tick-${tick.tickIndex}`,
          out: { content: JSON.stringify(quotes) },
          spent: { iterations: 1, tokens: { input: 0, output: 0 }, usd: 0, ms: 0 },
        }
        return artifact
      },
      resultArtifact() {
        return artifact
      },
      async teardown() {
        return { destroyed: true }
      },
    }
  })
}

/** Spec for the algorithmic client: the prompt IS the tick, verbatim JSON. */
export function algorithmicRunSpec(): AgentRunSpec<MarketTick> {
  return {
    profile: { name: 'surplus-as-quoter' } as AgentProfile,
    name: 'as-quoter',
    taskToPrompt: (tick) => JSON.stringify(tick),
  }
}

/**
 * Agentic mode: a sandboxed agent receives the same tick plus trading doctrine
 * and answers with one JSON quote object. Use with a real
 * `@tangle-network/sandbox` client and a harness profile (e.g. claude-code).
 * The risk gate — not the prompt — is the safety boundary: anything the agent
 * returns outside limits is discarded unplaced.
 */
export function agenticRunSpec(profile: AgentProfile): AgentRunSpec<MarketTick> {
  return {
    profile,
    name: 'agentic-mm',
    taskToPrompt: (tick) => renderAgentPrompt(tick),
  }
}

export function renderAgentPrompt(tick: MarketTick): string {
  return [
    'You are a market maker on the Surplus inference-token exchange.',
    `Instrument: ${tick.instrument.id} — prepaid ${tick.instrument.tokenKind} tokens for ${tick.instrument.modelId}.`,
    'Prices are integer micro-tsUSD per 1M tokens; quantities are tokens.',
    '',
    `Market state (tick ${tick.tickIndex}):`,
    JSON.stringify(
      {
        referenceMid: tick.refMid,
        book: tick.book,
        inventoryTokens: tick.inventoryTokens,
        equityMicro: tick.equityMicro,
        drawdownMicro: tick.drawdownMicro,
      },
      null,
      2,
    ),
    '',
    'Hard risk limits (quotes violating ANY of these are rejected unplaced):',
    JSON.stringify(tick.limits, null, 2),
    '',
    'Suggested baseline parameters (Avellaneda–Stoikov):',
    JSON.stringify(tick.params, null, 2),
    '',
    'Decide your two-sided quotes for this tick. Skew away from your inventory;',
    'widen when volatility or drawdown grows; pull a side rather than breach a cap.',
    '',
    'Respond with EXACTLY one JSON object and nothing else:',
    '{"bid": {"price": <int>, "qty": <int>} | null, "ask": {"price": <int>, "qty": <int>} | null, "rationale": "<one line>"}',
  ].join('\n')
}
