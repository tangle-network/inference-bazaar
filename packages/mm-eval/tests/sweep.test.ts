import type { Instrument, RiskLimits } from '@inference-bazaar/market-core'
import { describe, expect, it } from 'vitest'
import { aggregate, score } from '../src/metrics'
import { runSweep, type SweepConfig } from '../src/sweep'

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

const baseConfig: SweepConfig = {
  instrument,
  sim: {
    initialRef: 15_000_000,
    driftPerTick: 0,
    volPerTick: 0.0015,
    takerIntensity: 3,
    takerSizeMean: 40_000,
    takerAggressionBps: 25,
  },
  seeds: [1, 7, 42],
  horizonTicks: 60,
  grid: { gamma: [1.5e-6, 2.5e-6], k: [1.5], size: [50_000] },
  baseParams: {
    sigma: 15_000_000 * 0.0015,
    maxInventory: 300_000,
    tickSize: instrument.tickSize,
  },
  limits,
}

describe('runSweep', () => {
  it('evaluates every grid cell across every seed and ranks them', async () => {
    const result = await runSweep(baseConfig)
    expect(result.cells).toHaveLength(2) // 2 gammas × 1 k × 1 size
    expect(result.sessions).toBe(6) // 2 cells × 3 seeds
    // sorted descending by score
    expect(result.cells[0]!.score).toBeGreaterThanOrEqual(result.cells[1]!.score)
    for (const cell of result.cells) {
      expect(cell.metrics.runs).toBe(3)
      expect(Number.isFinite(cell.metrics.realizedMean)).toBe(true)
    }
  })

  it('is deterministic — same config yields the same ranking', async () => {
    const a = await runSweep(baseConfig)
    const b = await runSweep(baseConfig)
    expect(a.cells.map((c) => [c.params.gamma, c.score])).toEqual(
      b.cells.map((c) => [c.params.gamma, c.score]),
    )
  })

  it('disqualifies any config that trips the kill switch on any seed', async () => {
    // A brutal drawdown cap so sessions trip the kill switch.
    const brutal = await runSweep({
      ...baseConfig,
      limits: { ...limits, killSwitchDrawdown: 1 },
    })
    for (const cell of brutal.cells) {
      if (cell.metrics.killSwitchRate > 0) {
        expect(cell.score).toBe(Number.NEGATIVE_INFINITY)
      }
    }
    // Winner, if any, never tripped the kill switch.
    if (brutal.winner) expect(brutal.winner.metrics.killSwitchRate).toBe(0)
  })
})

describe('score', () => {
  it('penalizes volatility and drawdown, disqualifies kill-switch configs', () => {
    const base = {
      runs: 5,
      realizedMean: 1000,
      realizedMedian: 1000,
      realizedStdev: 100,
      realizedMin: 800,
      equityMean: 1000,
      drawdownWorst: 400,
      fillsMean: 50,
      killSwitchRate: 0,
      inventoryAbsMean: 20_000,
      rejectedMean: 0,
    }
    // 1000 - 1.0*100 - 0.25*400 = 800
    expect(score(base)).toBe(800)
    // higher stdev → lower score
    expect(score({ ...base, realizedStdev: 300 })).toBeLessThan(score(base))
    // any kill switch → disqualified
    expect(score({ ...base, killSwitchRate: 0.2 })).toBe(Number.NEGATIVE_INFINITY)
    // a market maker that doesn't make a market → disqualified
    expect(score({ ...base, fillsMean: 1 })).toBe(Number.NEGATIVE_INFINITY)
  })
})

describe('aggregate', () => {
  it('computes mean/median/stdev/worst across seeds', () => {
    const reports = [
      report({ realizedMicro: 1000, maxDrawdownMicro: 200 }),
      report({ realizedMicro: 2000, maxDrawdownMicro: 500 }),
      report({ realizedMicro: 3000, maxDrawdownMicro: 100 }),
    ]
    const m = aggregate(reports)
    expect(m.realizedMean).toBe(2000)
    expect(m.realizedMedian).toBe(2000)
    expect(m.realizedMin).toBe(1000)
    expect(m.drawdownWorst).toBe(500)
    expect(m.killSwitchRate).toBe(0)
  })
})

function report(over: Partial<import('@inference-bazaar/mm-loop').SessionReport>) {
  return {
    owner: 'mm',
    instrumentId: 'x',
    ticksCompleted: 60,
    fills: 40,
    positionTokens: 0,
    equityMicro: 0,
    realizedMicro: 0,
    maxDrawdownMicro: 0,
    killSwitch: false,
    rejectedTicks: 0,
    finalRefMid: 15_000_000,
    ...over,
  }
}
