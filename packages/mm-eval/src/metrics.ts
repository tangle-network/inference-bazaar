import type { SessionReport } from '@surplus/mm-loop'

/**
 * Aggregate metrics for one market-making config evaluated across many seeds.
 * Everything is in the system's base units (micro-tsUSD for money, tokens for
 * inventory) so a number is always a quantity with a denominator, never an
 * adjective.
 */
export interface ConfigMetrics {
  runs: number
  /** Realized PnL across seeds, micro-tsUSD. */
  realizedMean: number
  realizedMedian: number
  realizedStdev: number
  /** Worst single-seed realized PnL — the tail that matters. */
  realizedMin: number
  /** Mark-to-reference equity (realized + open inventory), micro-tsUSD. */
  equityMean: number
  /** Worst max-drawdown observed across seeds, micro-tsUSD. */
  drawdownWorst: number
  fillsMean: number
  /** Fraction of seeds whose session tripped the kill switch [0,1]. */
  killSwitchRate: number
  /** Mean absolute end-of-session inventory, tokens — residual exposure. */
  inventoryAbsMean: number
  /** Quote sets rejected by the risk gate per session (mean). */
  rejectedMean: number
}

export function aggregate(reports: SessionReport[]): ConfigMetrics {
  if (reports.length === 0) throw new Error('aggregate: no reports')
  const realized = reports.map((r) => r.realizedMicro)
  const kills = reports.filter((r) => r.killSwitch).length
  return {
    runs: reports.length,
    realizedMean: mean(realized),
    realizedMedian: median(realized),
    realizedStdev: stdev(realized),
    realizedMin: Math.min(...realized),
    equityMean: mean(reports.map((r) => r.equityMicro)),
    drawdownWorst: Math.max(...reports.map((r) => r.maxDrawdownMicro)),
    fillsMean: mean(reports.map((r) => r.fills)),
    killSwitchRate: kills / reports.length,
    inventoryAbsMean: mean(reports.map((r) => Math.abs(r.positionTokens))),
    rejectedMean: mean(reports.map((r) => r.rejectedTicks)),
  }
}

/**
 * Single risk-adjusted score, micro-tsUSD. Reward mean realized PnL; penalize
 * volatility across seeds (consistency) and worst-case drawdown. Any config
 * that EVER trips the kill switch is disqualified outright — a strategy that
 * blows through the drawdown limit even once is not a candidate, regardless of
 * average PnL. Higher is better.
 */
export interface ScoreWeights {
  /** Penalty per unit of cross-seed PnL stdev. Default 1.0 (Sharpe-like). */
  volatility: number
  /** Penalty per unit of worst-case drawdown. Default 0.25. */
  drawdown: number
  /**
   * A market maker MUST make a market. Configs averaging fewer than this many
   * fills per session are disqualified — a strategy that quotes so wide it never
   * trades scores zero PnL with zero risk, which is "safe" and useless. Default 5.
   */
  minFillsPerSession: number
}

const DEFAULT_WEIGHTS: ScoreWeights = { volatility: 1.0, drawdown: 0.25, minFillsPerSession: 5 }

export function score(m: ConfigMetrics, weights: ScoreWeights = DEFAULT_WEIGHTS): number {
  // Disqualify: tripping the kill switch, or failing to provide liquidity at all.
  if (m.killSwitchRate > 0) return Number.NEGATIVE_INFINITY
  if (m.fillsMean < weights.minFillsPerSession) return Number.NEGATIVE_INFINITY
  return m.realizedMean - weights.volatility * m.realizedStdev - weights.drawdown * m.drawdownWorst
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)
  return Math.sqrt(v)
}
