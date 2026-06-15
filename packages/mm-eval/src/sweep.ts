import {
  type Instrument,
  type QuoteParams,
  type RiskLimits,
  type SimConfig,
  SimulatedMarket,
} from '@inference-bazaar/market-core'
import { runMarketMakingLoop, SimVenue } from '@inference-bazaar/mm-loop'
import { aggregate, type ConfigMetrics, score, type ScoreWeights } from './metrics'

/**
 * The axes to sweep. Each is a list of candidate values; the sweep is the full
 * Cartesian product, each cell evaluated across every seed. Keep grids small —
 * this is deterministic backtesting, not a GPU search.
 */
export interface ParamGrid {
  /** Risk aversion γ — controls spread width + inventory skew strength. */
  gamma: number[]
  /** Fill-intensity decay k from the A–S model. */
  k: number[]
  /** Quote size per side, tokens. */
  size: number[]
}

export interface SweepConfig {
  instrument: Instrument
  /** Base simulator config; `seed` is overridden per run. */
  sim: Omit<SimConfig, 'seed'>
  seeds: number[]
  horizonTicks: number
  grid: ParamGrid
  /** Params held fixed across the grid (sigma, maxInventory, tickSize). `horizonTicks`
   *  is injected from `horizonTicks` above. */
  baseParams: Omit<QuoteParams, 'gamma' | 'k' | 'size' | 'horizonTicks'>
  limits: RiskLimits
  weights?: ScoreWeights
}

export interface SweepCell {
  params: QuoteParams
  metrics: ConfigMetrics
  score: number
}

export interface SweepResult {
  cells: SweepCell[]
  /** Best by score (kill-switch configs disqualified). Undefined if all blew up. */
  winner: SweepCell | undefined
  /** Total sessions run = cells × seeds. */
  sessions: number
}

/**
 * Evaluate every grid cell across every seed against the deterministic
 * simulator and rank by risk-adjusted score. Pure and reproducible: same config
 * → same ranking, so a tuning result is a fact, not a roll of the dice.
 */
export async function runSweep(config: SweepConfig): Promise<SweepResult> {
  const cells: SweepCell[] = []
  let sessions = 0
  for (const gamma of config.grid.gamma) {
    for (const k of config.grid.k) {
      for (const size of config.grid.size) {
        const params: QuoteParams = {
          ...config.baseParams,
          gamma,
          k,
          size,
          horizonTicks: config.horizonTicks,
        }
        const reports = []
        for (const seed of config.seeds) {
          const sim = new SimulatedMarket(config.instrument, { ...config.sim, seed })
          const result = await runMarketMakingLoop({
            venue: new SimVenue(sim),
            params,
            limits: config.limits,
            horizonTicks: config.horizonTicks,
          })
          reports.push(result.report)
          sessions += 1
        }
        const metrics = aggregate(reports)
        cells.push({ params, metrics, score: score(metrics, config.weights) })
      }
    }
  }
  cells.sort((a, b) => b.score - a.score)
  const winner = cells.find((c) => Number.isFinite(c.score))
  return { cells, winner, sessions }
}
