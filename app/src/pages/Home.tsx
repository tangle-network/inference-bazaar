import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePublicClient } from 'wagmi'
import { keccak256, toBytes, decodeEventLog } from 'viem'
import { Slider } from '~/components/ui'
import { ProviderLogo } from '~/lib/logos'
import { cn } from '~/lib/cn'
import { compactUsd, pct, pricePerM, tokens } from '~/lib/format'
import { CHAIN, useCatalog, type BookLevel, type CatalogModel } from '~/lib/api'
import { SETTLEMENT } from '~/lib/settlement'
import { useAggBooks, useAggInstruments, useVenueRegistry, type AggBook } from '~/lib/venues'

/**
 * The front door. Not a trading floor — the answer a buyer actually came for:
 * "I use this model; here's what it costs me less." The order books, depth, and
 * operators are the engine room one click away (/markets); this is the lobby.
 *
 * Every number is live: list prices from the router catalog, the discount from
 * the NBBO across every healthy operator, the proof strip from real on-chain
 * settlements. Nothing here is asserted or mocked — if liquidity is thin the
 * page says so and points at the books.
 */
/** What you'd pay to fill `qty` against a real ask ladder, in micro-tsUSD.
 * Uncovered tokens fall back to list — you can always buy the rest at par. */
function fillCost(asks: BookLevel[] | undefined, qty: number, list: number): { cost: number; covered: boolean } {
  let remaining = qty
  let cost = 0
  let covered = false
  for (const l of asks ?? []) {
    if (remaining <= 0) break
    const take = Math.min(remaining, l.qty)
    cost += Math.round((l.price * take) / 1e6)
    remaining -= take
    covered = true
  }
  if (remaining > 0) cost += Math.round((list * remaining) / 1e6)
  return { cost, covered }
}

/** The discount actually realized buying `qty` — one honest number, shared by
 * the model chips and the hero so they can never disagree. */
function realized(asks: BookLevel[] | undefined, qty: number, list: number): number | null {
  if (!asks?.length || list <= 0) return null
  const { cost, covered } = fillCost(asks, qty, list)
  return covered ? 1 - cost / Math.round((list * qty) / 1e6) : null
}

export default function HomePage() {
  const navigate = useNavigate()
  const catalog = useCatalog()
  const registry = useVenueRegistry()
  const instruments = useAggInstruments(registry.data)

  // Output is the leg that dominates spend and where the discount bites; lead
  // with it. Pull every output book so the hero can default to the best deal.
  const outputIds = useMemo(
    () => (instruments.data ?? []).filter((i) => i.token_kind === 'output').map((i) => i.id),
    [instruments.data],
  )
  const books = useAggBooks(registry.data, outputIds)

  const [inputM, setInputM] = useState(50)
  const [outputM, setOutputM] = useState(10)

  // Models that actually trade here, ranked by the discount you'd REALIZE for
  // the current output size (not top-of-book) — so the chip and the hero never
  // disagree, and a thin best level can't advertise a deal you can't fill.
  const tradeable = useMemo(() => {
    if (!instruments.data || !catalog.data) return []
    const out: { model: CatalogModel; instrumentId: string; book: AggBook | null; discount: number | null }[] = []
    for (const i of instruments.data) {
      if (i.token_kind !== 'output') continue
      const model = catalog.data.get(i.model_id)
      if (!model) continue
      const book = books.data?.get(i.id) ?? null
      out.push({
        model,
        instrumentId: i.id,
        book,
        discount: realized(book?.asks, outputM * 1e6, model.outputMicroPerM),
      })
    }
    return out.sort((a, b) => (b.discount ?? -1) - (a.discount ?? -1))
  }, [instruments.data, catalog.data, books.data, outputM])

  const [picked, setPicked] = useState<string | null>(null)
  const entry = tradeable.find((t) => t.model.id === picked) ?? tradeable[0] ?? null

  // The two legs priced against their live books (input book fetched on demand
  // for the selected model only — the hero is one model at a time).
  const inputBook = useAggBooks(
    registry.data,
    entry ? [`${entry.model.id}:input`] : [],
  ).data?.get(`${entry?.model.id}:input`) ?? null

  const quote = useMemo(() => {
    if (!entry) return null
    const legs = [
      { kind: 'input' as const, qty: inputM * 1e6, list: entry.model.inputMicroPerM, asks: inputBook?.asks ?? [] },
      { kind: 'output' as const, qty: outputM * 1e6, list: entry.model.outputMicroPerM, asks: entry.book?.asks ?? [] },
    ]
    const priced = legs.map((leg) => {
      const listCost = Math.round((leg.list * leg.qty) / 1e6)
      const { cost, covered } = fillCost(leg.asks, leg.qty, leg.list)
      return {
        kind: leg.kind,
        qty: leg.qty,
        cost,
        listCost,
        // Leg discount = where the deal actually is (output is usually quoted).
        discount: covered && listCost > 0 ? 1 - cost / listCost : null,
      }
    })
    const cost = priced.reduce((s, l) => s + l.cost, 0)
    const list = priced.reduce((s, l) => s + l.listCost, 0)
    return {
      legs: priced,
      cost,
      list,
      savings: list - cost,
      anyCovered: priced.some((l) => l.discount !== null),
      operators: entry.book?.perVenue.length ?? 0,
    }
  }, [entry, inputM, outputM, inputBook])

  const loading = catalog.isLoading || instruments.isLoading || (outputIds.length > 0 && books.isLoading)
  const venueDown = instruments.isError && registry.isFetched

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
      {/* Hero */}
      <div className="max-w-2xl">
        <h1 className="font-display text-[36px] font-bold leading-[1.08] tracking-tight text-[var(--s-text)] sm:text-[44px]">
          The same models.
          <br />
          <span className="text-[var(--s-accent)]">Below list price.</span>
        </h1>
        <p className="mt-4 max-w-xl font-body text-[18px] leading-relaxed text-[var(--s-text-secondary)]">
          Buy Claude, GPT and more at a discount — each credit collateral-backed by the operator who sells it,
          settled on-chain, and spent through the same API you already call.
        </p>
      </div>

      {/* The instrument */}
      <div className="mt-8 grid gap-4 lg:grid-cols-12">
        {/* Model quick-pick — the live best deals, not a directory */}
        <div className="lg:col-span-5">
          <div className="flex flex-col gap-1.5">
            {loading &&
              Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-[58px] animate-pulse rounded-[10px] bg-[var(--s-panel)]" />
              ))}
            {!loading && tradeable.length === 0 && (
              <div className="panel px-4 py-5 font-data text-[15px] text-[var(--s-text-muted)]">
                {venueDown
                  ? 'Operators are offline — markets resume when a venue recovers.'
                  : 'Liquidity is seeding. Open the order books to watch it fill.'}
              </div>
            )}
            {tradeable.slice(0, 6).map((t) => {
              const active = t.model.id === entry?.model.id
              return (
                <button
                  key={t.model.id}
                  onClick={() => setPicked(t.model.id)}
                  className={cn(
                    'flex items-center gap-3 rounded-[10px] border px-3 py-2.5 text-left transition-colors',
                    active
                      ? 'border-[var(--s-accent)]/40 bg-[var(--s-accent-soft)]'
                      : 'border-[var(--s-border)] bg-[var(--s-panel)] hover:border-[var(--s-border-hover)]',
                  )}
                >
                  <ProviderLogo provider={t.model.provider} size={30} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-body text-[15px] font-semibold text-[var(--s-text)]">
                      {t.model.name}
                    </div>
                    <div className="truncate font-data text-[15px] text-[var(--s-text-muted)]">
                      {pricePerM(t.model.outputMicroPerM)} list
                    </div>
                  </div>
                  {t.discount != null && t.discount > 0 ? (
                    <span className="shrink-0 rounded-[5px] bg-[var(--s-emerald-soft)] px-1.5 py-0.5 font-data text-[15px] font-bold tabular-nums text-[var(--s-emerald)]">
                      −{pct(t.discount, 0)}
                    </span>
                  ) : (
                    <span className="shrink-0 font-data text-[15px] text-[var(--s-text-subtle)]">list</span>
                  )}
                </button>
              )
            })}
          </div>
        </div>

        {/* The savings result — the whole point of the page */}
        <div className="lg:col-span-7">
          {entry && quote ? (
            <div className="panel relative overflow-hidden p-5 sm:p-6">
              <div className="flex items-center gap-3">
                <ProviderLogo provider={entry.model.provider} size={36} />
                <div className="min-w-0">
                  <div className="truncate font-body text-[18px] font-semibold text-[var(--s-text)]">
                    {entry.model.name}
                  </div>
                  <div className="font-data text-[15px] text-[var(--s-text-muted)]">
                    {quote.operators > 0
                      ? `${quote.operators} operator${quote.operators === 1 ? '' : 's'} quoting now`
                      : 'no live quotes — priced at list'}
                  </div>
                </div>
              </div>

              <div className="mt-5 grid gap-5 sm:grid-cols-2">
                <UsageDial label="Input / month" hint="prompts, context" value={inputM} max={500} onChange={setInputM} />
                <UsageDial label="Output / month" hint="completions, code" value={outputM} max={200} onChange={setOutputM} />
              </div>

              <div className="mt-6 flex flex-wrap items-end justify-between gap-4 rounded-[12px] bg-[var(--s-emerald-soft)] px-5 py-4">
                <div>
                  <div className="mono-label !text-[var(--s-emerald)]">You save / month</div>
                  <div className="mt-1 font-display text-[44px] font-bold leading-none tabular-nums text-[var(--s-emerald)]">
                    {quote.savings > 0 ? compactUsd(quote.savings) : '—'}
                  </div>
                </div>
                <div className="text-right font-data text-[15px] text-[var(--s-text-secondary)]">
                  <div className="tabular-nums">
                    <span className="font-semibold text-[var(--s-text)]">{compactUsd(quote.cost)}</span>{' '}
                    <span className="text-[var(--s-text-muted)] line-through">{compactUsd(quote.list)}</span>
                  </div>
                  {quote.list > 0 && quote.savings > 0 && (
                    <div className="mt-0.5 text-[var(--s-emerald)]">{pct(quote.savings / quote.list, 1)} off list</div>
                  )}
                </div>
              </div>

              {/* Per-leg breakdown — reconciles the headline with where the
                  discount actually is (operators quote output far more than
                  input, so a leg priced at list reads honestly, not as a bug). */}
              <div className="mt-3 grid grid-cols-2 gap-2 font-data text-[15px]">
                {quote.legs.map((l) => (
                  <div
                    key={l.kind}
                    className="flex items-center justify-between rounded-[8px] border border-[var(--s-divider)] px-3 py-2"
                  >
                    <span className="capitalize text-[var(--s-text-muted)]">{l.kind}</span>
                    <span className="tabular-nums">
                      <span className="text-[var(--s-text-secondary)]">{compactUsd(l.cost)}</span>{' '}
                      {l.discount != null && l.discount > 0.0005 ? (
                        <span className="font-semibold text-[var(--s-emerald)]">−{pct(l.discount, 0)}</span>
                      ) : (
                        <span className="text-[var(--s-text-subtle)]">list</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>

              <button
                onClick={() => navigate(`/buy/${entry.model.id}`)}
                disabled={!quote.anyCovered}
                className="btn-primary mt-4 h-12 w-full !text-[15px]"
              >
                {quote.anyCovered ? 'Lock in this price →' : 'No live liquidity yet'}
              </button>
            </div>
          ) : (
            <div className="panel flex h-full min-h-[280px] items-center justify-center p-6 text-center font-data text-[15px] text-[var(--s-text-muted)]">
              {loading ? 'Pricing the live books…' : 'Select a model to see your discount.'}
            </div>
          )}
        </div>
      </div>

      <ProofStrip />

      {/* Engine room — for the trader, not the lobby */}
      <button
        onClick={() => navigate('/markets')}
        className="panel panel-hover mt-4 flex w-full items-center justify-between px-5 py-3.5 text-left"
      >
        <div className="flex items-center gap-3">
          <span className="i-ph:chart-line-up text-[18px] text-[var(--s-accent)]" />
          <span className="font-data text-[15px] text-[var(--s-text-secondary)]">
            Want the order books, depth and operator-by-operator quotes?
          </span>
        </div>
        <span className="font-data text-[15px] font-semibold text-[var(--s-accent)]">Open the market →</span>
      </button>
    </div>
  )
}

function UsageDial({
  label,
  hint,
  value,
  max,
  onChange,
}: {
  label: string
  hint: string
  value: number
  max: number
  onChange: (v: number) => void
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="mono-label">{label}</span>
        <span className="font-data text-[18px] font-bold tabular-nums text-[var(--s-text)]">
          {tokens(value * 1e6)}
        </span>
      </div>
      <Slider value={value} min={1} max={max} onChange={onChange} className="mt-3" />
      <p className="mt-1.5 font-data text-[12px] text-[var(--s-text-subtle)]">{hint}</p>
    </div>
  )
}

// ── Live proof: real on-chain settlements, the trust anchor for a new market ──

interface Fill {
  instrument: `0x${string}`
  qtyTokens: bigint
  costMicro: bigint
  execPriceMicroPerM: bigint
  tx: string
  block: bigint
}

const FILL_EVENT = {
  type: 'event',
  name: 'FillSettled',
  inputs: [
    { name: 'buyOrderHash', type: 'bytes32', indexed: true },
    { name: 'sellOrderHash', type: 'bytes32', indexed: true },
    { name: 'instrument', type: 'bytes32', indexed: false },
    { name: 'qtyTokens', type: 'uint64', indexed: false },
    { name: 'execPriceMicroPerM', type: 'uint64', indexed: false },
    { name: 'costMicro', type: 'uint256', indexed: false },
    { name: 'lotId', type: 'bytes32', indexed: false },
  ],
} as const

function ProofStrip() {
  const client = usePublicClient({ chainId: CHAIN.id })
  const catalog = useCatalog()
  const registry = useVenueRegistry()
  const instruments = useAggInstruments(registry.data)
  const [fills, setFills] = useState<Fill[] | null>(null)

  // instrument hash -> model name, so a fill reads "Claude Sonnet", not a hash.
  const nameByHash = useMemo(() => {
    const m = new Map<string, string>()
    for (const i of instruments.data ?? []) {
      const model = catalog.data?.get(i.model_id)
      m.set(keccak256(toBytes(i.id)), `${model?.name ?? i.model_id} ${i.token_kind}`)
    }
    return m
  }, [instruments.data, catalog.data])

  useEffect(() => {
    if (!client) return
    let cancelled = false
    ;(async () => {
      try {
        const head = await client.getBlockNumber()
        // Bounded to the public RPC's log window, floored at deploy.
        const windowStart = head > 4000n ? head - 4000n : 0n
        const from = windowStart > SETTLEMENT.fromBlock ? windowStart : SETTLEMENT.fromBlock
        const logs = await client.getLogs({ address: SETTLEMENT.address, event: FILL_EVENT, fromBlock: from, toBlock: head })
        if (cancelled) return
        const parsed: Fill[] = logs.slice(-8).reverse().map((l) => {
          const { args } = decodeEventLog({ abi: [FILL_EVENT], data: l.data, topics: l.topics })
          return {
            instrument: args.instrument,
            qtyTokens: args.qtyTokens,
            costMicro: args.costMicro,
            execPriceMicroPerM: args.execPriceMicroPerM,
            tx: l.transactionHash,
            block: l.blockNumber,
          }
        })
        setFills(parsed)
      } catch {
        if (!cancelled) setFills([]) // RPC refused the range — degrade quietly
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client])

  if (fills === null || fills.length === 0) return null

  return (
    <div className="panel mt-8 overflow-hidden">
      <div className="flex items-center gap-2 border-b border-[var(--s-divider)] px-4 py-2.5">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--s-emerald)] shadow-[0_0_8px_var(--s-emerald)] s-pulse" />
        <span className="mono-label !text-[var(--s-text-secondary)]">Settling live on Base Sepolia</span>
      </div>
      <div className="divide-y divide-[var(--s-divider)]">
        {fills.map((f) => {
          const name = nameByHash.get(f.instrument) ?? 'inference'
          return (
            <a
              key={f.tx + f.instrument}
              href={`${CHAIN.explorer}/tx/${f.tx}`}
              target="_blank"
              rel="noreferrer"
              className="flex items-center justify-between px-4 py-2.5 transition-colors hover:bg-[var(--s-panel)]"
            >
              <div className="min-w-0 font-data text-[15px] text-[var(--s-text-secondary)]">
                <span className="font-semibold text-[var(--s-text)]">{tokens(Number(f.qtyTokens))}</span> {name}{' '}
                <span className="text-[var(--s-text-muted)]">at {pricePerM(Number(f.execPriceMicroPerM))}</span>
              </div>
              <div className="flex shrink-0 items-center gap-3 font-data text-[15px] tabular-nums">
                <span className="font-semibold text-[var(--s-emerald)]">{compactUsd(Number(f.costMicro))}</span>
                <span className="hidden text-[var(--s-text-subtle)] sm:inline">tx ↗</span>
              </div>
            </a>
          )
        })}
      </div>
    </div>
  )
}
