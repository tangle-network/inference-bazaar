import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAccount } from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import { PageHeader } from '~/components/PageHeader'
import { Panel, Slider } from '~/components/ui'
import { ProviderLogo } from '~/lib/logos'
import { cn } from '~/lib/cn'
import { compactUsd, pricePerM, tokens } from '~/lib/format'
import { CHAIN, useCatalog, useInstruments } from '~/lib/api'
import { useMyLots, type CreditLot } from '~/lib/settlement'
import { instrumentHash } from '~/lib/settlement'
import { STEP_LABEL, useFirmTrade, type TradeProgress, type TradeReceipt } from '~/lib/trade'
import { useAggBook, useVenueRegistry } from '~/lib/venues'

/**
 * Selling is transferring something you provably hold: a credit lot on
 * SurplusSettlement. The operator bids firm; your signed sell order moves the
 * lot and pays your settlement balance, atomically on-chain. Fresh issuance
 * (selling capacity you serve) is the operator path — it requires posted
 * collateral.
 */
export default function SellPage() {
  const { address, isConnected } = useAccount()
  const catalog = useCatalog()
  const instruments = useInstruments()
  const lots = useMyLots(address)
  const { sellLot } = useFirmTrade()
  const registry = useVenueRegistry()

  // Resolve each held lot back to its live instrument by hash.
  const sellable = useMemo(() => {
    if (!lots.data || !instruments.data) return []
    const byHash = new Map(instruments.data.map((i) => [instrumentHash(i.id), i]))
    return lots.data
      .map((lot) => ({ lot, instrument: byHash.get(lot.instrument) ?? null }))
      .filter((x) => x.instrument !== null && x.lot.qtyTokens > 0n)
  }, [lots.data, instruments.data])

  const [selected, setSelected] = useState<CreditLot | null>(null)
  // Quantity to resell (tokens). null = the whole lot; the slider sets a partial.
  const [sellQty, setSellQty] = useState<number | null>(null)
  const active = selected ?? sellable[0]?.lot ?? null
  const activeInstrument = sellable.find((s) => s.lot.lotId === active?.lotId)?.instrument ?? null
  const book = useAggBook(registry.data, activeInstrument?.id ?? null)
  const bestBid = book.data?.bids[0]?.price ?? null

  const lotQty = Number(active?.qtyTokens ?? 0)
  const qty = Math.min(sellQty ?? lotQty, lotQty) // default: whole lot; clamp to available
  const isPartial = qty > 0 && qty < lotQty

  const [progress, setProgress] = useState<TradeProgress | null>(null)
  const [receipt, setReceipt] = useState<TradeReceipt | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function execute() {
    if (!active || !activeInstrument) return
    setError(null)
    setReceipt(null)
    try {
      const r = await sellLot(
        activeInstrument.id,
        active.lotId,
        qty,
        setProgress,
        registry.data ?? [],
      )
      setReceipt(r)
      void lots.refetch()
    } catch (e) {
      setError(e instanceof Error ? e.message.split('\n')[0]! : String(e))
    } finally {
      setProgress(null)
    }
  }

  if (!isConnected) {
    return (
      <div>
        <PageHeader title="Sell" subtitle="Sell credit lots you hold back to the market, firm." />
        <div className="flex flex-col items-center gap-4 px-6 py-20 text-center">
          <span className="i-ph:storefront text-[44px] text-[var(--s-text-subtle)]" />
          <p className="max-w-sm font-body text-[15px] text-[var(--s-text-muted)]">
            Connect to see the credit lots you hold on the settlement contract.
          </p>
          <ConnectKitButton.Custom>
            {({ show }) => (
              <button onClick={show} className="btn-primary h-11">
                <span className="i-ph:wallet text-[18px]" /> Connect wallet
              </button>
            )}
          </ConnectKitButton.Custom>
        </div>
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="Sell"
        subtitle="Sell credit lots you hold back to the market. Transfers settle atomically on-chain."
        right={
          <Link to="/operators/register" className="btn-secondary h-10">
            Issue as operator
          </Link>
        }
      />

      <div className="grid grid-cols-1 gap-4 px-4 py-4 sm:px-6 lg:grid-cols-12">
        <Panel title="Your credit lots" className="lg:col-span-5" bodyClassName="max-h-[560px] overflow-y-auto">
          {lots.isLoading && (
            <div className="px-4 py-10 text-center font-data text-[15px] text-[var(--s-text-muted)]">
              Reading your lots from Base Sepolia…
            </div>
          )}
          {lots.isSuccess && sellable.length === 0 && (
            <div className="px-4 py-10 text-center">
              <p className="font-data text-[15px] text-[var(--s-text-muted)]">
                No credit lots in this wallet. Buy a market to hold transferable, on-chain credits —
                they appear here the moment settlement lands.
              </p>
              <Link to="/buy" className="btn-primary mt-4 h-10 inline-flex">
                Buy inference
              </Link>
            </div>
          )}
          {sellable.map(({ lot, instrument }) => {
            const model = catalog.data?.get(instrument!.model_id)
            const isActive = active?.lotId === lot.lotId
            return (
              <button
                key={lot.lotId}
                onClick={() => {
                  setSelected(lot)
                  setSellQty(Number(lot.qtyTokens)) // reset the slider to the full new lot
                }}
                className={cn(
                  'flex w-full items-center gap-3 border-b border-[var(--s-divider)] px-4 py-3.5 text-left transition-colors last:border-0',
                  isActive ? 'bg-[var(--s-accent-soft)]' : 'hover:bg-[var(--s-panel)]',
                )}
              >
                {model && <ProviderLogo provider={model.provider} size={30} />}
                <div className="min-w-0 flex-1">
                  <div className="truncate font-body text-[15px] font-semibold text-[var(--s-text)]">
                    {model?.name ?? instrument!.model_id} · {instrument!.token_kind}
                  </div>
                  <div className="font-data text-[15px] text-[var(--s-text-muted)]">
                    {tokens(Number(lot.qtyTokens))} tokens · paid {compactUsd(Number(lot.notionalMicro))}
                  </div>
                </div>
                {isActive && <span className="i-ph:check text-[18px] text-[var(--s-accent)]" />}
              </button>
            )
          })}
        </Panel>

        <div className="lg:col-span-7">
          {active && activeInstrument && (
            <Panel title="Firm sale">
              <div className="grid grid-cols-2 gap-x-6 gap-y-3 px-4 py-4 font-data text-[15px] sm:grid-cols-3">
                <PV k="Selling" v={`${tokens(qty)} tok`} />
                <PV k="Operator bid" v={bestBid != null ? pricePerM(bestBid) : '—'} tone="emerald" />
                <PV
                  k="Est. proceeds"
                  v={bestBid != null ? compactUsd(Math.round((bestBid * qty) / 1e6)) : '—'}
                />
              </div>
              {/* Partial resale: carve off any amount up to the lot size — the rest
                  stays a redeemable lot you keep. */}
              <div className="px-4 pb-2">
                <div className="flex items-baseline justify-between">
                  <span className="mono-label">Amount</span>
                  <span className="font-data text-[15px] text-[var(--s-text-muted)]">
                    {tokens(qty)} of {tokens(lotQty)}
                    {isPartial && <span className="text-[var(--s-accent)]"> · keep {tokens(lotQty - qty)}</span>}
                  </span>
                </div>
                <Slider
                  value={qty}
                  min={1}
                  max={Math.max(1, lotQty)}
                  step={Math.max(1, Math.floor(lotQty / 200))}
                  onChange={setSellQty}
                  className="mt-3"
                />
              </div>
              <div className="px-4 pb-4">
                <button
                  onClick={execute}
                  disabled={progress !== null || bestBid == null || qty < 1}
                  className="btn-primary h-12 w-full !text-[15px]"
                >
                  {progress
                    ? `${STEP_LABEL[progress.step]}…`
                    : isPartial
                      ? `Request firm bid · sell ${tokens(qty)}`
                      : 'Request firm bid · sell lot'}
                </button>
                {receipt && (
                  <div className="mt-3 rounded-[8px] border border-[var(--s-emerald)]/30 bg-[var(--s-emerald-soft)] px-3 py-2.5 font-data text-[15px] text-[var(--s-emerald)]">
                    Sold {tokens(receipt.qtyTokens)} at {pricePerM(receipt.priceMicroPerM)} ·{' '}
                    {compactUsd(receipt.costMicro)} credited to your settlement balance.
                    {receipt.settleTx && (
                      <>
                        {' '}
                        <a className="underline" href={`${CHAIN.explorer}/tx/${receipt.settleTx}`} target="_blank" rel="noreferrer">
                          Settlement transaction ↗
                        </a>
                      </>
                    )}
                  </div>
                )}
                {error && (
                  <div className="mt-3 rounded-[8px] border border-[var(--s-crimson)]/30 bg-[var(--s-crimson-soft)] px-3 py-2.5 font-data text-[15px] text-[var(--s-crimson)]">
                    {error}
                  </div>
                )}
                <p className="mt-4 font-body text-[15px] leading-relaxed text-[var(--s-text-subtle)]">
                  The operator's bid is an EIP-712 signed order. Your signed sell pairs with it and
                  settleFills transfers the lot and pays you in one transaction.
                </p>
              </div>
            </Panel>
          )}
        </div>
      </div>
    </div>
  )
}

function PV({ k, v, tone }: { k: string; v: string; tone?: 'emerald' }) {
  return (
    <div>
      <div className="mono-label">{k}</div>
      <div className="mt-1 text-[18px] font-bold tabular-nums" style={{ color: tone ? 'var(--s-emerald)' : 'var(--s-text)' }}>
        {v}
      </div>
    </div>
  )
}
