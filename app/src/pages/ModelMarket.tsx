import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAccount } from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import { Badge, Panel, Segmented, Slider, Stat } from '~/components/ui'
import { Orderbook } from '~/components/Orderbook'
import { DepthChart } from '~/components/DepthChart'
import { ProviderLogo } from '~/lib/logos'
import { cn } from '~/lib/cn'
import { compactUsd, pct, pricePerM, tokens } from '~/lib/format'
import {
  placeOrder,
  useBook,
  useCatalog,
  useInstruments,
  type PlaceOrderResult,
} from '~/lib/api'

type Kind = 'output' | 'input'

export default function ModelMarketPage() {
  const params = useParams()
  const raw = params['*'] ?? ''
  // Route may carry "model:kind" (instrument) or bare model id.
  const [modelId, kindFromRoute] = raw.includes(':')
    ? [raw.slice(0, raw.lastIndexOf(':')), raw.slice(raw.lastIndexOf(':') + 1) as Kind]
    : [raw, null]
  const [kind, setKind] = useState<Kind>(kindFromRoute ?? 'output')

  const catalog = useCatalog()
  const instruments = useInstruments()
  const model = catalog.data?.get(modelId)
  const instrumentId = `${modelId}:${kind}`
  const hasInstrument = (instruments.data ?? []).some((i) => i.id === instrumentId)
  const book = useBook(hasInstrument ? instrumentId : null)

  const list = model ? (kind === 'output' ? model.outputMicroPerM : model.inputMicroPerM) : 0
  const bestAsk = book.data?.book.asks[0]?.price ?? null
  const discount = bestAsk != null && list > 0 ? 1 - bestAsk / list : null

  if (catalog.isLoading || instruments.isLoading) {
    return (
      <div className="px-6 py-16 text-center font-data text-[14px] text-[var(--s-text-muted)]">
        Loading live market…
      </div>
    )
  }
  if (!model) {
    return (
      <div className="px-6 py-16 text-center">
        <p className="font-data text-[14px] text-[var(--s-text-muted)]">
          {catalog.isError ? 'Router catalog unreachable.' : `No catalog entry for ${modelId}.`}
        </p>
        <Link to="/" className="btn-secondary mt-4 h-10">Back to markets</Link>
      </div>
    )
  }

  const levels = book.data ? [...book.data.book.bids, ...book.data.book.asks] : []
  const liquidityMicro = levels.reduce((s, l) => s + Math.round((l.price * l.qty) / 1e6), 0)
  const spread =
    book.data?.book.asks[0] && book.data.book.bids[0]
      ? book.data.book.asks[0].price - book.data.book.bids[0].price
      : null
  const mid =
    book.data?.book.asks[0] && book.data.book.bids[0]
      ? (book.data.book.asks[0].price + book.data.book.bids[0].price) / 2
      : null

  return (
    <div>
      {/* Header */}
      <div className="border-b border-[var(--s-border)] px-4 py-5 sm:px-6">
        <Link
          to="/"
          className="mb-3 inline-flex items-center gap-1.5 font-data text-[13px] text-[var(--s-text-muted)] hover:text-[var(--s-text-secondary)]"
        >
          <span className="i-ph:arrow-left text-[14px]" /> Markets
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex items-center gap-4">
            <ProviderLogo provider={model.provider} size={52} />
            <div>
              <h1 className="font-display text-[28px] font-bold leading-tight tracking-tight text-[var(--s-text)]">
                {model.name}
              </h1>
              <div className="mt-1 flex items-center gap-2 font-data text-[13px] text-[var(--s-text-muted)]">
                <span>{model.id}</span>
                {model.contextLength > 0 && (
                  <>
                    <span className="text-[var(--s-text-subtle)]">·</span>
                    <span>
                      {model.contextLength >= 1_000_000
                        ? `${Math.round(model.contextLength / 1e6)}M`
                        : `${Math.round(model.contextLength / 1000)}K`}{' '}
                      context
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>
          <Segmented
            value={kind}
            onChange={setKind}
            options={[
              { value: 'output', label: 'Output' },
              { value: 'input', label: 'Input' },
            ]}
          />
        </div>
      </div>

      {/* Live stats */}
      <div className="panel mx-4 mt-4 grid grid-cols-2 divide-x divide-y divide-[var(--s-divider)] sm:mx-6 sm:grid-cols-3 lg:grid-cols-6 lg:divide-y-0">
        <Stat label="Discount" value={discount != null ? pct(discount, 1) : '—'} tone="emerald" />
        <Stat
          label="Best ask /1M"
          value={bestAsk != null ? pricePerM(bestAsk) : '—'}
          tone="accent"
          sub={list > 0 ? `list ${pricePerM(list)}` : undefined}
        />
        <Stat label="Mid" value={mid != null ? pricePerM(mid) : '—'} />
        <Stat
          label="Spread"
          value={spread != null && mid ? `${((spread / mid) * 10_000).toFixed(0)} bps` : '—'}
        />
        <Stat label="Book liquidity" value={book.data ? compactUsd(liquidityMicro) : '—'} />
        <Stat
          label="Last trade"
          value={book.data?.book.last_trade_price ? pricePerM(book.data.book.last_trade_price) : 'none yet'}
        />
      </div>

      {/* Main grid */}
      <div className="grid grid-cols-1 gap-4 px-4 py-4 sm:px-6 lg:grid-cols-12">
        <Panel
          title="Order book"
          className="lg:col-span-4"
          right={<span className="font-data text-[12px] text-[var(--s-text-muted)]">{instrumentId}</span>}
        >
          {!hasInstrument ? (
            <EmptyNote text={`${kind} side not listed for this model yet.`} />
          ) : book.isLoading ? (
            <EmptyNote text="Loading book…" />
          ) : book.isError ? (
            <EmptyNote text="Venue unreachable." />
          ) : (
            <Orderbook bids={book.data!.book.bids} asks={book.data!.book.asks} />
          )}
        </Panel>

        <div className="flex flex-col gap-4 lg:col-span-4">
          <Panel
            title="Market depth"
            right={discount != null ? <Badge tone="emerald">{pct(discount, 1)} off list</Badge> : undefined}
          >
            <div className="px-3 py-4">
              {book.data ? (
                <DepthChart bids={book.data.book.bids} asks={book.data.book.asks} height={230} formatX={pricePerM} />
              ) : (
                <EmptyNote text={hasInstrument ? 'Loading…' : 'Not listed.'} />
              )}
            </div>
          </Panel>
          <Panel title="List vs market">
            <div className="grid grid-cols-2 divide-x divide-[var(--s-divider)] font-data">
              <div className="px-4 py-3">
                <div className="mono-label">Router list</div>
                <div className="mt-1 text-[20px] font-bold tabular-nums text-[var(--s-text-muted)] line-through decoration-[var(--s-text-subtle)]/50">
                  {list > 0 ? pricePerM(list) : '—'}
                </div>
              </div>
              <div className="px-4 py-3">
                <div className="mono-label">Here, right now</div>
                <div className="mt-1 text-[20px] font-bold tabular-nums text-[var(--s-emerald)]">
                  {bestAsk != null ? pricePerM(bestAsk) : '—'}
                </div>
              </div>
            </div>
          </Panel>
        </div>

        <div className="lg:col-span-4">
          <TradeTicket
            instrumentId={instrumentId}
            kind={kind}
            listMicroPerM={list}
            bestAsk={bestAsk}
            askDepth={book.data?.book.asks ?? []}
            onFilled={() => book.refetch()}
          />
        </div>
      </div>
    </div>
  )
}

/**
 * The ticket executes for real: a buy crosses the operator's live ask on the
 * venue book under the connected wallet's address. No wallet, no button.
 */
function TradeTicket({
  instrumentId,
  kind,
  listMicroPerM,
  bestAsk,
  askDepth,
  onFilled,
}: {
  instrumentId: string
  kind: Kind
  listMicroPerM: number
  bestAsk: number | null
  askDepth: { price: number; qty: number }[]
  onFilled: () => void
}) {
  const { address, isConnected } = useAccount()
  const [qtyM, setQtyM] = useState(5) // millions of tokens
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<PlaceOrderResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const qtyTokens = qtyM * 1_000_000
  // Walk the real ask depth for an exact cost preview.
  const preview = useMemo(() => {
    let remaining = qtyTokens
    let costMicro = 0
    let worst = bestAsk ?? 0
    for (const l of askDepth) {
      if (remaining <= 0) break
      const take = Math.min(remaining, l.qty)
      costMicro += Math.round((l.price * take) / 1e6)
      worst = l.price
      remaining -= take
    }
    return { costMicro, worst, covered: qtyTokens - remaining }
  }, [askDepth, qtyTokens, bestAsk])
  const listCostMicro = Math.round((listMicroPerM * qtyTokens) / 1e6)
  const savings = listCostMicro - preview.costMicro

  async function execute() {
    if (!address || preview.covered === 0) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const res = await placeOrder({
        instrumentId,
        side: 'buy',
        price: preview.worst,
        qtyTokens: preview.covered,
        owner: address,
      })
      setResult(res)
      onFilled()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel title={`Buy ${kind} tokens`}>
      <div className="px-4 py-4">
        <div className="flex items-baseline justify-between">
          <span className="mono-label">Quantity</span>
          <span className="font-data text-[15px] font-bold tabular-nums text-[var(--s-text)]">
            {tokens(qtyTokens)} tokens
          </span>
        </div>
        <Slider value={qtyM} min={1} max={50} onChange={setQtyM} className="mt-3" />

        <div className="mt-5 grid gap-2 font-data text-[13px]">
          <Line k="Fills against" v={`${askDepth.length} live ask levels`} />
          <Line k="Covered by book" v={`${tokens(preview.covered)} / ${tokens(qtyTokens)}`} />
          <Line k="Cost at market" v={compactUsd(preview.costMicro)} strong />
          <Line k="Cost at list" v={compactUsd(listCostMicro)} muted strike />
          {savings > 0 && (
            <div className="mt-1 flex items-center justify-between rounded-[8px] bg-[var(--s-emerald-soft)] px-3 py-2">
              <span className="text-[var(--s-emerald)]">You save</span>
              <span className="font-bold tabular-nums text-[var(--s-emerald)]">
                {compactUsd(savings)} ({listCostMicro > 0 ? pct(savings / listCostMicro, 1) : '—'})
              </span>
            </div>
          )}
        </div>

        <div className="mt-5">
          {!isConnected ? (
            <ConnectKitButton.Custom>
              {({ show }) => (
                <button onClick={show} className="btn-primary h-11 w-full !text-[14px]">
                  <span className="i-ph:wallet text-[16px]" /> Connect to trade
                </button>
              )}
            </ConnectKitButton.Custom>
          ) : (
            <button
              onClick={execute}
              disabled={busy || preview.covered === 0}
              className="btn-primary h-11 w-full !text-[14px]"
            >
              {busy ? 'Crossing the book…' : `Buy ${tokens(preview.covered)} at market`}
            </button>
          )}
        </div>

        {result && (
          <div className="mt-3 rounded-[8px] border border-[var(--s-emerald)]/30 bg-[var(--s-emerald-soft)] px-3 py-2.5 font-data text-[13px] text-[var(--s-emerald)]">
            Filled on the live venue book
            {Array.isArray(result.fills) && result.fills.length > 0 && (
              <> · {result.fills.length} fill{result.fills.length > 1 ? 's' : ''}</>
            )}
            . Settlement intent queued for the operator outbox.
          </div>
        )}
        {error && (
          <div className="mt-3 rounded-[8px] border border-[var(--s-crimson)]/30 bg-[var(--s-crimson-soft)] px-3 py-2.5 font-data text-[13px] text-[var(--s-crimson)]">
            {error}
          </div>
        )}

        <p className="mt-4 font-body text-[12px] leading-relaxed text-[var(--s-text-subtle)]">
          Orders execute against the operator's live quotes on Base Sepolia service 4. Fills emit
          settlement intents cleared by the collateral-backed settlement spine.
        </p>
      </div>
    </Panel>
  )
}

function Line({
  k,
  v,
  strong,
  muted,
  strike,
}: {
  k: string
  v: string
  strong?: boolean
  muted?: boolean
  strike?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-[var(--s-text-muted)]">{k}</span>
      <span
        className={cn(
          'tabular-nums',
          strong && 'text-[15px] font-bold text-[var(--s-text)]',
          muted && 'text-[var(--s-text-muted)]',
          strike && 'line-through decoration-[var(--s-text-subtle)]/60',
          !strong && !muted && 'text-[var(--s-text-secondary)]',
        )}
      >
        {v}
      </span>
    </div>
  )
}

function EmptyNote({ text }: { text: string }) {
  return (
    <div className="flex h-32 items-center justify-center font-data text-[13px] text-[var(--s-text-subtle)]">
      {text}
    </div>
  )
}
