/**
 * Formatters — the market's number language. Mirrors the arena conventions:
 * em-dash for null/zero, compact USD for stats, tabular mono everywhere.
 *
 * Price unit across the whole system: micro-tsUSD per 1M tokens (integer), the
 * same number the router reports — `15_000_000` = $15.00 / 1M tokens.
 */

const DASH = '—'

export function formatNumber(value: number, maxFrac = 2, minFrac = 0): string {
  if (!Number.isFinite(value)) return DASH
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: maxFrac,
    minimumFractionDigits: minFrac,
  }).format(value)
}

/** micro-tsUSD/1M -> "$15.00 / 1M" style price string. */
export function pricePerM(microPerM: number): string {
  if (!Number.isFinite(microPerM) || microPerM <= 0) return DASH
  const usd = microPerM / 1_000_000
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: usd < 1 ? 4 : 2 })}`
}

/** micro-tsUSD -> "$X.XX" / "$X.XK" / "$X.XXM". */
export function compactUsd(microUsd: number): string {
  if (!Number.isFinite(microUsd) || microUsd <= 0) return DASH
  const usd = microUsd / 1_000_000
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(2)}M`
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(1)}K`
  if (usd >= 1) return `$${usd.toFixed(2)}`
  return `$${usd.toFixed(4)}`
}

/** Plain USD amount (already in dollars) -> compact. */
export function usd(amount: number, frac = 2): string {
  if (!Number.isFinite(amount)) return DASH
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: frac, maximumFractionDigits: frac })}`
}

/** token counts -> 1.2M / 450K / 1,200. */
export function tokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return DASH
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return formatNumber(n, 0)
}

/** discount as a fraction (0.18) -> "18%" with a leading sign only if asked. */
export function pct(fraction: number, frac = 1): string {
  if (!Number.isFinite(fraction)) return DASH
  return `${(fraction * 100).toFixed(frac)}%`
}

export function signedPct(fraction: number, frac = 1): string {
  if (!Number.isFinite(fraction) || fraction === 0) return '0%'
  const sign = fraction > 0 ? '+' : ''
  return `${sign}${(fraction * 100).toFixed(frac)}%`
}

export function timeAgo(tsMs: number): string {
  const s = Math.max(0, Math.floor((Date.now() - tsMs) / 1000))
  if (s < 5) return 'now'
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

export function truncAddr(addr: string): string {
  if (!addr || addr.length < 12) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}
