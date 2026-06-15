/**
 * Aggressively sweep the market-maker's params against the deterministic
 * simulator and print a scorecard. `pnpm --filter @inference-bazaar/mm-eval sweep`.
 */
import type { Instrument, RiskLimits } from '@inference-bazaar/market-core'
import { runSweep } from './sweep'
import { scorecard } from './report'

const instrument: Instrument = {
  id: 'anthropic/claude-opus-4-8:output',
  modelId: 'anthropic/claude-opus-4-8',
  tokenKind: 'output',
  tickSize: 1000,
  minQty: 1000,
}

const limits: RiskLimits = {
  maxInventory: 400_000,
  maxQuoteNotional: 2_000_000_000,
  maxDeviationBps: 300,
  minSpreadBps: 2,
  killSwitchDrawdown: 5_000_000,
}

const result = await runSweep({
  instrument,
  sim: {
    initialRef: 15_000_000,
    driftPerTick: 0,
    volPerTick: 0.0015,
    takerIntensity: 3,
    takerSizeMean: 40_000,
    takerAggressionBps: 25,
  },
  seeds: [1, 7, 42, 101, 777],
  horizonTicks: 120,
  grid: {
    gamma: [8e-7, 1.5e-6, 2.5e-6, 4e-6],
    k: [1.0, 1.5, 2.5],
    size: [30_000, 50_000, 80_000],
  },
  baseParams: {
    sigma: 15_000_000 * 0.0015,
    maxInventory: 300_000,
    tickSize: instrument.tickSize,
  },
  limits,
})

console.log(scorecard(result))
