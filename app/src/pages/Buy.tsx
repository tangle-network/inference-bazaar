import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useAccount } from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import { PageHeader } from '~/components/PageHeader'
import { Panel, Slider } from '~/components/ui'
import { ProviderLogo } from '~/lib/logos'
import { cn } from '~/lib/cn'
import { compactUsd, pct, pricePerM, tokens } from '~/lib/format'
import { CHAIN, useCatalog, useInstruments } from '~/lib/api'
import { STEP_LABEL, useFirmTrade, type TradeProgress, type TradeReceipt } from '~/lib/trade'
import { useAggBook, useVenueRegistry } from '~/lib/venues'
import { planRoute } from '~/lib/router'

/**
 * Inference burns input AND output tokens on every call — so you buy usage,
 * not one leg. The ticket prices both legs against their live books and
 * executes both orders.
 */
export default function BuyPage() {
  const params = useParams()
  const routeModel = (params['*'] ??'').replace(/:(input|output)$/, '')

  const catalog = useCatalog()
  const instruments = useInstruments()

  // Models tradeable here = models with at least one live instrument.
  const tradeable = useMemo(() => {
    if (!instruments.data || !catalog.data) return []
    const byModel = new Map<string, { output: boolean; input: boolean }>()
    for (const i of instruments.data) {
      const cur = byModel.get(i.model_id) ?? { output: false, input: false }
      cur[i.token_kind] = true
      byModel.set(i.model_id, cur)
    }
    return [...byModel.entries()]
      .map(([id, kinds]) => ({ model: catalog.data!.get(id)!, kinds }))
      .filter((x) => !!x.model)
      .sort((a, b) => a.model.name.localeCompare(b.model.name))
  }, [instruments.data, catalog.data])

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const modelId = selectedId ?? (routeModel || tradeable[0]?.model.id) ?? null
  const entry = tradeable.find((t) => t.model.id === modelId) ?? null

  // Monthly usage, in millions of tokens.
  const [inputM, setInputM] = useState(50)
  const [outputM, setOutputM] = useState(10)

  // Price + execute against the MERGED (cross-venue) NBBO ladder, not a single
  // home venue — so the quote the user sees is exactly the liquidity execution
  // sweeps (see ~/lib/router planRoute). registry must be resolved first.
  const registry = useVenueRegistry()
  const outBook = useAggBook(registry.data, entry?.kinds.output ? `${modelId}:output` : null)
  const inBook = useAggBook(registry.data, entry?.kinds.input ? `${modelId}:input` : null)

  const quote = useMemo(() => {
    if (!entry) return null
    const legs: {
      kind: 'input' | 'output'
      qty: number
      listMicroPerM: number
      asks: { price: number; qty: number }[]
    }[] = []
    if (entry.kinds.input)
      legs.push({
        kind: 'input',
        qty: inputM * 1_000_000,
        listMicroPerM: entry.model.inputMicroPerM,
        asks: inBook.data?.asks ?? [],
      })
    if (entry.kinds.output)
      legs.push({
        kind: 'output',
        qty: outputM * 1_000_000,
        listMicroPerM: entry.model.outputMicroPerM,
        asks: outBook.data?.asks ?? [],
      })
    const priced = legs.map((leg) => {
      let remaining = leg.qty
      let cost = 0
      let worst = 0
      for (const l of leg.asks) {
        if (remaining <= 0) break
        const take = Math.min(remaining, l.qty)
        cost += Math.round((l.price * take) / 1e6)
        worst = l.price
        remaining -= take
      }
      return {
        ...leg,
        covered: leg.qty - remaining,
        costMicro: cost,
        worstPrice: worst,
        listCostMicro: Math.round((leg.listMicroPerM * leg.qty) / 1e6),
      }
    })
    const cost = priced.reduce((s, l) => s + l.costMicro, 0)
    const listCost = priced.reduce((s, l) => s + l.listCostMicro, 0)
    return { legs: priced, costMicro: cost, listCostMicro: listCost, savingsMicro: listCost - cost }
  }, [entry, inputM, outputM, inBook.data, outBook.data])

  const { address, isConnected } = useAccount()
  const { buyLeg } = useFirmTrade()
  const [progress, setProgress] = useState<(TradeProgress & { leg?: string }) | null>(null)
  const [receipts, setReceipts] = useState<TradeReceipt[]>([])
  const [error, setError] = useState<string | null>(null)
  const busy = progress !== null

  async function execute() {
    if (!address || !quote || !modelId) return
    setError(null)
    setReceipts([])
    try {
      const venues = registry.data ?? []
      const done: TradeReceipt[] = []
      for (const leg of quote.legs) {
        if (leg.covered <= 0) continue
        const onProg = (p: TradeProgress) => setProgress({ ...p, leg: leg.kind })
        // Walk the merged ladder into a split plan, then fill each venue's slice
        // through the firm path (passing a single-venue set pins that operator).
        // This is the SOR: sweep the genuinely-cheapest liquidity wherever it
        // sits, matching the quote shown above.
        const book = leg.kind === 'output' ? outBook.data : inBook.data
        const route = book ? planRoute(book, 'buy', leg.covered) : null
        const subLegs = route?.legs ?? []
        if (subLegs.length === 0) {
          // No agg book (single-venue dev, or stale) — best across all venues.
          done.push(await buyLeg(`${modelId}:${leg.kind}`, leg.covered, onProg, venues))
          continue
        }
        for (const rleg of subLegs) {
          const venue = venues.find(
            (v) => v.operator.toLowerCase() === rleg.operator.toLowerCase(),
          )
          if (!venue) continue
          done.push(await buyLeg(`${modelId}:${leg.kind}`, rleg.qtyTokens, onProg, [venue]))
        }
      }
      setReceipts(done)
      void outBook.refetch()
      void inBook.refetch()
    } catch (e) {
      setError(e instanceof Error ? e.message.split('\n')[0]! : String(e))
    } finally {
      setProgress(null)
    }
  }

  return (
    <div>
      <PageHeader
        title="Buy inference"
        subtitle="Price your real monthly usage — both token legs — against the live books, then fill at the discount."
      />

      <div className="grid grid-cols-1 gap-4 px-4 py-4 sm:px-6 lg:grid-cols-12">
        {/* Model picker */}
        <Panel title="Model" className="lg:col-span-4" bodyClassName="max-h-[560px] overflow-y-auto">
          {tradeable.length === 0 && (
            <div className="px-4 py-10 text-center font-data text-[13px] text-[var(--s-text-muted)]">
              {instruments.isError ? 'Venue offline.' : 'Loading live markets…'}
            </div>
          )}
          {tradeable.map(({ model }) => (
            <button
              key={model.id}
              onClick={() => setSelectedId(model.id)}
              className={cn(
                'flex w-full items-center gap-3 border-b border-[var(--s-divider)] px-4 py-3 text-left transition-colors last:border-0',
                model.id === modelId ? 'bg-[var(--s-accent-soft)]' : 'hover:bg-[var(--s-panel)]',
              )}
            >
              <ProviderLogo provider={model.provider} size={30} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-body text-[14px] font-semibold text-[var(--s-text)]">
                  {model.name}
                </div>
                <div className="truncate font-data text-[12px] text-[var(--s-text-muted)]">
                  in {pricePerM(model.inputMicroPerM)} · out {pricePerM(model.outputMicroPerM)} list
                </div>
              </div>
              {model.id === modelId && <span className="i-ph:check text-[16px] text-[var(--s-accent)]" />}
            </button>
          ))}
        </Panel>

        {/* Usage + quote */}
        <div className="flex flex-col gap-4 lg:col-span-8">
          <Panel title="Monthly usage">
            <div className="grid gap-6 px-4 py-5 sm:grid-cols-2">
              <div>
                <div className="flex items-baseline justify-between">
                  <span className="mono-label">Input tokens</span>
                  <span className="font-data text-[16px] font-bold tabular-nums text-[var(--s-text)]">
                    {tokens(inputM * 1_000_000)}
                  </span>
                </div>
                <Slider value={inputM} min={1} max={500} onChange={setInputM} className="mt-3" />
                <p className="mt-2 font-data text-[12px] text-[var(--s-text-subtle)]">
                  prompts, context, documents
                </p>
              </div>
              <div>
                <div className="flex items-baseline justify-between">
                  <span className="mono-label">Output tokens</span>
                  <span className="font-data text-[16px] font-bold tabular-nums text-[var(--s-text)]">
                    {tokens(outputM * 1_000_000)}
                  </span>
                </div>
                <Slider value={outputM} min={1} max={200} onChange={setOutputM} className="mt-3" />
                <p className="mt-2 font-data text-[12px] text-[var(--s-text-subtle)]">
                  completions, reasoning, code
                </p>
              </div>
            </div>
          </Panel>

          {entry && quote && (
            <Panel title="Firm quote — both legs">
              <div className="px-4 py-4">
                <table className="w-full border-collapse font-data text-[14px]">
                  <thead>
                    <tr className="border-b border-[var(--s-divider)] text-left">
                      <th className="mono-label h-9 text-left">Leg</th>
                      <th className="mono-label h-9 text-right">Covered</th>
                      <th className="mono-label h-9 text-right">List</th>
                      <th className="mono-label h-9 text-right">Market</th>
                      <th className="mono-label h-9 text-right">Saving</th>
                    </tr>
                  </thead>
                  <tbody>
                    {quote.legs.map((leg) => (
                      <tr key={leg.kind} className="border-b border-[var(--s-divider)] last:border-0">
                        <td className="py-2.5 capitalize text-[var(--s-text-secondary)]">{leg.kind}</td>
                        <td className="py-2.5 text-right tabular-nums text-[var(--s-text-secondary)]">
                          {tokens(leg.covered)} / {tokens(leg.qty)}
                        </td>
                        <td className="py-2.5 text-right tabular-nums text-[var(--s-text-muted)] line-through decoration-[var(--s-text-subtle)]/60">
                          {compactUsd(leg.listCostMicro)}
                        </td>
                        <td className="py-2.5 text-right font-semibold tabular-nums text-[var(--s-text)]">
                          {compactUsd(leg.costMicro)}
                        </td>
                        <td className="py-2.5 text-right tabular-nums text-[var(--s-emerald)]">
                          {leg.listCostMicro > leg.costMicro
                            ? pct((leg.listCostMicro - leg.costMicro) / leg.listCostMicro, 1)
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-[10px] bg-[var(--s-emerald-soft)] px-4 py-3">
                  <div className="font-data text-[14px] text-[var(--s-emerald)]">
                    Monthly total {compactUsd(quote.costMicro)}{' '}
                    <span className="text-[var(--s-text-muted)] line-through">
                      {compactUsd(quote.listCostMicro)}
                    </span>
                  </div>
                  <div className="font-data text-[18px] font-bold tabular-nums text-[var(--s-emerald)]">
                    save {compactUsd(quote.savingsMicro)}
                    {quote.listCostMicro > 0 && ` · ${pct(quote.savingsMicro / quote.listCostMicro, 1)}`}
                  </div>
                </div>

                <div className="mt-4">
                  {!isConnected ? (
                    <ConnectKitButton.Custom>
                      {({ show }) => (
                        <button onClick={show} className="btn-primary h-12 w-full !text-[15px]">
                          <span className="i-ph:wallet text-[17px]" /> Connect to execute
                        </button>
                      )}
                    </ConnectKitButton.Custom>
                  ) : (
                    <button
                      onClick={execute}
                      disabled={busy || quote.legs.every((l) => l.covered === 0)}
                      className="btn-primary h-12 w-full !text-[15px]"
                    >
                      {busy
                        ? `${progress!.leg ? progress!.leg + ' leg — ' : ''}${STEP_LABEL[progress!.step]}…`
                        : `Execute firm · ${compactUsd(quote.costMicro)}`}
                    </button>
                  )}
                </div>
                {receipts.length > 0 && (
                  <div className="mt-3 rounded-[8px] border border-[var(--s-emerald)]/30 bg-[var(--s-emerald-soft)] px-3 py-2.5 font-data text-[13px] text-[var(--s-emerald)]">
                    Settled on Base Sepolia:{' '}
                    {receipts.map((r, i) => (
                      <span key={r.instrumentId}>
                        {i > 0 && ' · '}
                        {r.instrumentId.split(':')[1]} {compactUsd(r.costMicro)}
                        {r.settleTx && (
                          <>
                            {' '}
                            <a className="underline" href={`${CHAIN.explorer}/tx/${r.settleTx}`} target="_blank" rel="noreferrer">
                              tx ↗
                            </a>
                          </>
                        )}
                      </span>
                    ))}
                    {' '}Credit lots are in your portfolio.
                  </div>
                )}
                {error && (
                  <div className="mt-3 rounded-[8px] border border-[var(--s-crimson)]/30 bg-[var(--s-crimson-soft)] px-3 py-2.5 font-data text-[13px] text-[var(--s-crimson)]">
                    {error}
                  </div>
                )}
              </div>
            </Panel>
          )}
        </div>
      </div>
    </div>
  )
}
