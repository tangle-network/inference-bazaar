import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { PageHeader } from '~/components/PageHeader'
import { Panel, Sparkline, Stat } from '~/components/ui'
import { cn } from '~/lib/cn'
import { compactUsd, pricePerM, timeAgo, tokens } from '~/lib/format'
import { getMarkets, getRecentTradesGlobal, VENUES } from '~/lib/mock'

export default function ActivityPage() {
  const trades = useMemo(() => getRecentTradesGlobal(40), [])
  const markets = useMemo(() => getMarkets('output'), [])
  const totalVol = markets.reduce((s, m) => s + m.stats.volume24hMicro, 0)
  const totalTrades = markets.reduce((s, m) => s + m.stats.trades24h, 0)
  const totalLiq = markets.reduce((s, m) => s + m.stats.liquidityNotionalMicro, 0)
  const volSeries = useMemo(() => markets.map((m) => m.stats.volume24hMicro).slice(0, 16), [markets])

  return (
    <div>
      <PageHeader title="Activity" subtitle="Live fills across every market, and where the volume is flowing right now." />
      <div className="px-4 py-4 sm:px-6">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="panel grid grid-cols-3 divide-x divide-[var(--s-divider)] lg:col-span-2">
            <Stat label="24h volume" value={compactUsd(totalVol)} tone="accent" />
            <Stat label="24h trades" value={tokens(totalTrades)} />
            <Stat label="Open liquidity" value={compactUsd(totalLiq)} />
          </div>
          <Panel title="Volume by market">
            <div className="flex items-center justify-center px-4 py-3">
              <Sparkline points={volSeries} width={280} height={48} tone="accent" />
            </div>
          </Panel>
        </div>

        <Panel className="mt-4" title="Recent fills" right={<span className="font-data text-[12px] text-[var(--s-text-muted)]">live</span>}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse font-data text-[13px]">
              <thead>
                <tr className="border-b border-[var(--s-divider)] text-left">
                  <th className="mono-label h-9 px-3">Side</th>
                  <th className="mono-label h-9 px-3">Model</th>
                  <th className="mono-label h-9 px-3 text-right">Price /1M</th>
                  <th className="mono-label h-9 px-3 text-right">Size</th>
                  <th className="mono-label h-9 px-3 text-right">Venue</th>
                  <th className="mono-label h-9 px-3 text-right">When</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t) => {
                  const venue = VENUES[t.venueId]!
                  return (
                    <tr key={t.id} className="border-b border-[var(--s-divider)] last:border-0 hover:bg-[var(--s-panel)]">
                      <td className="px-3 py-1.5">
                        <span className={cn('font-semibold uppercase', t.side === 'buy' ? 'text-[var(--s-emerald)]' : 'text-[var(--s-crimson)]')}>{t.side}</span>
                      </td>
                      <td className="px-3 py-1.5">
                        <Link to={`/m/${t.modelId}`} className="text-[var(--s-text)] hover:text-[var(--s-accent)]">
                          {t.modelName}
                        </Link>
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-[var(--s-text)]">{pricePerM(t.price)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-[var(--s-text-secondary)]">{tokens(t.tokens)}</td>
                      <td className="px-3 py-1.5 text-right">
                        <span className="inline-flex items-center gap-1.5">
                          <span className="h-1.5 w-1.5 rounded-full" style={{ background: venue.hue }} />
                          <span className="text-[var(--s-text-muted)]">{venue.name}</span>
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-[var(--s-text-subtle)]">{timeAgo(t.tsMs)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </div>
  )
}
