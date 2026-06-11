import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Badge, Mark, Panel, Segmented, Stat } from '~/components/ui'
import { Orderbook } from '~/components/Orderbook'
import { UsageProjection } from '~/components/UsageProjection'
import { CAPABILITY_META } from '~/lib/capabilities'
import { cn } from '~/lib/cn'
import { compactUsd, pct, pricePerM, timeAgo, tokens } from '~/lib/format'
import { getMarket, getOffers, getOrderbook, getTrades, VENUES } from '~/lib/mock'
import type { TokenKind } from '~/lib/types'

export default function ModelMarketPage() {
  const params = useParams()
  const modelId = params['*'] ?? ''
  const navigate = useNavigate()
  const [kind, setKind] = useState<TokenKind>('output')

  const market = useMemo(() => getMarket(modelId, kind), [modelId, kind])
  const offers = useMemo(() => getOffers(modelId), [modelId])
  const ob = useMemo(() => getOrderbook(modelId, kind), [modelId, kind])
  const trades = useMemo(() => getTrades(modelId, kind, 16), [modelId, kind])

  if (!market) {
    return (
      <div className="px-6 py-16 text-center">
        <p className="font-data text-[14px] text-[var(--s-text-muted)]">Market not found.</p>
        <Link to="/" className="btn-secondary mt-4 h-9">
          Back to markets
        </Link>
      </div>
    )
  }
  const { model, lab, stats } = market

  return (
    <div>
      {/* Header */}
      <div className="border-b border-[var(--s-border)] px-4 py-4 sm:px-6">
        <Link to="/" className="mb-3 inline-flex items-center gap-1.5 font-data text-[12px] text-[var(--s-text-muted)] hover:text-[var(--s-text-secondary)]">
          <span className="i-ph:arrow-left text-[14px]" /> Markets
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <Mark hue={lab.hue} glyph={lab.glyph} label={lab.name} size={44} />
            <div>
              <h1 className="font-display text-[24px] font-bold leading-tight tracking-tight text-[var(--s-text)]">
                {model.name}
              </h1>
              <div className="mt-1 flex items-center gap-2 font-data text-[12px] text-[var(--s-text-muted)]">
                <span>{model.id}</span>
                <span className="text-[var(--s-text-subtle)]">·</span>
                <span>{model.contextK >= 1000 ? `${model.contextK / 1000}M` : `${model.contextK}K`} context</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              {model.capabilities.map((c) => {
                const meta = CAPABILITY_META[c]
                return (
                  <span
                    key={c}
                    className="flex h-7 w-7 items-center justify-center rounded-[5px]"
                    style={{ background: `color-mix(in srgb, ${meta.hue} 14%, transparent)` }}
                    title={meta.label}
                  >
                    <span className={cn(meta.icon, 'text-[14px]')} style={{ color: meta.hue }} />
                  </span>
                )
              })}
            </div>
            <Segmented
              value={kind}
              onChange={setKind}
              options={[
                { value: 'output', label: 'Output' },
                { value: 'input', label: 'Input' },
                { value: 'cache', label: 'Cache' },
              ]}
            />
            <button onClick={() => navigate(`/buy/${model.id}`)} className="btn-primary h-9">
              <span className="i-ph:lightning text-[15px]" /> Buy
            </button>
          </div>
        </div>
      </div>

      {/* Stats strip */}
      <div className="panel mx-4 mt-4 grid grid-cols-2 divide-x divide-y divide-[var(--s-divider)] sm:mx-6 sm:grid-cols-3 lg:grid-cols-6 lg:divide-y-0">
        <Stat label="Best discount" value={pct(stats.bestDiscount, 0)} tone="emerald" />
        <Stat label="Best price /1M" value={pricePerM(stats.bestOut)} tone="accent" sub={`list ${pricePerM(stats.listOut)}`} />
        <Stat label="Liquidity" value={tokens(stats.liquidityTokens)} sub={compactUsd(stats.liquidityNotionalMicro)} />
        <Stat label="24h volume" value={compactUsd(stats.volume24hMicro)} sub={`${stats.trades24h} trades`} />
        <Stat label="Active offers" value={stats.activeOffers} sub={`${stats.venues} venues`} />
        <Stat label="Spread" value={`${stats.spreadBps} bps`} sub="firm quotes" />
      </div>

      {/* Main grid */}
      <div className="grid grid-cols-1 gap-4 px-4 py-4 sm:px-6 lg:grid-cols-12">
        {/* Orderbook */}
        <Panel
          title="Order book"
          className="lg:col-span-4"
          right={<span className="font-data text-[11px] text-[var(--s-text-muted)]">{kind}</span>}
        >
          <Orderbook bids={ob.bids} asks={ob.asks} />
        </Panel>

        {/* Center: chart + trades */}
        <div className="flex flex-col gap-4 lg:col-span-4">
          <Panel title="Mid price · 24h" right={<Badge tone="emerald">{pct(stats.bestDiscount, 0)} off list</Badge>}>
            <div className="px-3 py-4">
              <PriceChart points={stats.spark} list={stats.listOut} />
            </div>
          </Panel>
          <Panel title="Recent trades" bodyClassName="max-h-[260px] overflow-y-auto">
            <table className="w-full border-collapse font-data text-[12px]">
              <tbody>
                {trades.map((t) => {
                  const venue = VENUES[t.venueId]!
                  return (
                    <tr key={t.id} className="border-b border-[var(--s-divider)] last:border-0 hover:bg-[var(--s-panel)]">
                      <td className="px-3 py-1.5">
                        <span
                          className={cn(
                            'font-semibold uppercase',
                            t.side === 'buy' ? 'text-[var(--s-emerald)]' : 'text-[var(--s-crimson)]',
                          )}
                        >
                          {t.side}
                        </span>
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
          </Panel>
        </div>

        {/* Right: projection + buy */}
        <div className="lg:col-span-4">
          <Panel title="Cost projection">
            <div className="px-4 py-4">
              <UsageProjection listMicroPerM={stats.listOut} bestMicroPerM={stats.bestOut} />
              <button
                onClick={() => navigate(`/buy/${model.id}`)}
                className="btn-primary mt-5 h-11 w-full !text-[14px]"
              >
                Buy {model.name} credits
              </button>
              <div className="mt-3 flex items-start gap-2 rounded-[6px] border border-[var(--s-divider)] px-3 py-2.5">
                <span className="i-ph:shield-check-fill mt-0.5 shrink-0 text-[16px] text-[var(--s-accent)]" />
                <p className="font-body text-[11px] leading-snug text-[var(--s-text-muted)]">
                  Credits are claims on bonded operators. If a redemption isn't served, you're refunded the full amount
                  <span className="text-[var(--s-text-secondary)]"> plus a penalty</span>, from operator collateral.
                </p>
              </div>
            </div>
          </Panel>
        </div>
      </div>

      {/* Venue / operator table */}
      <div className="px-4 pb-8 sm:px-6">
        <Panel
          title="Offers — operators & venues"
          right={<span className="font-data text-[11px] text-[var(--s-text-muted)]">{offers.length} live</span>}
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse">
              <thead>
                <tr className="border-b border-[var(--s-divider)] text-left">
                  <Th>Venue</Th>
                  <Th>Seller</Th>
                  <Th align="right">Discount</Th>
                  <Th align="right">Price /1M</Th>
                  <Th align="right">Offered</Th>
                  <Th align="right">Sold</Th>
                  <Th align="right">Remaining</Th>
                  <Th align="right">Updated</Th>
                  <Th className="w-16" />
                </tr>
              </thead>
              <tbody>
                {offers.map((o) => {
                  const venue = VENUES[o.venueId]!
                  const soldPct = o.offeredTokens > 0 ? o.soldTokens / o.offeredTokens : 0
                  return (
                    <tr key={o.id} className="border-b border-[var(--s-divider)] last:border-0 hover:bg-[var(--s-panel)]">
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <span className="h-2 w-2 rounded-full" style={{ background: venue.hue }} />
                          <span className="font-data text-[12px] text-[var(--s-text-secondary)]">{venue.name}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-1.5">
                          <span className="font-data text-[12px] text-[var(--s-text)]">{o.sellerLabel}</span>
                          {o.verified && <span className="i-ph:seal-check text-[13px] text-[var(--s-accent)]" title="Verified supply" />}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right font-data text-[12px] tabular-nums text-[var(--s-emerald)]">{pct(o.discount, 0)}</td>
                      <td className="px-3 py-2.5 text-right font-data text-[12px] font-semibold tabular-nums text-[var(--s-text)]">{pricePerM(o.price[kind])}</td>
                      <td className="px-3 py-2.5 text-right font-data text-[12px] tabular-nums text-[var(--s-text-muted)]">{tokens(o.offeredTokens)}</td>
                      <td className="px-3 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <div className="h-1 w-12 overflow-hidden rounded-full bg-[var(--s-border)]">
                            <div className="h-full bg-[var(--s-accent)]" style={{ width: `${soldPct * 100}%` }} />
                          </div>
                          <span className="font-data text-[12px] tabular-nums text-[var(--s-text-muted)]">{tokens(o.soldTokens)}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right font-data text-[12px] tabular-nums text-[var(--s-text-secondary)]">{tokens(o.remainingTokens)}</td>
                      <td className="px-3 py-2.5 text-right font-data text-[11px] tabular-nums text-[var(--s-text-subtle)]">{timeAgo(Date.now() - o.ageS * 1000)}</td>
                      <td className="px-3 py-2.5 text-right">
                        <button onClick={() => navigate(`/buy/${model.id}`)} className="btn-primary h-6 !px-2.5 !text-[10px]">
                          Buy
                        </button>
                      </td>
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

function Th({
  children,
  align = 'left',
  className,
}: {
  children?: React.ReactNode
  align?: 'left' | 'right'
  className?: string
}) {
  return (
    <th className={cn('mono-label h-9 px-3 font-semibold', align === 'right' ? 'text-right' : 'text-left', className)}>
      {children}
    </th>
  )
}

function PriceChart({ points, list }: { points: number[]; list: number }) {
  const W = 320
  const H = 120
  const all = [...points, list]
  const min = Math.min(...all)
  const max = Math.max(...all)
  const span = max - min || 1
  const stepX = W / (points.length - 1)
  const y = (p: number) => H - ((p - min) / span) * H
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * stepX).toFixed(1)},${y(p).toFixed(1)}`).join(' ')
  const up = points[points.length - 1]! >= points[0]!
  const color = up ? 'var(--s-emerald)' : 'var(--s-crimson)'
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-[120px] w-full overflow-visible">
      {/* list reference line */}
      <line x1={0} y1={y(list)} x2={W} y2={y(list)} stroke="var(--s-text-subtle)" strokeDasharray="3 3" strokeWidth={1} opacity={0.6} />
      <text x={4} y={y(list) - 4} className="font-data" fontSize={9} fill="var(--s-text-subtle)">
        list {pricePerM(list)}
      </text>
      <path d={`${d} L${W},${H} L0,${H} Z`} fill={color} opacity={0.08} />
      <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}
