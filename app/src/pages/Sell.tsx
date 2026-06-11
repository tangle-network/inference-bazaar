import { useMemo, useState } from 'react'
import { useAccount } from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import { PageHeader } from '~/components/PageHeader'
import { Panel, Slider } from '~/components/ui'
import { ProviderLogo } from '~/lib/logos'
import { cn } from '~/lib/cn'
import { compactUsd, pct, pricePerM, tokens } from '~/lib/format'
import { placeOrder, useBook, useCatalog, useInstruments } from '~/lib/api'

/**
 * Selling = placing a real ask on the live book, under your wallet address,
 * at your discount to the router list price. It rests until a buyer crosses.
 */
export default function SellPage() {
  const catalog = useCatalog()
  const instruments = useInstruments()
  const { address, isConnected } = useAccount()

  const live = useMemo(() => {
    if (!instruments.data || !catalog.data) return []
    return instruments.data
      .map((i) => ({ instrument: i, model: catalog.data!.get(i.model_id)! }))
      .filter((x) => !!x.model)
      .sort((a, b) => a.instrument.id.localeCompare(b.instrument.id))
  }, [instruments.data, catalog.data])

  const [instrumentId, setInstrumentId] = useState<string | null>(null)
  const selected = live.find((l) => l.instrument.id === instrumentId) ?? live[0] ?? null
  const activeId = selected?.instrument.id ?? null

  const [qtyM, setQtyM] = useState(10)
  const [discountPct, setDiscountPct] = useState(15)

  const book = useBook(activeId)
  const list = selected
    ? selected.instrument.token_kind === 'output'
      ? selected.model.outputMicroPerM
      : selected.model.inputMicroPerM
    : 0
  const tick = selected?.instrument.tick_size ?? 1000
  const askPrice = Math.max(tick, Math.round((list * (1 - discountPct / 100)) / tick) * tick)
  const qtyTokens = qtyM * 1_000_000
  const notional = Math.round((askPrice * qtyTokens) / 1e6)
  const bestAsk = book.data?.book.asks[0]?.price ?? null

  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function listSupply() {
    if (!address || !activeId) return
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      await placeOrder({
        instrumentId: activeId,
        side: 'sell',
        price: askPrice,
        qtyTokens,
        owner: address,
      })
      setDone('Your ask is resting on the live book.')
      void book.refetch()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <PageHeader
        title="Sell surplus"
        subtitle="List unused inference on the live book at your discount. Fills settle through the collateral-backed spine."
      />

      <div className="grid grid-cols-1 gap-4 px-4 py-4 sm:px-6 lg:grid-cols-12">
        <Panel title="Market" className="lg:col-span-4" bodyClassName="max-h-[560px] overflow-y-auto">
          {live.length === 0 && (
            <div className="px-4 py-10 text-center font-data text-[13px] text-[var(--s-text-muted)]">
              {instruments.isError ? 'Venue offline.' : 'Loading live markets…'}
            </div>
          )}
          {live.map(({ instrument, model }) => (
            <button
              key={instrument.id}
              onClick={() => setInstrumentId(instrument.id)}
              className={cn(
                'flex w-full items-center gap-3 border-b border-[var(--s-divider)] px-4 py-3 text-left transition-colors last:border-0',
                instrument.id === activeId ? 'bg-[var(--s-accent-soft)]' : 'hover:bg-[var(--s-panel)]',
              )}
            >
              <ProviderLogo provider={model.provider} size={28} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-body text-[14px] font-semibold text-[var(--s-text)]">
                  {model.name}
                </div>
                <div className="font-data text-[12px] uppercase text-[var(--s-text-muted)]">
                  {instrument.token_kind}
                </div>
              </div>
              {instrument.id === activeId && <span className="i-ph:check text-[16px] text-[var(--s-accent)]" />}
            </button>
          ))}
        </Panel>

        <div className="flex flex-col gap-4 lg:col-span-8">
          <Panel title="Your ask">
            <div className="grid gap-6 px-4 py-5 sm:grid-cols-2">
              <div>
                <div className="flex items-baseline justify-between">
                  <span className="mono-label">Quantity</span>
                  <span className="font-data text-[16px] font-bold tabular-nums text-[var(--s-text)]">
                    {tokens(qtyTokens)}
                  </span>
                </div>
                <Slider value={qtyM} min={1} max={200} onChange={setQtyM} className="mt-3" />
              </div>
              <div>
                <div className="flex items-baseline justify-between">
                  <span className="mono-label">Discount to list</span>
                  <span className="font-data text-[16px] font-bold tabular-nums text-[var(--s-emerald)]">
                    {discountPct}%
                  </span>
                </div>
                <Slider value={discountPct} min={1} max={60} onChange={setDiscountPct} className="mt-3" />
              </div>
            </div>
          </Panel>

          {selected && (
            <Panel title="Listing preview — against the live book">
              <div className="grid grid-cols-2 gap-x-6 gap-y-3 px-4 py-4 font-data text-[14px] sm:grid-cols-4">
                <PV k="Router list" v={pricePerM(list)} muted />
                <PV k="Your ask" v={pricePerM(askPrice)} tone="emerald" />
                <PV k="Current best ask" v={bestAsk != null ? pricePerM(bestAsk) : '—'} />
                <PV k="Notional" v={compactUsd(notional)} />
              </div>
              {bestAsk != null && askPrice >= bestAsk && (
                <div className="mx-4 mb-3 rounded-[8px] bg-[var(--s-amber-soft)] px-3 py-2 font-data text-[12px] text-[var(--s-amber)]">
                  Priced behind the current best ask — you'll queue at {pct(1 - askPrice / list, 1)} off
                  list until deeper levels fill.
                </div>
              )}
              <div className="px-4 pb-4">
                {!isConnected ? (
                  <ConnectKitButton.Custom>
                    {({ show }) => (
                      <button onClick={show} className="btn-primary h-12 w-full !text-[15px]">
                        <span className="i-ph:wallet text-[17px]" /> Connect to list
                      </button>
                    )}
                  </ConnectKitButton.Custom>
                ) : (
                  <button onClick={listSupply} disabled={busy} className="btn-primary h-12 w-full !text-[15px]">
                    {busy ? 'Placing…' : `List ${tokens(qtyTokens)} at ${pricePerM(askPrice)}`}
                  </button>
                )}
                {done && (
                  <div className="mt-3 rounded-[8px] border border-[var(--s-emerald)]/30 bg-[var(--s-emerald-soft)] px-3 py-2.5 font-data text-[13px] text-[var(--s-emerald)]">
                    {done}
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

function PV({ k, v, tone, muted }: { k: string; v: string; tone?: 'emerald'; muted?: boolean }) {
  return (
    <div>
      <div className="mono-label">{k}</div>
      <div
        className={cn(
          'mt-1 text-[17px] font-bold tabular-nums',
          muted && 'line-through decoration-[var(--s-text-subtle)]/50',
        )}
        style={{ color: tone ? 'var(--s-emerald)' : muted ? 'var(--s-text-muted)' : 'var(--s-text)' }}
      >
        {v}
      </div>
    </div>
  )
}
