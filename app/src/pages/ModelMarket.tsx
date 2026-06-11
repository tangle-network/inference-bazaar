import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAccount } from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import { Badge, Panel, Segmented, Slider, Stat } from '~/components/ui'
import { Orderbook } from '~/components/Orderbook'
import { DepthChart } from '~/components/DepthChart'
import { ProviderLogo } from '~/lib/logos'
import { cn } from '~/lib/cn'
import { compactUsd, pct, pricePerM, tokens } from '~/lib/format'
import { CHAIN, useCatalog, useInstruments } from '~/lib/api'
import { STEP_LABEL, useFirmTrade, type TradeProgress, type TradeReceipt } from '~/lib/trade'
import { useVenueRegistry, useAggBook } from '~/lib/venues'

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
  const registry = useVenueRegistry()
  const model = catalog.data?.get(modelId)
  const instrumentId = `${modelId}:${kind}`
  const hasInstrument = (instruments.data ?? []).some((i) => i.id === instrumentId)
  const agg = useAggBook(registry.data, hasInstrument ? instrumentId : null)

  const list = model ? (kind === 'output' ? model.outputMicroPerM : model.inputMicroPerM) : 0
  const bestAsk = agg.data?.asks[0]?.price ?? null
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

  const levels = agg.data ? [...agg.data.bids, ...agg.data.asks] : []
  const liquidityMicro = levels.reduce((s, l) => s + Math.round((l.price * l.qty) / 1e6), 0)
  const bestBid = agg.data?.bids[0]?.price ?? null
  const spread = bestAsk != null && bestBid != null ? bestAsk - bestBid : null
  const mid = bestAsk != null && bestBid != null ? (bestAsk + bestBid) / 2 : null
  const venuesQuoting = agg.data?.perVenue.length ?? 0

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
          value={
            spread == null || !mid ? '—' : spread < 0 ? 'crossed' : `${((spread / mid) * 10_000).toFixed(0)} bps`
          }
          sub={spread != null && spread < 0 ? 'venues disagree — arbitrage open' : undefined}
        />
        <Stat label="Book liquidity" value={agg.data ? compactUsd(liquidityMicro) : '—'} />
        <Stat label="Venues quoting" value={agg.data ? venuesQuoting : '—'} sub="across operators" />
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
          ) : agg.isError ? (
            <EmptyNote text="No venue reachable." />
          ) : !agg.data ? (
            <EmptyNote text="Aggregating venues…" />
          ) : (
            <Orderbook bids={agg.data.bids} asks={agg.data.asks} />
          )}
        </Panel>

        <div className="flex flex-col gap-4 lg:col-span-4">
          <Panel
            title="Market depth"
            right={discount != null ? <Badge tone="emerald">{pct(discount, 1)} off list</Badge> : undefined}
          >
            <div className="px-3 py-4">
              {agg.data ? (
                <DepthChart bids={agg.data.bids} asks={agg.data.asks} height={230} formatX={pricePerM} />
              ) : (
                <EmptyNote text={hasInstrument ? 'Loading…' : 'Not listed.'} />
              )}
            </div>
          </Panel>
          <Panel title="Reference vs firm">
            <div className="grid grid-cols-2 divide-x divide-[var(--s-divider)] font-data">
              <div className="px-4 py-3">
                <div className="mono-label">Router list price</div>
                <div className="mt-1 text-[20px] font-bold tabular-nums text-[var(--s-text-muted)] line-through decoration-[var(--s-text-subtle)]/50">
                  {list > 0 ? pricePerM(list) : '—'}
                </div>
              </div>
              <div className="px-4 py-3">
                <div className="mono-label">Best firm ask</div>
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
            askDepth={agg.data?.asks ?? []}
            venues={registry.data ?? []}
            onFilled={() => agg.refetch()}
          />
        </div>
      </div>
    </div>
  )
}

/**
 * Firm execution: RFQ from the operator (EIP-712 signed), the buyer signs the
 * matching order in their wallet, and settleFills clears on Base Sepolia —
 * deposited tsUSD moves, a collateral-backed credit lot is minted. The
 * settlement transaction is the proof.
 */
function TradeTicket({
  instrumentId,
  kind,
  listMicroPerM,
  bestAsk,
  askDepth,
  venues,
  onFilled,
}: {
  instrumentId: string
  kind: Kind
  listMicroPerM: number
  bestAsk: number | null
  askDepth: { price: number; qty: number }[]
  venues: import('~/lib/venues').Venue[]
  onFilled: () => void
}) {
  const { isConnected } = useAccount()
  const { buyLeg } = useFirmTrade()
  const [qtyM, setQtyM] = useState(5) // millions of tokens
  const [progress, setProgress] = useState<TradeProgress | null>(null)
  const [receipt, setReceipt] = useState<TradeReceipt | null>(null)
  const [error, setError] = useState<string | null>(null)

  const qtyTokens = qtyM * 1_000_000
  const estCostMicro = bestAsk != null ? Math.round((bestAsk * qtyTokens) / 1e6) : 0
  const listCostMicro = Math.round((listMicroPerM * qtyTokens) / 1e6)
  const savings = bestAsk != null ? listCostMicro - estCostMicro : 0
  const busy = progress !== null

  async function execute() {
    setError(null)
    setReceipt(null)
    try {
      const r = await buyLeg(instrumentId, qtyTokens, setProgress, venues)
      setReceipt(r)
      onFilled()
    } catch (e) {
      setError(e instanceof Error ? e.message.split('\n')[0]! : String(e))
    } finally {
      setProgress(null)
    }
  }

  return (
    <Panel title={`Buy ${kind} tokens — firm`}>
      <div className="px-4 py-4">
        <div className="flex items-baseline justify-between">
          <span className="mono-label">Quantity</span>
          <span className="font-data text-[15px] font-bold tabular-nums text-[var(--s-text)]">
            {tokens(qtyTokens)} tokens
          </span>
        </div>
        <Slider value={qtyM} min={1} max={50} onChange={setQtyM} className="mt-3" />

        <div className="mt-5 grid gap-2 font-data text-[13px]">
          <Line k="Indicative ask" v={bestAsk != null ? pricePerM(bestAsk) : '—'} />
          <Line k="Estimated cost" v={compactUsd(estCostMicro)} strong />
          <Line k="At router list" v={compactUsd(listCostMicro)} muted strike />
          <Line k="Ask depth" v={`${askDepth.length} levels`} />
          {savings > 0 && (
            <div className="mt-1 flex items-center justify-between rounded-[8px] bg-[var(--s-emerald-soft)] px-3 py-2">
              <span className="text-[var(--s-emerald)]">Saving vs list</span>
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
            <button onClick={execute} disabled={busy || bestAsk == null} className="btn-primary h-11 w-full !text-[14px]">
              {busy ? STEP_LABEL[progress!.step] + '…' : `Request firm quote · buy ${tokens(qtyTokens)}`}
            </button>
          )}
        </div>

        {progress && (
          <div className="mt-3 flex items-center gap-2 rounded-[8px] border border-[var(--s-accent)]/25 bg-[var(--s-accent-soft)] px-3 py-2.5 font-data text-[13px] text-[var(--s-accent)]">
            <span className="i-ph:circle-fill s-pulse text-[8px]" />
            {STEP_LABEL[progress.step]}
            {progress.detail ? ` — ${progress.detail}` : ''}
          </div>
        )}
        {receipt && (
          <div className="mt-3 rounded-[8px] border border-[var(--s-emerald)]/30 bg-[var(--s-emerald-soft)] px-3 py-2.5 font-data text-[13px] text-[var(--s-emerald)]">
            Settled: {tokens(receipt.qtyTokens)} at {pricePerM(receipt.priceMicroPerM)} ·{' '}
            {compactUsd(receipt.costMicro)} paid from your settlement balance.
            {receipt.settleTx && (
              <>
                {' '}
                <a
                  className="underline"
                  href={`${CHAIN.explorer}/tx/${receipt.settleTx}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Settlement transaction ↗
                </a>
              </>
            )}{' '}
            The credit lot is in your portfolio.
          </div>
        )}
        {error && (
          <div className="mt-3 rounded-[8px] border border-[var(--s-crimson)]/30 bg-[var(--s-crimson-soft)] px-3 py-2.5 font-data text-[13px] text-[var(--s-crimson)]">
            {error}
          </div>
        )}

        <p className="mt-4 font-body text-[12px] leading-relaxed text-[var(--s-text-subtle)]">
          Execution is atomic on SurplusSettlement (Base Sepolia): your signed order pairs with the
          operator's signed quote, payment debits your deposited balance, and the credit lot is
          minted against the issuer's on-chain collateral.
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
