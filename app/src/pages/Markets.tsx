import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { PageHeader } from '~/components/PageHeader'
import { Badge, Mark, Segmented, Sparkline, Stat } from '~/components/ui'
import { CAPABILITY_META, CAPABILITY_ORDER } from '~/lib/capabilities'
import { cn } from '~/lib/cn'
import { compactUsd, pct, pricePerM, tokens } from '~/lib/format'
import { getMarkets, getOffers, VENUES } from '~/lib/mock'
import type { Capability, ModelMarket, TokenKind } from '~/lib/types'

type SortKey = 'discount' | 'liquidity' | 'volume' | 'price'

export default function MarketsPage() {
  const [kind, setKind] = useState<TokenKind>('output')
  const [query, setQuery] = useState('')
  const [caps, setCaps] = useState<Set<Capability>>(new Set())
  const [sort, setSort] = useState<SortKey>('discount')
  const [expanded, setExpanded] = useState<string | null>(null)

  const markets = useMemo(() => getMarkets(kind), [kind])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let rows = markets.filter((mm) => {
      if (q && !mm.model.name.toLowerCase().includes(q) && !mm.model.id.toLowerCase().includes(q) && !mm.lab.name.toLowerCase().includes(q))
        return false
      for (const c of caps) if (!mm.model.capabilities.includes(c)) return false
      return true
    })
    rows = rows.sort((a, b) => {
      switch (sort) {
        case 'liquidity':
          return b.stats.liquidityTokens - a.stats.liquidityTokens
        case 'volume':
          return b.stats.volume24hMicro - a.stats.volume24hMicro
        case 'price':
          return a.stats.bestOut - b.stats.bestOut
        default:
          return b.stats.bestDiscount - a.stats.bestDiscount
      }
    })
    return rows
  }, [markets, query, caps, sort])

  const featured = useMemo(() => {
    const top = (key: (m: ModelMarket) => number) => [...markets].sort((a, b) => key(b) - key(a))[0]!
    return {
      byDiscount: top((m) => m.stats.bestDiscount),
      byLiquidity: top((m) => m.stats.liquidityTokens),
      byVolume: top((m) => m.stats.volume24hMicro),
      totalLiquidity: markets.reduce((s, m) => s + m.stats.liquidityNotionalMicro, 0),
      totalVol: markets.reduce((s, m) => s + m.stats.volume24hMicro, 0),
    }
  }, [markets])

  function toggleCap(c: Capability) {
    setCaps((prev) => {
      const next = new Set(prev)
      if (next.has(c)) next.delete(c)
      else next.add(c)
      return next
    })
  }

  return (
    <div>
      <PageHeader
        title="Markets"
        subtitle="Buy discounted inference, sell your surplus. Every market trades prepaid token credits against the model's router list price."
        right={
          <Segmented
            value={kind}
            onChange={setKind}
            options={[
              { value: 'output', label: 'Output' },
              { value: 'input', label: 'Input' },
              { value: 'cache', label: 'Cache' },
            ]}
          />
        }
      />

      <div className="px-4 py-4 sm:px-6">
        {/* Featured strip */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <FeatureTile
            icon="i-ph:fire"
            tone="amber"
            label="Top discount"
            value={pct(featured.byDiscount.stats.bestDiscount, 0)}
            model={featured.byDiscount}
          />
          <FeatureTile
            icon="i-ph:drop"
            tone="accent"
            label="Deepest liquidity"
            value={tokens(featured.byLiquidity.stats.liquidityTokens)}
            valueSuffix=" tok"
            model={featured.byLiquidity}
          />
          <FeatureTile
            icon="i-ph:trend-up"
            tone="brand"
            label="24h volume leader"
            value={compactUsd(featured.byVolume.stats.volume24hMicro)}
            model={featured.byVolume}
          />
          <div className="panel grid grid-cols-2 divide-x divide-[var(--s-divider)]">
            <Stat label="Total liquidity" value={compactUsd(featured.totalLiquidity)} tone="accent" />
            <Stat label="24h volume" value={compactUsd(featured.totalVol)} />
          </div>
        </div>

        {/* Filters */}
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <div className="relative">
            <span className="i-ph:magnifying-glass pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[15px] text-[var(--s-text-muted)]" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models, labs…"
              className="h-9 w-56 rounded-[6px] border border-[var(--s-border)] bg-[var(--s-surface)] pl-8 pr-3 font-data text-[13px] text-[var(--s-text)] outline-none placeholder:text-[var(--s-text-subtle)] focus:border-[var(--s-border-hover)]"
            />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {CAPABILITY_ORDER.map((c) => {
              const meta = CAPABILITY_META[c]
              const active = caps.has(c)
              return (
                <button
                  key={c}
                  onClick={() => toggleCap(c)}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-[6px] border px-2.5 py-1.5 font-data text-[12px] font-medium transition-colors',
                    active
                      ? 'border-transparent text-[var(--s-accent-text)]'
                      : 'border-[var(--s-border)] text-[var(--s-text-muted)] hover:border-[var(--s-border-hover)] hover:text-[var(--s-text-secondary)]',
                  )}
                  style={active ? { background: 'var(--s-accent)' } : undefined}
                >
                  <span className={cn(meta.icon, 'text-[14px]')} style={active ? undefined : { color: meta.hue }} />
                  {meta.label}
                </button>
              )
            })}
            {caps.size > 0 && (
              <button
                onClick={() => setCaps(new Set())}
                className="font-data text-[12px] text-[var(--s-text-muted)] underline-offset-2 hover:text-[var(--s-crimson)] hover:underline"
              >
                clear
              </button>
            )}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className="mono-label">Sort</span>
            <Segmented
              size="sm"
              value={sort}
              onChange={setSort}
              options={[
                { value: 'discount', label: 'Discount' },
                { value: 'liquidity', label: 'Liquidity' },
                { value: 'volume', label: 'Volume' },
                { value: 'price', label: 'Price' },
              ]}
            />
          </div>
        </div>

        {/* Table */}
        <div className="panel mt-4 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] border-collapse">
              <thead>
                <tr className="border-b border-[var(--s-border)] text-left">
                  <Th className="w-[26%]">Model</Th>
                  <Th>Capabilities</Th>
                  <Th align="right">Best discount</Th>
                  <Th align="right">Best price /1M</Th>
                  <Th align="right">List /1M</Th>
                  <Th align="right">Liquidity</Th>
                  <Th align="right">24h vol</Th>
                  <Th align="right">Venues</Th>
                  <Th align="right">Trend</Th>
                  <Th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((mm) => (
                  <ModelRow
                    key={mm.model.id}
                    mm={mm}
                    kind={kind}
                    expanded={expanded === mm.model.id}
                    onToggle={() => setExpanded((e) => (e === mm.model.id ? null : mm.model.id))}
                  />
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={10} className="px-4 py-16 text-center font-data text-[13px] text-[var(--s-text-muted)]">
                      No markets match those filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}

function FeatureTile({
  icon,
  tone,
  label,
  value,
  valueSuffix,
  model,
}: {
  icon: string
  tone: 'amber' | 'accent' | 'brand'
  label: string
  value: string
  valueSuffix?: string
  model: ModelMarket
}) {
  const color = `var(--s-${tone === 'accent' ? 'accent' : tone})`
  return (
    <Link to={`/m/${model.model.id}`} className="panel panel-hover group flex flex-col justify-between px-3.5 py-2.5">
      <div className="flex items-center justify-between">
        <span className="mono-label">{label}</span>
        <span className={cn(icon, 'text-[15px]')} style={{ color }} />
      </div>
      <div className="mt-1.5 flex items-baseline gap-1">
        <span className="font-data text-[20px] font-bold tabular-nums" style={{ color }}>
          {value}
        </span>
        {valueSuffix && <span className="font-data text-[11px] text-[var(--s-text-muted)]">{valueSuffix}</span>}
      </div>
      <div className="mt-1 flex items-center gap-1.5 truncate">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: model.lab.hue }} />
        <span className="truncate font-data text-[11px] text-[var(--s-text-secondary)] group-hover:text-[var(--s-text)]">
          {model.model.name}
        </span>
      </div>
    </Link>
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
    <th
      className={cn(
        'mono-label h-9 px-3 font-semibold',
        align === 'right' ? 'text-right' : 'text-left',
        className,
      )}
    >
      {children}
    </th>
  )
}

function ModelRow({
  mm,
  kind,
  expanded,
  onToggle,
}: {
  mm: ModelMarket
  kind: TokenKind
  expanded: boolean
  onToggle: () => void
}) {
  const navigate = useNavigate()
  const { model, lab, stats } = mm
  return (
    <>
      <tr
        onClick={onToggle}
        className={cn(
          'cursor-pointer border-b border-[var(--s-divider)] transition-colors hover:bg-[var(--s-panel)]',
          expanded && 'bg-[var(--s-panel)]',
        )}
      >
        <td className="px-3 py-2.5">
          <div className="flex items-center gap-2.5">
            <Mark hue={lab.hue} glyph={lab.glyph} label={lab.name} />
            <div className="min-w-0">
              <div className="truncate font-data text-[13px] font-semibold text-[var(--s-text)]">{model.name}</div>
              <div className="truncate font-data text-[11px] text-[var(--s-text-muted)]">
                {lab.name} · {model.contextK >= 1000 ? `${model.contextK / 1000}M` : `${model.contextK}K`} ctx
              </div>
            </div>
          </div>
        </td>
        <td className="px-3 py-2.5">
          <div className="flex items-center gap-1">
            {model.capabilities.map((c) => {
              const meta = CAPABILITY_META[c]
              return (
                <span
                  key={c}
                  className="flex h-6 w-6 items-center justify-center rounded-[5px]"
                  style={{ background: `color-mix(in srgb, ${meta.hue} 14%, transparent)` }}
                  title={meta.label}
                >
                  <span className={cn(meta.icon, 'text-[13px]')} style={{ color: meta.hue }} />
                </span>
              )
            })}
          </div>
        </td>
        <td className="px-3 py-2.5 text-right">
          <Badge tone="emerald">{pct(stats.bestDiscount, 0)} off</Badge>
        </td>
        <td className="px-3 py-2.5 text-right font-data text-[13px] font-semibold tabular-nums text-[var(--s-accent)]">
          {pricePerM(stats.bestOut)}
        </td>
        <td className="px-3 py-2.5 text-right font-data text-[12px] tabular-nums text-[var(--s-text-muted)] line-through">
          {pricePerM(stats.listOut)}
        </td>
        <td className="px-3 py-2.5 text-right">
          <div className="font-data text-[13px] tabular-nums text-[var(--s-text)]">{tokens(stats.liquidityTokens)}</div>
          <div className="font-data text-[10px] tabular-nums text-[var(--s-text-muted)]">{compactUsd(stats.liquidityNotionalMicro)}</div>
        </td>
        <td className="px-3 py-2.5 text-right font-data text-[13px] tabular-nums text-[var(--s-text-secondary)]">
          {compactUsd(stats.volume24hMicro)}
        </td>
        <td className="px-3 py-2.5 text-right font-data text-[13px] tabular-nums text-[var(--s-text-secondary)]">
          {stats.venues}
        </td>
        <td className="px-3 py-2.5">
          <div className="flex justify-end">
            <Sparkline points={stats.spark} />
          </div>
        </td>
        <td className="px-2 py-2.5 text-right">
          <span
            className={cn(
              'i-ph:caret-down inline-block text-[14px] text-[var(--s-text-muted)] transition-transform',
              expanded && 'rotate-180',
            )}
          />
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-[var(--s-border)] bg-[var(--s-surface)]">
          <td colSpan={10} className="p-0">
            <ExpandedVenues modelId={model.id} kind={kind} onOpen={() => navigate(`/m/${model.id}`)} onBuy={() => navigate(`/buy/${model.id}`)} />
          </td>
        </tr>
      )}
    </>
  )
}

function ExpandedVenues({
  modelId,
  kind,
  onOpen,
  onBuy,
}: {
  modelId: string
  kind: TokenKind
  onOpen: () => void
  onBuy: () => void
}) {
  const offers = useMemo(() => getOffers(modelId), [modelId])
  return (
    <div className="s-fade-up px-3 py-3">
      <div className="mb-2 flex items-center justify-between px-1">
        <span className="mono-label">{offers.length} offers across {new Set(offers.map((o) => o.venueId)).size} venues</span>
        <div className="flex items-center gap-2">
          <button onClick={onOpen} className="btn-secondary h-7 !text-[11px]">
            Open market <span className="i-ph:arrow-up-right text-[12px]" />
          </button>
          <button onClick={onBuy} className="btn-primary h-7 !text-[11px]">
            Buy
          </button>
        </div>
      </div>
      <div className="overflow-hidden rounded-[6px] border border-[var(--s-divider)]">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-[var(--s-divider)] bg-[var(--s-panel)] text-left">
              <Th>Venue</Th>
              <Th>Seller</Th>
              <Th align="right">Discount</Th>
              <Th align="right">Price /1M</Th>
              <Th align="right">Offered</Th>
              <Th align="right">Sold</Th>
              <Th align="right">Remaining</Th>
              <Th className="w-16" />
            </tr>
          </thead>
          <tbody>
            {offers.slice(0, 8).map((o) => {
              const venue = VENUES[o.venueId]!
              return (
                <tr key={o.id} className="border-b border-[var(--s-divider)] last:border-0 hover:bg-[var(--s-panel)]">
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full" style={{ background: venue.hue }} />
                      <span className="font-data text-[12px] text-[var(--s-text-secondary)]">{venue.name}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      <span className="font-data text-[12px] text-[var(--s-text)]">{o.sellerLabel}</span>
                      {o.verified && (
                        <span className="i-ph:seal-check text-[13px] text-[var(--s-accent)]" title="Verified supply" />
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right font-data text-[12px] tabular-nums text-[var(--s-emerald)]">
                    {pct(o.discount, 0)}
                  </td>
                  <td className="px-3 py-2 text-right font-data text-[12px] font-semibold tabular-nums text-[var(--s-text)]">
                    {pricePerM(o.price[kind])}
                  </td>
                  <td className="px-3 py-2 text-right font-data text-[12px] tabular-nums text-[var(--s-text-muted)]">
                    {tokens(o.offeredTokens)}
                  </td>
                  <td className="px-3 py-2 text-right font-data text-[12px] tabular-nums text-[var(--s-text-muted)]">
                    {tokens(o.soldTokens)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <span className="font-data text-[12px] tabular-nums text-[var(--s-text-secondary)]">{tokens(o.remainingTokens)}</span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={onBuy} className="btn-primary h-6 !px-2.5 !text-[10px]">
                      Buy
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
