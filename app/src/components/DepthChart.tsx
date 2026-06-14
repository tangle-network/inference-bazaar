/**
 * Market depth from the live book: cumulative bid size stepping down-price in
 * emerald, cumulative ask size stepping up-price in crimson — the standard
 * exchange depth view, drawn from real venue levels only.
 */
import { useMemo } from 'react'
import { Line } from 'react-chartjs-2'
import type { ChartOptions } from 'chart.js'
import type { BookLevel } from '~/lib/api'

function cssVar(name: string): string {
  if (typeof window === 'undefined') return '#00FF88'
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#00FF88'
}

function withAlpha(color: string, alpha: number): string {
  if (color.startsWith('#')) {
    const n = [color.slice(1, 3), color.slice(3, 5), color.slice(5, 7)].map((h) => parseInt(h, 16))
    return `rgba(${n[0]},${n[1]},${n[2]},${alpha})`
  }
  const m = color.match(/[\d.]+/g)
  return m ? `rgba(${m[0]},${m[1]},${m[2]},${alpha})` : color
}

export function DepthChart({
  bids,
  asks,
  height = 180,
  mini = false,
  formatX,
}: {
  bids: BookLevel[]
  asks: BookLevel[]
  height?: number
  /** Row-scale variant: no axes, thinner lines. */
  mini?: boolean
  formatX?: (price: number) => string
}) {
  const { points, bidData, askData } = useMemo(() => {
    // Cumulative depth out from the touch on each side.
    const sortedBids = [...bids].sort((a, b) => b.price - a.price)
    const sortedAsks = [...asks].sort((a, b) => a.price - b.price)
    let acc = 0
    const bidPts = sortedBids.map((l) => ({ x: l.price, y: (acc += l.qty) }))
    acc = 0
    const askPts = sortedAsks.map((l) => ({ x: l.price, y: (acc += l.qty) }))
    const xs = [...bidPts.map((p) => p.x), ...askPts.map((p) => p.x)].sort((a, b) => a - b)
    return {
      points: xs,
      bidData: xs.map((x) => bidPts.filter((p) => p.x >= x).at(-1)?.y ?? (bidPts.length && x <= bidPts[0]!.x ? bidPts.find((p) => p.x <= x)?.y ?? null : null)),
      askData: xs.map((x) => askPts.filter((p) => p.x <= x).at(-1)?.y ?? null),
    }
  }, [bids, asks])

  const emerald = cssVar('--s-emerald')
  const crimson = cssVar('--s-crimson')

  const options: ChartOptions<'line'> = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 250 },
      plugins: {
        tooltip: mini
          ? { enabled: false }
          : {
              backgroundColor: cssVar('--s-panel-strong'),
              borderColor: cssVar('--s-border'),
              borderWidth: 1,
              titleColor: cssVar('--s-text-muted'),
              bodyColor: cssVar('--s-text'),
              titleFont: { family: "'IBM Plex Mono', monospace", size: 11 },
              bodyFont: { family: "'IBM Plex Mono', monospace", size: 12, weight: 600 },
              displayColors: false,
              callbacks: {
                title: (items) => (formatX ? formatX(Number(items[0]?.label)) : String(items[0]?.label)),
                label: (item) => `${Number(item.parsed.y).toLocaleString()} tokens`,
              },
            },
      },
      scales: {
        x: {
          display: !mini,
          grid: { display: false },
          border: { display: false },
          ticks: {
            color: cssVar('--s-text-subtle'),
            font: { family: "'IBM Plex Mono', monospace", size: 10 },
            maxTicksLimit: 5,
            callback: (_, i) => (formatX && points[i] !== undefined ? formatX(points[i]!) : points[i]),
          },
        },
        y: {
          display: !mini,
          position: 'right',
          grid: { color: withAlpha(cssVar('--s-text'), 0.05) },
          border: { display: false },
          ticks: {
            color: cssVar('--s-text-subtle'),
            font: { family: "'IBM Plex Mono', monospace", size: 10 },
            maxTicksLimit: 4,
            callback: (v) => `${(Number(v) / 1000).toFixed(0)}k`,
          },
        },
      },
      elements: { point: { radius: 0 } },
    }),
    [mini, formatX, points],
  )

  const data = useMemo(
    () => ({
      labels: points,
      datasets: [
        {
          label: 'Bids',
          data: bidData,
          borderColor: emerald,
          backgroundColor: withAlpha(emerald, 0.16),
          borderWidth: mini ? 1.5 : 2,
          stepped: 'before' as const,
          fill: true,
        },
        {
          label: 'Asks',
          data: askData,
          borderColor: crimson,
          backgroundColor: withAlpha(crimson, 0.16),
          borderWidth: mini ? 1.5 : 2,
          stepped: 'after' as const,
          fill: true,
        },
      ],
    }),
    [points, bidData, askData, emerald, crimson, mini],
  )

  if (!bids.length && !asks.length) {
    return (
      <div className="flex items-center justify-center font-data text-[15px] text-[var(--s-text-subtle)]" style={{ height }}>
        no depth
      </div>
    )
  }
  return (
    <div style={{ height }}>
      <Line data={data} options={options} />
    </div>
  )
}
