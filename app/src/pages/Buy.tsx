import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { PageHeader } from '~/components/PageHeader'
import { Badge, Field, Mark, Panel, Segmented, Slider } from '~/components/ui'
import { cn } from '~/lib/cn'
import { pct, pricePerM, tokens as fmtTokens, usd } from '~/lib/format'
import { ALL_MODELS, getMarket, getOffers, LABS, VENUES } from '~/lib/mock'
import type { TokenKind } from '~/lib/types'

const QUOTE_TTL = 120

export default function BuyPage() {
  const params = useParams()
  const modelId = params['*'] || ''
  const navigate = useNavigate()
  const tradeable = useMemo(() => ALL_MODELS.filter((m) => m.list.output > 0), [])
  const [selModel, setSelModel] = useState(modelId || tradeable[0]!.id)
  const [kind, setKind] = useState<TokenKind>('output')
  const [logTokens, setLogTokens] = useState(Math.log10(25_000_000))
  const [route, setRoute] = useState<string>('auto') // 'auto' | offerId
  const [picker, setPicker] = useState(false)
  const [placed, setPlaced] = useState(false)

  const amount = Math.round(10 ** logTokens)
  const market = useMemo(() => getMarket(selModel, kind), [selModel, kind])
  const offers = useMemo(() => getOffers(selModel), [selModel])
  const model = market?.model

  const chosen = useMemo(() => {
    const eligible = offers.filter((o) => o.remainingTokens >= amount)
    const pool = eligible.length ? eligible : offers
    if (route !== 'auto') {
      const m = pool.find((o) => o.id === route)
      if (m) return m
    }
    return [...pool].sort((a, b) => a.price[kind] - b.price[kind])[0]
  }, [offers, route, amount, kind])

  // Firm-quote countdown — resets whenever the quote inputs change.
  const [secs, setSecs] = useState(QUOTE_TTL)
  const quoteKey = `${selModel}:${kind}:${amount}:${chosen?.id}`
  const lastKey = useRef(quoteKey)
  useEffect(() => {
    setSecs(QUOTE_TTL)
    lastKey.current = quoteKey
    setPlaced(false)
  }, [quoteKey])
  useEffect(() => {
    const t = setInterval(() => setSecs((s) => (s > 0 ? s - 1 : 0)), 1000)
    return () => clearInterval(t)
  }, [])

  if (!market || !model || !chosen) return null
  const lab = LABS[model.labId]!
  const venue = VENUES[chosen.venueId]!
  const price = chosen.price[kind]
  const listPrice = model.list[kind]
  const cost = (price * amount) / 1_000_000 / 1_000_000
  const listCost = (listPrice * amount) / 1_000_000 / 1_000_000
  const saving = listCost - cost

  return (
    <div>
      <PageHeader
        title="Buy inference"
        subtitle="Request a firm quote, hit it, and hold a redeemable credit lot. Price is locked the moment you buy — no slippage."
      />

      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
          {/* Config */}
          <div className="lg:col-span-3">
            <Panel>
              <div className="space-y-5 px-4 py-4 sm:px-5">
                {/* Model picker */}
                <Field label="Model">
                  <div className="relative">
                    <button
                      onClick={() => setPicker((v) => !v)}
                      className="flex h-12 w-full items-center justify-between rounded-[6px] border border-[var(--s-border)] bg-[var(--s-surface)] px-3 transition-colors hover:border-[var(--s-border-hover)]"
                    >
                      <span className="flex items-center gap-2.5">
                        <Mark hue={lab.hue} glyph={lab.glyph} label={lab.name} />
                        <span className="text-left">
                          <span className="block font-data text-[14px] font-semibold text-[var(--s-text)]">{model.name}</span>
                          <span className="block font-data text-[12px] text-[var(--s-text-muted)]">{lab.name}</span>
                        </span>
                      </span>
                      <span className={cn('i-ph:caret-down text-[16px] text-[var(--s-text-muted)] transition-transform', picker && 'rotate-180')} />
                    </button>
                    {picker && (
                      <div className="absolute z-20 mt-1.5 max-h-[320px] w-full overflow-y-auto rounded-[6px] border border-[var(--s-border)] bg-[var(--s-surface)] py-1 shadow-[var(--s-shadow-pop)]">
                        {tradeable.map((m) => {
                          const l = LABS[m.labId]!
                          return (
                            <button
                              key={m.id}
                              onClick={() => {
                                setSelModel(m.id)
                                setRoute('auto')
                                setPicker(false)
                              }}
                              className={cn(
                                'flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-[var(--s-panel)]',
                                m.id === selModel && 'bg-[var(--s-panel)]',
                              )}
                            >
                              <Mark hue={l.hue} glyph={l.glyph} label={l.name} size={24} />
                              <span className="flex-1 font-data text-[14px] text-[var(--s-text)]">{m.name}</span>
                              <span className="font-data text-[12px] text-[var(--s-text-muted)]">{pricePerM(m.list.output)}</span>
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </Field>

                {/* Token kind */}
                <Field label="Token kind">
                  <Segmented
                    value={kind}
                    onChange={setKind}
                    options={[
                      { value: 'output', label: 'Output' },
                      { value: 'input', label: 'Input' },
                      { value: 'cache', label: 'Cache' },
                    ]}
                  />
                </Field>

                {/* Amount */}
                <Field label="Amount" hint={<>≈ {fmtTokens(amount)} tokens</>}>
                  <div className="mb-3 flex items-center gap-2">
                    <div className="flex h-11 flex-1 items-center rounded-[6px] border border-[var(--s-border)] bg-[var(--s-surface)] px-3">
                      <input
                        value={amount}
                        onChange={(e) => {
                          const v = Number(e.target.value.replace(/[^0-9]/g, ''))
                          if (v > 0) setLogTokens(Math.log10(Math.min(5_000_000_000, Math.max(1_000_000, v))))
                        }}
                        className="w-full bg-transparent font-data text-[15px] tabular-nums text-[var(--s-text)] outline-none"
                      />
                      <span className="font-data text-[13px] text-[var(--s-text-muted)]">tokens</span>
                    </div>
                  </div>
                  <Slider value={logTokens} min={Math.log10(1_000_000)} max={Math.log10(5_000_000_000)} step={0.01} onChange={setLogTokens} />
                  <div className="mt-1.5 flex justify-between font-data text-[11px] text-[var(--s-text-subtle)]">
                    <span>1M</span>
                    <span>100M</span>
                    <span>1B</span>
                    <span>5B</span>
                  </div>
                </Field>

                {/* Route */}
                <Field label="Fulfillment" hint="best price auto-routes across venues">
                  <div className="space-y-1.5">
                    <RouteOption
                      active={route === 'auto'}
                      onClick={() => setRoute('auto')}
                      left={
                        <span className="flex items-center gap-2">
                          <span className="i-ph:lightning-fill text-[15px] text-[var(--s-accent)]" />
                          <span className="font-data text-[14px] font-semibold text-[var(--s-text)]">Best price (auto-route)</span>
                        </span>
                      }
                      right={<span className="font-data text-[13px] tabular-nums text-[var(--s-accent)]">{pricePerM(chosen.price[kind])}</span>}
                    />
                    {offers
                      .filter((o) => o.remainingTokens >= amount)
                      .slice(0, 3)
                      .map((o) => {
                        const v = VENUES[o.venueId]!
                        return (
                          <RouteOption
                            key={o.id}
                            active={route === o.id}
                            onClick={() => setRoute(o.id)}
                            left={
                              <span className="flex items-center gap-2">
                                <span className="h-2 w-2 rounded-full" style={{ background: v.hue }} />
                                <span className="font-data text-[13px] text-[var(--s-text-secondary)]">
                                  {v.name} · {o.sellerLabel}
                                </span>
                                {o.verified && <span className="i-ph:seal-check text-[13px] text-[var(--s-accent)]" />}
                              </span>
                            }
                            right={<span className="font-data text-[13px] tabular-nums text-[var(--s-text-secondary)]">{pricePerM(o.price[kind])}</span>}
                          />
                        )
                      })}
                  </div>
                </Field>
              </div>
            </Panel>
          </div>

          {/* Firm quote ticket */}
          <div className="lg:col-span-2">
            <div className="panel sticky top-4 overflow-hidden">
              <div className="flex items-center justify-between border-b border-[var(--s-divider)] px-4 py-2.5">
                <span className="mono-label !text-[var(--s-text-secondary)]">Firm quote</span>
                {!placed && (
                  <span className={cn('font-data text-[12px] tabular-nums', secs <= 15 ? 'text-[var(--s-crimson)]' : 'text-[var(--s-text-muted)]')}>
                    <span className="i-ph:clock mr-1 inline-block translate-y-px text-[13px]" />
                    valid {secs}s
                  </span>
                )}
              </div>

              {placed ? (
                <QuoteFilled
                  amount={amount}
                  modelName={model.name}
                  cost={cost}
                  onView={() => navigate('/portfolio')}
                  onAgain={() => setPlaced(false)}
                />
              ) : (
                <div className="px-4 py-4">
                  <div className="flex items-center gap-2.5">
                    <Mark hue={lab.hue} glyph={lab.glyph} label={lab.name} />
                    <div className="min-w-0">
                      <div className="truncate font-data text-[14px] font-semibold text-[var(--s-text)]">{model.name}</div>
                      <div className="font-data text-[12px] text-[var(--s-text-muted)]">
                        {fmtTokens(amount)} {kind} tokens
                      </div>
                    </div>
                  </div>

                  <dl className="mt-4 space-y-2 font-data text-[14px]">
                    <Line label="Price / 1M" value={pricePerM(price)} />
                    <Line label="List price / 1M" value={<span className="text-[var(--s-text-muted)] line-through">{pricePerM(listPrice)}</span>} />
                    <Line label="Discount" value={<span className="text-[var(--s-emerald)]">{pct(chosen.discount, 1)}</span>} />
                    <Line label="Fulfilled by" value={<span className="text-[var(--s-text-secondary)]">{venue.name}</span>} />
                  </dl>

                  <div className="my-4 border-t border-dashed border-[var(--s-border)]" />

                  <div className="flex items-end justify-between">
                    <div>
                      <div className="mono-label">Total</div>
                      <div className="font-data text-[26px] font-bold tabular-nums text-[var(--s-text)]">{usd(cost, cost >= 100 ? 2 : 4)}</div>
                    </div>
                    <div className="text-right">
                      <div className="mono-label">vs list</div>
                      <Badge tone="emerald" className="mt-1">
                        save {usd(saving, saving >= 100 ? 0 : 2)}
                      </Badge>
                    </div>
                  </div>

                  <button onClick={() => setPlaced(true)} disabled={secs === 0} className="btn-primary mt-4 h-12 w-full !text-[14px]">
                    {secs === 0 ? 'Quote expired — refresh' : 'Confirm purchase'}
                  </button>
                  {secs === 0 && (
                    <button onClick={() => setSecs(QUOTE_TTL)} className="btn-secondary mt-2 h-9 w-full !text-[13px]">
                      Re-quote
                    </button>
                  )}

                  <div className="mt-3 flex items-start gap-2 rounded-[6px] bg-[var(--s-accent-soft)] px-3 py-2.5">
                    <span className="i-ph:shield-check-fill mt-px shrink-0 text-[15px] text-[var(--s-accent)]" />
                    <p className="font-body text-[12px] leading-snug text-[var(--s-text-secondary)]">
                      Backed by operator collateral. Unserved spend is refunded in full <span className="text-[var(--s-accent)]">+ penalty</span>.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function Line({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-[var(--s-text-muted)]">{label}</dt>
      <dd className="tabular-nums font-semibold text-[var(--s-text)]">{value}</dd>
    </div>
  )
}

function RouteOption({
  active,
  onClick,
  left,
  right,
}: {
  active: boolean
  onClick: () => void
  left: React.ReactNode
  right: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex w-full items-center justify-between rounded-[6px] border px-3 py-2.5 transition-colors',
        active ? 'border-[var(--s-accent)] bg-[var(--s-accent-soft)]' : 'border-[var(--s-border)] hover:border-[var(--s-border-hover)]',
      )}
    >
      {left}
      <span className="flex items-center gap-2">
        {right}
        <span
          className={cn(
            'flex h-4 w-4 items-center justify-center rounded-full border',
            active ? 'border-[var(--s-accent)] bg-[var(--s-accent)]' : 'border-[var(--s-border)]',
          )}
        >
          {active && <span className="i-ph:check text-[11px] text-[var(--s-accent-text)]" />}
        </span>
      </span>
    </button>
  )
}

function QuoteFilled({
  amount,
  modelName,
  cost,
  onView,
  onAgain,
}: {
  amount: number
  modelName: string
  cost: number
  onView: () => void
  onAgain: () => void
}) {
  return (
    <div className="s-fade-up px-4 py-6 text-center">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-[var(--s-accent-soft)]">
        <span className="i-ph:check-circle-fill text-[34px] text-[var(--s-accent)]" />
      </div>
      <h3 className="mt-3 font-display text-[17px] font-bold text-[var(--s-text)]">Credit lot minted</h3>
      <p className="mt-1 font-body text-[13px] text-[var(--s-text-muted)]">
        {fmtTokens(amount)} tokens of {modelName} for {usd(cost, cost >= 100 ? 2 : 4)}. Redeemable through the router.
      </p>
      <button onClick={onView} className="btn-primary mt-4 h-10 w-full !text-[14px]">
        View in portfolio
      </button>
      <button onClick={onAgain} className="btn-secondary mt-2 h-9 w-full !text-[13px]">
        Buy more
      </button>
    </div>
  )
}
