/**
 * Run the market-making loop against the deterministic simulator and print
 * the session report. `pnpm demo:mm` from the repo root.
 */
import {
  type Instrument,
  type QuoteParams,
  type RiskLimits,
  SimulatedMarket,
} from '@inference-bazaar/market-core'
import { runMarketMakingLoop } from './run'
import { SimVenue } from './sim-venue'

const instrument: Instrument = {
  id: 'anthropic/claude-opus-4-8:output',
  modelId: 'anthropic/claude-opus-4-8',
  tokenKind: 'output',
  tickSize: 1000,
  minQty: 1000,
}

const sim = new SimulatedMarket(instrument, {
  seed: 42,
  initialRef: 15_000_000, // $15.00 per 1M output tokens
  driftPerTick: 0,
  volPerTick: 0.0015,
  takerIntensity: 3,
  takerSizeMean: 40_000,
  takerAggressionBps: 25,
})

// gamma scaled so the A–S half-spread γσ²τ/2 sits ~10–15bps off mid —
// competitive against the simulator's 25bps taker aggression.
const params: QuoteParams = {
  gamma: 0.0000015,
  sigma: 15_000_000 * 0.0015,
  horizonTicks: 120,
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
  killSwitchDrawdown: 5_000_000, // $5 drawdown trips the session
}

const result = await runMarketMakingLoop({
  venue: new SimVenue(sim),
  params,
  limits,
  horizonTicks: 120,
})

const r = result.report
const usd = (micro: number): string => `$${(micro / 1_000_000).toFixed(4)}`
console.log(`decision        ${result.decision}`)
console.log(`instrument      ${r.instrumentId}`)
console.log(`ticks           ${r.ticksCompleted} (rejected quote sets: ${r.rejectedTicks})`)
console.log(`fills           ${r.fills}`)
console.log(`position        ${r.positionTokens} tokens`)
console.log(`equity          ${usd(r.equityMicro)}`)
console.log(`realized        ${usd(r.realizedMicro)}`)
console.log(`max drawdown    ${usd(r.maxDrawdownMicro)}`)
console.log(`kill switch     ${r.killSwitch}`)
console.log(`final ref mid   ${usd(r.finalRefMid)} per 1M tokens`)
console.log(`loop iterations ${result.loop.iterations.length}, cost $${result.loop.costUsd}`)
