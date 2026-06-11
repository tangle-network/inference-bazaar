/**
 * Charts — chart.js with the arena treatment: gradient area fills, glowing
 * line, mono tabular axis ticks, list-price reference line. One registration,
 * theme colors read from the live --s-* tokens at render time.
 */
import { useMemo } from 'react'
import {
  CategoryScale,
  Chart as ChartJS,
  Filler,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
  type ChartOptions,
  type ScriptableContext,
} from 'chart.js'
import { Line } from 'react-chartjs-2'

ChartJS.register(LineElement, PointElement, LinearScale, CategoryScale, Filler, Tooltip)

function cssVar(name: string): string {
  if (typeof window === 'undefined') return '#A370FF'
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#A370FF'
}

/** rgba() from a hex or rgb token at a given alpha. */
function withAlpha(color: string, alpha: number): string {
  if (color.startsWith('#')) {
    const n = color.length === 4
      ? color.slice(1).split('').map((c) => parseInt(c + c, 16))
      : [color.slice(1, 3), color.slice(3, 5), color.slice(5, 7)].map((h) => parseInt(h, 16))
    return `rgba(${n[0]},${n[1]},${n[2]},${alpha})`
  }
  const m = color.match(/[\d.]+/g)
  return m ? `rgba(${m[0]},${m[1]},${m[2]},${alpha})` : color
}

function gradientFill(token: string, peak: number) {
  return (ctx: ScriptableContext<'line'>) => {
    const { chart } = ctx
    const { ctx: c, chartArea } = chart
    if (!chartArea) return withAlpha(cssVar(token), peak)
    const g = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom)
    const color = cssVar(token)
    g.addColorStop(0, withAlpha(color, peak))
    g.addColorStop(1, withAlpha(color, 0))
    return g
  }
}

const BASE_OPTS: ChartOptions<'line'> = {
  responsive: true,
  maintainAspectRatio: false,
  animation: { duration: 300 },
  interaction: { mode: 'index', intersect: false },
  plugins: { tooltip: { enabled: false } },
  scales: { x: { display: false }, y: { display: false } },
  elements: { point: { radius: 0 } },
}

/** Inline trend chart for table rows. Direction picks emerald/crimson. */
export function Sparkline({
  points,
  width = 132,
  height = 40,
  tone = 'auto',
}: {
  points: number[]
  width?: number
  height?: number
  tone?: 'auto' | 'accent' | 'emerald' | 'crimson'
}) {
  const up = points.length > 1 && points[points.length - 1]! >= points[0]!
  const token =
    tone === 'accent' ? '--s-accent' : tone === 'emerald' || (tone === 'auto' && up) ? '--s-emerald' : '--s-crimson'
  const data = useMemo(
    () => ({
      labels: points.map((_, i) => i),
      datasets: [
        {
          data: points,
          borderColor: cssVar(token),
          borderWidth: 1.8,
          fill: true,
          backgroundColor: gradientFill(token, 0.22),
          tension: 0.35,
        },
      ],
    }),
    [points, token],
  )
  if (points.length < 2) return <div style={{ width, height }} />
  return (
    <div style={{ width, height }}>
      <Line data={data} options={BASE_OPTS} />
    </div>
  )
}

/**
 * The instrument price chart: market price as a glowing gradient area against
 * the dashed list-price reference — the discount is the gap, made visceral.
 */
export function PriceChart({
  points,
  listPrice,
  height = 240,
  formatY,
}: {
  points: number[]
  listPrice: number
  height?: number
  formatY: (v: number) => string
}) {
  const data = useMemo(
    () => ({
      labels: points.map((_, i) => `${points.length - i}h`),
      datasets: [
        {
          label: 'Market',
          data: points,
          borderColor: cssVar('--s-emerald'),
          borderWidth: 2.5,
          fill: true,
          backgroundColor: gradientFill('--s-emerald', 0.25),
          tension: 0.35,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHoverBackgroundColor: cssVar('--s-emerald'),
        },
        {
          label: 'List price',
          data: points.map(() => listPrice),
          borderColor: withAlpha(cssVar('--s-text-muted'), 0.7),
          borderWidth: 1.5,
          borderDash: [6, 5],
          fill: false,
          pointRadius: 0,
          pointHoverRadius: 0,
        },
      ],
    }),
    [points, listPrice],
  )

  const options: ChartOptions<'line'> = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        tooltip: {
          backgroundColor: cssVar('--s-panel-strong'),
          borderColor: cssVar('--s-border'),
          borderWidth: 1,
          titleColor: cssVar('--s-text-muted'),
          bodyColor: cssVar('--s-text'),
          titleFont: { family: "'IBM Plex Mono', monospace", size: 11 },
          bodyFont: { family: "'IBM Plex Mono', monospace", size: 13, weight: 600 },
          padding: 10,
          cornerRadius: 8,
          displayColors: false,
          callbacks: {
            label: (item) => `${item.dataset.label}: ${formatY(item.parsed.y ?? 0)}`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          border: { display: false },
          ticks: {
            color: cssVar('--s-text-subtle'),
            font: { family: "'IBM Plex Mono', monospace", size: 11 },
            maxTicksLimit: 7,
          },
        },
        y: {
          position: 'right',
          grid: { color: withAlpha(cssVar('--s-text'), 0.05) },
          border: { display: false, dash: [4, 4] },
          ticks: {
            color: cssVar('--s-text-subtle'),
            font: { family: "'IBM Plex Mono', monospace", size: 11 },
            callback: (v) => formatY(Number(v)),
            maxTicksLimit: 6,
          },
        },
      },
    }),
    [formatY],
  )

  return (
    <div style={{ height }}>
      <Line data={data} options={options} />
    </div>
  )
}
