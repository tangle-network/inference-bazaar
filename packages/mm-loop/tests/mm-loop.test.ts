import {
  computeQuotes,
  type Instrument,
  type QuoteParams,
  type RiskLimits,
  SimulatedMarket,
} from '@inference-bazaar/market-core'
import type { SandboxClient, SandboxEvent, SandboxInstance } from '@tangle-network/agent-runtime/loops'
import { describe, expect, it } from 'vitest'
import { agenticRunSpec } from '../src/executors'
import { quoteSetOutput } from '../src/output'
import { runMarketMakingLoop } from '../src/run'
import { SimVenue } from '../src/sim-venue'
import type { MarketTick } from '../src/types'

const instrument: Instrument = {
  id: 'anthropic/claude-opus-4-8:output',
  modelId: 'anthropic/claude-opus-4-8',
  tokenKind: 'output',
  tickSize: 1000,
  minQty: 1000,
}

const simConfig = {
  seed: 42,
  initialRef: 15_000_000,
  driftPerTick: 0,
  volPerTick: 0.0015,
  takerIntensity: 3,
  takerSizeMean: 40_000,
  takerAggressionBps: 25,
}

// gamma scaled so the A–S half-spread γσ²τ/2 ≈ 10bps of the $15.00 mid —
// inside the simulator's 25bps taker aggression, so quotes actually fill.
const params: QuoteParams = {
  gamma: 0.0000015,
  sigma: 15_000_000 * 0.0015,
  horizonTicks: 40,
  k: 1.5,
  size: 50_000,
  maxInventory: 300_000,
  tickSize: instrument.tickSize,
}

const limits: RiskLimits = {
  maxInventory: 400_000,
  maxQuoteNotional: 2_000_000_000,
  maxDeviationBps: 300,
  minSpreadBps: 2,
  killSwitchDrawdown: 5_000_000,
}

describe('runMarketMakingLoop — algorithmic mode', () => {
  const run = () =>
    runMarketMakingLoop({
      venue: new SimVenue(new SimulatedMarket(instrument, simConfig)),
      params,
      limits,
      horizonTicks: 40,
    })

  it('completes the horizon, trades, and reports a consistent session', async () => {
    const result = await run()
    expect(result.decision).toBe('done')
    expect(result.report.ticksCompleted).toBe(40)
    expect(result.loop.iterations).toHaveLength(40)
    expect(result.report.fills).toBeGreaterThan(0)
    expect(result.report.killSwitch).toBe(false)
    expect(Math.abs(result.report.positionTokens)).toBeLessThanOrEqual(limits.maxInventory)
    // Deterministic executor costs nothing.
    expect(result.loop.costUsd).toBe(0)
    // Every iteration parsed to a quote set and was risk-scored.
    for (const iter of result.loop.iterations) {
      expect(iter.error).toBeUndefined()
      expect(iter.output).toBeDefined()
      expect(iter.verdict).toBeDefined()
    }
  })

  it('is deterministic for a fixed seed', async () => {
    const [a, b] = await Promise.all([run(), run()])
    expect(a.report).toEqual(b.report)
  })

  it('trips the kill switch and fails the loop under a brutal drawdown cap', async () => {
    const result = await runMarketMakingLoop({
      venue: new SimVenue(
        new SimulatedMarket(instrument, { ...simConfig, driftPerTick: -0.01 }),
      ),
      params,
      // Any marked loss > $0.000001 trips: the first adverse tick with
      // inventory (or the first valid-quote round after) kills the session.
      limits: { ...limits, killSwitchDrawdown: 1 },
      horizonTicks: 40,
    })
    expect(result.decision).toBe('fail')
    expect(result.report.killSwitch).toBe(true)
    expect(result.report.ticksCompleted).toBeLessThan(40)
  })
})

describe('runMarketMakingLoop — agentic mode', () => {
  /**
   * A fake LLM sandbox: answers each prompt with prose + a fenced JSON quote
   * object (what a harnessed agent run ends with). Quotes come from the same
   * A–S baseline so the session behaves; the point is proving the agentic
   * path — prompt rendering, text parsing, risk gating — end to end.
   */
  function fakeAgentClient(): SandboxClient {
    return {
      async create(): Promise<SandboxInstance> {
        return {
          id: 'fake-agent-box',
          async *streamPrompt(message: string): AsyncGenerator<SandboxEvent> {
            const state = JSON.parse(message.slice(message.indexOf('{'), message.indexOf('\n\nHard risk limits'))) as {
              referenceMid: number
              inventoryTokens: number
            }
            const quotes = computeQuotes(state.referenceMid, state.inventoryTokens, params)
            yield {
              type: 'assistant',
              data: { text: 'Quoting around reference with inventory skew.' },
            } as unknown as SandboxEvent
            yield {
              type: 'result',
              data: {
                finalText: `Here are my quotes:\n\`\`\`json\n${JSON.stringify(quotes)}\n\`\`\``,
              },
            } as unknown as SandboxEvent
          },
          async delete(): Promise<void> {},
        } as unknown as SandboxInstance
      },
    }
  }

  it('drives the loop through prompt → fenced JSON → risk gate', async () => {
    const result = await runMarketMakingLoop({
      venue: new SimVenue(new SimulatedMarket(instrument, simConfig)),
      params,
      limits,
      horizonTicks: 10,
      mode: 'agentic',
      sandboxClient: fakeAgentClient(),
      agentRun: agenticRunSpec({ name: 'fake-agent' }),
    })
    expect(result.decision).toBe('done')
    expect(result.report.ticksCompleted).toBe(10)
    expect(result.report.fills).toBeGreaterThan(0)
  })

  it('rejects malformed and limit-breaching agent output without placing quotes', async () => {
    const rogueClient: SandboxClient = {
      async create(): Promise<SandboxInstance> {
        return {
          async *streamPrompt(): AsyncGenerator<SandboxEvent> {
            // Price 10x reference: parses fine, fails the deviation gate.
            yield {
              type: 'result',
              data: {
                finalText: '{"bid": {"price": 150000000, "qty": 50000}, "ask": null, "rationale": "moon"}',
              },
            } as unknown as SandboxEvent
          },
        } as unknown as SandboxInstance
      },
    }
    const result = await runMarketMakingLoop({
      venue: new SimVenue(new SimulatedMarket(instrument, simConfig)),
      params,
      limits,
      horizonTicks: 5,
      mode: 'agentic',
      sandboxClient: rogueClient,
      agentRun: agenticRunSpec({ name: 'rogue-agent' }),
    })
    expect(result.decision).toBe('done')
    expect(result.report.fills).toBe(0) // nothing ever hit the book
    expect(result.report.rejectedTicks).toBe(5)
    for (const iter of result.loop.iterations) {
      expect(iter.verdict?.valid).toBe(false)
    }
  })
})

describe('quoteSetOutput adapter', () => {
  const event = (data: unknown): SandboxEvent => ({ type: 'result', data }) as unknown as SandboxEvent

  it('parses bare JSON, fenced JSON, and prose-wrapped JSON', () => {
    const quotes = { bid: { price: 100, qty: 5 }, ask: { price: 110, qty: 5 }, rationale: 'x' }
    expect(quoteSetOutput.parse([event({ finalText: JSON.stringify(quotes) })])).toEqual(quotes)
    expect(
      quoteSetOutput.parse([event({ finalText: `prose\n\`\`\`json\n${JSON.stringify(quotes)}\n\`\`\`\nmore` })]),
    ).toEqual(quotes)
    expect(
      quoteSetOutput.parse([event({ text: `I think {"not":"this"} but rather ${JSON.stringify(quotes)}.` })]),
    ).toEqual(quotes)
  })

  it('treats null sides as pulled and rejects garbage', () => {
    const parsed = quoteSetOutput.parse([
      event({ finalText: '{"bid": null, "ask": {"price": 7, "qty": 2}, "rationale": "short only"}' }),
    ])
    expect(parsed.bid).toBeUndefined()
    expect(parsed.ask).toEqual({ price: 7, qty: 2 })
    expect(() => quoteSetOutput.parse([event({ finalText: 'no json here' })])).toThrow(/no JSON/)
    expect(() => quoteSetOutput.parse([])).toThrow(/no text/)
    expect(() =>
      quoteSetOutput.parse([event({ finalText: '{"bid": {"price": "high", "qty": 1}}' })]),
    ).toThrow(/numeric/)
  })
})
