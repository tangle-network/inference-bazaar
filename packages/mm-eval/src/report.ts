import type { SweepResult } from './sweep'

const usd = (micro: number): string => {
  if (!Number.isFinite(micro)) return '—'
  return `$${(micro / 1_000_000).toFixed(4)}`
}

/**
 * A plain-text scorecard of a sweep: the ranked grid + the winning config. The
 * artifact a desk reads to pick parameters — numbers and distributions, not
 * prose.
 */
export function scorecard(result: SweepResult, topN = 10): string {
  const lines: string[] = []
  lines.push(`Sessions run: ${result.sessions} (${result.cells.length} configs × seeds)`)
  lines.push('')
  lines.push('Rank  gamma       k     size    realizedMean  ±stdev    worstDD   fills  kill%  score')
  lines.push('────  ──────────  ────  ──────  ────────────  ────────  ────────  ─────  ─────  ──────────')
  result.cells.slice(0, topN).forEach((c, i) => {
    const m = c.metrics
    lines.push(
      [
        String(i + 1).padStart(4),
        c.params.gamma.toExponential(2).padStart(10),
        c.params.k.toFixed(2).padStart(4),
        String(c.params.size).padStart(6),
        usd(m.realizedMean).padStart(12),
        usd(m.realizedStdev).padStart(8),
        usd(m.drawdownWorst).padStart(8),
        m.fillsMean.toFixed(0).padStart(5),
        `${(m.killSwitchRate * 100).toFixed(0)}%`.padStart(5),
        Number.isFinite(c.score) ? usd(c.score).padStart(10) : 'DISQ'.padStart(10),
      ].join('  '),
    )
  })
  lines.push('')
  if (result.winner) {
    const w = result.winner
    lines.push('Winner:')
    lines.push(
      `  gamma=${w.params.gamma.toExponential(2)}  k=${w.params.k}  size=${w.params.size}`,
    )
    lines.push(
      `  realized ${usd(w.metrics.realizedMean)} (median ${usd(w.metrics.realizedMedian)}, ` +
        `worst-seed ${usd(w.metrics.realizedMin)}), worst drawdown ${usd(w.metrics.drawdownWorst)}, ` +
        `${w.metrics.fillsMean.toFixed(0)} fills/session, residual inventory ` +
        `${w.metrics.inventoryAbsMean.toFixed(0)} tokens.`,
    )
  } else {
    lines.push('Winner: none — every config tripped the kill switch on at least one seed.')
  }
  return lines.join('\n')
}
