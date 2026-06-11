import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PageHeader } from '~/components/PageHeader'
import { Badge, Segmented, Stat } from '~/components/ui'
import { DepthChart } from '~/components/DepthChart'
import { ProviderLogo } from '~/lib/logos'
import { cn } from '~/lib/cn'
import { compactUsd, pct, pricePerM, tokens } from '~/lib/format'
import { useCatalog, type CatalogModel, type VenueInstrument } from '~/lib/api'
import { useAggBooks, useAggInstruments, useVenueRegistry, type AggBook } from '~/lib/venues'

interface MarketRow {
  instrument: VenueInstrument
  model: CatalogModel
  book: AggBook | null
  listMicroPerM: number
  bestAsk: number | null
  bestBid: number | null
  discount: number | null
  liquidityTokens: number
  liquidityNotionalMicro: number
  venuesQuoting: number
}

function deriveRow(instrument: VenueInstrument, model: CatalogModel, book: AggBook | null): MarketRow {
  const list = instrument.token_kind === 'output' ? model.outputMicroPerM : model.inputMicroPerM
  const bestAsk = book?.asks[0]?.price ?? null
  const bestBid = book?.bids[0]?.price ?? null
  const levels = book ? [...book.bids, ...book.asks] : []
  return {
    instrument,
    model,
    book,
    listMicroPerM: list,
    bestAsk,
    bestBid,
    discount: bestAsk !== null && list > 0 ? 1 - bestAsk / list : null,
    liquidityTokens: levels.reduce((s, l) => s + l.qty, 0),
    liquidityNotionalMicro: levels.reduce((s, l) => s + Math.round((l.price * l.qty) / 1e6), 0),
    venuesQuoting: book?.perVenue.length ?? 0,
  }
}

type SortKey = 'discount' | 'liquidity' | 'price'
type Kind = 'output' | 'input'

export default function MarketsPage() {
  const navigate = useNavigate()
  const [kind, setKind] = useState<Kind>('output')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>('discount')
  const [expanded, setExpanded] = useState<string | null>(null)

  const catalog = useCatalog()
  const registry = useVenueRegistry()
  const instruments = useAggInstruments(registry.data)
  const ids = useMemo(
    () => (instruments.data ?? []).filter((i) => i.token_kind === kind).map((i) => i.id),
    [instruments.data, kind],
  )
  const books = useAggBooks(registry.data, ids)

  const rows: MarketRow[] = useMemo(() => {
    if (!instruments.data || !catalog.data) return []
    const q = query.trim().toLowerCase()
    let out = instruments.data
      .filter((i) => i.token_kind === kind)
      .map((i) => {
        const model = catalog.data.get(i.model_id)
        if (!model) return null
        return deriveRow(i, model, books.data?.get(i.id) ?? null)
      })
      .filter((r): r is MarketRow => r !== null)
    if (q) {
      out = out.filter(
        (r) =>
          r.model.name.toLowerCase().includes(q) ||
          r.model.id.toLowerCase().includes(q) ||
          r.model.provider.toLowerCase().includes(q),
      )
    }
    return out.sort((a, b) => {
      switch (sort) {
        case 'liquidity':
          return b.liquidityNotionalMicro - a.liquidityNotionalMicro
        case 'price':
          return (a.bestAsk ?? Infinity) - (b.bestAsk ?? Infinity)
        default:
          return (b.discount ?? -1) - (a.discount ?? -1)
      }
    })
  }, [instruments.data, catalog.data, books.data, kind, query, sort])

  const totals = useMemo(() => {
    const withBook = rows.filter((r) => r.book)
    return {
      markets: rows.length,
      liquidityMicro: withBook.reduce((s, r) => s + r.liquidityNotionalMicro, 0),
      bestDiscount: withBook.reduce<MarketRow | null>(
        (best, r) => ((r.discount ?? -1) > (best?.discount ?? -1) ? r : best),
        null,
      ),
      deepest: withBook.reduce<MarketRow | null>(
        (best, r) => (r.liquidityNotionalMicro > (best?.liquidityNotionalMicro ?? -1) ? r : best),
        null,
      ),
    }
  }, [rows])

  const loading = catalog.isLoading || instruments.isLoading
  const venueDown = instruments.isError
  const routerDown = catalog.isError

  return (
    <div>
      <PageHeader
        title="Markets"
        subtitle="Prepaid inference token credits, quoted live below each model's router list price."
        right={
          <Segmented
            value={kind}
            onChange={setKind}
            options={[
              { value: 'output', label: 'Output' },
              { value: 'input', label: 'Input' },
            ]}
          />
        }
      />

      <div className="px-4 py-4 sm:px-6">
        {(venueDown || routerDown) && (
          <div className="panel mb-4 flex items-center gap-3 border-[var(--s-crimson)]/30 px-4 py-3">
            <span className="i-ph:pulse text-[18px] text-[var(--s-crimson)]" />
            <span className="font-data text-[13px] text-[var(--s-text-secondary)]">
              {venueDown ? 'Venue API unreachable.' : 'Router catalog unreachable.'} Live data
              resumes automatically when the source recovers.
            </span>
          </div>
        )}

        {/* Live market totals — derived from the book, not asserted. */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <FeatureTile
            icon="i-ph:fire"
            tone="amber"
            label="Top discount"
            value={totals.bestDiscount?.discount != null ? pct(totals.bestDiscount.discount, 1) : '—'}
            row={totals.bestDiscount}
            onOpen={(r) => navigate(`/m/${r.instrument.id}`)}
          />
          <FeatureTile
            icon="i-ph:drop"
            tone="accent"
            label="Deepest book"
            value={totals.deepest ? compactUsd(totals.deepest.liquidityNotionalMicro) : '—'}
            row={totals.deepest}
            onOpen={(r) => navigate(`/m/${r.instrument.id}`)}
          />
          <div className="panel grid grid-cols-2 divide-x divide-[var(--s-divider)] lg:col-span-2">
            <Stat label="Markets" value={loading ? '…' : totals.markets} tone="accent" />
            <Stat label="Book liquidity" value={loading ? '…' : compactUsd(totals.liquidityMicro)} />
          </div>
        </div>

        {/* Filters */}
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <div className="relative">
            <span className="i-ph:magnifying-glass pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[15px] text-[var(--s-text-muted)]" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models, providers…"
              className="h-10 w-64 rounded-[8px] border border-[var(--s-border)] bg-[var(--s-glass)] pl-8 pr-3 font-data text-[14px] text-[var(--s-text)] outline-none backdrop-blur-[8px] placeholder:text-[var(--s-text-subtle)] focus:border-[var(--s-accent)]/40"
            />
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Segmented
              size="sm"
              value={sort}
              onChange={setSort}
              options={[
                { value: 'discount', label: 'Discount' },
                { value: 'liquidity', label: 'Liquidity' },
                { value: 'price', label: 'Price' },
              ]}
            />
          </div>
        </div>

        {/* The board */}
        <div className="panel mt-4 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] border-collapse">
              <thead>
                <tr className="border-b border-[var(--s-border)] text-left">
                  <Th className="w-[30%]">Model</Th>
                  <Th align="right">Discount</Th>
                  <Th align="right">Best ask /1M</Th>
                  <Th align="right">List /1M</Th>
                  <Th align="right">Book liquidity</Th>
                  <Th>Depth</Th>
                  <Th className="w-20" />
                </tr>
              </thead>
              <tbody>
                {loading &&
                  Array.from({ length: 8 }).map((_, i) => (
                    <tr key={i} className="border-b border-[var(--s-divider)] last:border-0">
                      <td colSpan={7} className="px-4 py-4">
                        <div className="h-5 animate-pulse rounded bg-[var(--s-panel-strong)]" style={{ width: `${88 - i * 6}%` }} />
                      </td>
                    </tr>
                  ))}
                {!loading && rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center font-data text-[14px] text-[var(--s-text-muted)]">
                      {venueDown ? 'Venue offline — no live markets to show.' : 'No markets match.'}
                    </td>
                  </tr>
                )}
                {rows.map((r) => (
                  <Row
                    key={r.instrument.id}
                    row={r}
                    expanded={expanded === r.instrument.id}
                    onToggle={() =>
                      setExpanded(expanded === r.instrument.id ? null : r.instrument.id)
                    }
                    onOpen={() => navigate(`/m/${r.instrument.id}`)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}

function Row({
  row,
  expanded,
  onToggle,
  onOpen,
}: {
  row: MarketRow
  expanded: boolean
  onToggle: () => void
  onOpen: () => void
}) {
  const { model, book, instrument } = row
  return (
    <>
      <tr
        onClick={onToggle}
        className="cursor-pointer border-b border-[var(--s-divider)] transition-colors last:border-0 hover:bg-[var(--s-panel)]"
      >
        <td className="px-4 py-3">
          <div className="flex items-center gap-3">
            <ProviderLogo provider={model.provider} size={34} />
            <div className="min-w-0">
              <div className="truncate font-body text-[15px] font-semibold text-[var(--s-text)]">
                {model.name}
              </div>
              <div className="truncate font-data text-[12px] text-[var(--s-text-muted)]">
                {model.provider}
                {model.contextLength > 0 &&
                  ` · ${model.contextLength >= 1_000_000 ? `${Math.round(model.contextLength / 1e6)}M` : `${Math.round(model.contextLength / 1000)}K`} ctx`}
              </div>
            </div>
          </div>
        </td>
        <td className="px-4 py-3 text-right">
          {row.discount != null ? (
            <Badge tone="emerald">{pct(row.discount, 1)}</Badge>
          ) : (
            <span className="font-data text-[13px] text-[var(--s-text-subtle)]">—</span>
          )}
        </td>
        <td className="px-4 py-3 text-right font-data text-[15px] font-semibold tabular-nums text-[var(--s-text)]">
          {row.bestAsk != null ? pricePerM(row.bestAsk) : '—'}
        </td>
        <td className="px-4 py-3 text-right font-data text-[14px] tabular-nums text-[var(--s-text-muted)] line-through decoration-[var(--s-text-subtle)]/60">
          {row.listMicroPerM > 0 ? pricePerM(row.listMicroPerM) : '—'}
        </td>
        <td className="px-4 py-3 text-right font-data text-[14px] tabular-nums text-[var(--s-text-secondary)]">
          {book ? compactUsd(row.liquidityNotionalMicro) : '—'}
        </td>
        <td className="px-4 py-3">
          {book ? (
            <DepthChart bids={book.bids} asks={book.asks} height={40} mini />
          ) : (
            <span className="font-data text-[12px] text-[var(--s-text-subtle)]">no book</span>
          )}
        </td>
        <td className="px-4 py-3 text-right">
          <button
            onClick={(e) => {
              e.stopPropagation()
              onOpen()
            }}
            className="btn-primary h-9"
          >
            Trade
          </button>
        </td>
      </tr>
      {expanded && book && (
        <tr className="border-b border-[var(--s-divider)] bg-[var(--s-surface)]/60 last:border-0">
          <td colSpan={7} className="px-4 py-4">
            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <div className="mono-label mb-2">
                  Aggregated book · {instrument.id} · {book.perVenue.length} venue{book.perVenue.length === 1 ? '' : 's'}
                </div>
                <DepthChart bids={book.bids} asks={book.asks} height={150} formatX={pricePerM} />
              </div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 self-center font-data text-[13px]">
                <KV k="Best bid" v={book.bids[0] ? pricePerM(book.bids[0].price) : '—'} tone="emerald" />
                <KV k="Best ask (NBBO)" v={book.asks[0] ? pricePerM(book.asks[0].price) : '—'} tone="crimson" />
                <KV k="Reference" v={pricePerM(book.refMid)} />
                <KV k="Operators quoting" v={String(book.perVenue.length)} />
                <KV k="Bid depth" v={`${tokens(book.bids.reduce((s, l) => s + l.qty, 0))} tok`} />
                <KV k="Ask depth" v={`${tokens(book.asks.reduce((s, l) => s + l.qty, 0))} tok`} />
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function KV({ k, v, tone }: { k: string; v: string; tone?: 'emerald' | 'crimson' }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-[var(--s-divider)] pb-1.5">
      <span className="text-[var(--s-text-muted)]">{k}</span>
      <span
        className="font-semibold tabular-nums"
        style={{ color: tone ? `var(--s-${tone})` : 'var(--s-text)' }}
      >
        {v}
      </span>
    </div>
  )
}

function FeatureTile({
  icon,
  tone,
  label,
  value,
  row,
  onOpen,
}: {
  icon: string
  tone: 'amber' | 'accent'
  label: string
  value: string
  row: MarketRow | null
  onOpen: (r: MarketRow) => void
}) {
  return (
    <button
      onClick={() => row && onOpen(row)}
      disabled={!row}
      className="panel panel-hover flex items-center gap-3 px-4 py-3 text-left disabled:cursor-default"
    >
      <span
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px]"
        style={{ background: `var(--s-${tone}-soft)` }}
      >
        <span className={cn(icon, 'text-[19px]')} style={{ color: `var(--s-${tone})` }} />
      </span>
      <div className="min-w-0">
        <div className="mono-label">{label}</div>
        <div className="truncate font-data text-[19px] font-bold tabular-nums text-[var(--s-text)]">
          {value}
        </div>
        {row && (
          <div className="truncate font-data text-[12px] text-[var(--s-text-muted)]">
            {row.model.name}
          </div>
        )}
      </div>
    </button>
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
    <th className={cn('mono-label h-11 px-4 font-semibold', align === 'right' ? 'text-right' : 'text-left', className)}>
      {children}
    </th>
  )
}
