import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PageHeader } from '~/components/PageHeader'
import { Badge, Field, Mark, Segmented, Slider } from '~/components/ui'
import { cn } from '~/lib/cn'
import { compactUsd, pct, pricePerM, tokens as fmtTokens, usd } from '~/lib/format'
import { ALL_MODELS, LABS, VENUES } from '~/lib/mock'
import type { TokenKind } from '~/lib/types'

type Backing = 'connect' | 'collateral'

export default function SellPage() {
  const navigate = useNavigate()
  const venueList = Object.values(VENUES).filter((v) => v.id !== 'tangle')
  const [venue, setVenue] = useState<string | null>(null)
  const [model, setModel] = useState<string | null>(null)
  const [kind, setKind] = useState<TokenKind>('output')
  const [logTokens, setLogTokens] = useState(Math.log10(20_000_000))
  const [discount, setDiscount] = useState(0.18)
  const [backing, setBacking] = useState<Backing>('connect')
  const [apiKey, setApiKey] = useState('')
  const [listed, setListed] = useState(false)

  const amount = Math.round(10 ** logTokens)
  const selectedModel = useMemo(() => ALL_MODELS.find((m) => m.id === model), [model])
  const lab = selectedModel ? LABS[selectedModel.labId] : null
  const venueObj = venue ? VENUES[venue] : null

  // Models available through the chosen venue (reuse mock venue mapping heuristic).
  const venueModels = useMemo(() => {
    if (!venue) return []
    return ALL_MODELS.filter((m) => {
      if (m.list.output <= 0 && kind !== 'output') return false
      if (venue === 'venice') return ['openai', 'meta', 'deepseek'].includes(m.labId)
      if (venue === 'anthropic') return m.labId === 'anthropic'
      if (venue === 'openai') return m.labId === 'openai'
      if (venue === 'google') return m.labId === 'google'
      if (venue === 'fireworks' || venue === 'together') return ['meta', 'deepseek', 'mistral'].includes(m.labId)
      return true // openrouter — everything
    })
  }, [venue, kind])

  const listPrice = selectedModel ? selectedModel.list[kind] : 0
  const effectivePrice = Math.round(listPrice * (1 - discount))
  const grossTake = (effectivePrice * amount) / 1_000_000 / 1_000_000
  const platformFee = grossTake * 0.02
  const netTake = grossTake - platformFee
  const collateralReq = grossTake * 1.05 // refund value + 5% penalty

  const ready = venue && model && (backing === 'collateral' || apiKey.length > 8)

  if (listed && selectedModel && lab && venueObj) {
    return (
      <ListedSuccess
        modelName={selectedModel.name}
        labHue={lab.hue}
        glyph={lab.glyph}
        venueName={venueObj.name}
        amount={amount}
        discount={discount}
        net={netTake}
        onView={() => navigate('/portfolio')}
        onAgain={() => setListed(false)}
      />
    )
  }

  return (
    <div>
      <PageHeader
        title="Sell surplus inference"
        subtitle="List prepaid credits you won't use — idle capacity or an over-bought pack. Set your discount, back the supply, and your offer hits the book."
      />

      <div className="mx-auto max-w-xl px-4 py-6 sm:px-6">
       <div className="panel px-5 py-5 sm:px-6 sm:py-6">
        {/* 1. Source venue */}
        <Section label="Where's your supply" done={!!venue}>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {venueList.map((v) => {
              const active = venue === v.id
              return (
                <button
                  key={v.id}
                  onClick={() => {
                    setVenue(v.id)
                    setModel(null)
                  }}
                  className={cn(
                    'flex flex-col items-center gap-2 rounded-[8px] border px-2 py-3 transition-colors',
                    active ? 'border-[var(--s-accent)] bg-[var(--s-accent-soft)]' : 'border-[var(--s-border)] hover:border-[var(--s-border-hover)]',
                  )}
                >
                  <Mark hue={v.hue} label={v.name} size={30} />
                  <span className="text-center font-data text-[11px] font-medium leading-tight text-[var(--s-text-secondary)]">{v.name}</span>
                </button>
              )
            })}
          </div>
        </Section>

        {/* 2. Model */}
        {venue && (
          <Section label="Which model" done={!!model}>
            <div className="max-h-[230px] space-y-1 overflow-y-auto pr-1">
              {venueModels.map((m) => {
                const l = LABS[m.labId]!
                const active = model === m.id
                return (
                  <button
                    key={m.id}
                    onClick={() => setModel(m.id)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-[6px] border px-3 py-2 text-left transition-colors',
                      active ? 'border-[var(--s-accent)] bg-[var(--s-accent-soft)]' : 'border-[var(--s-border)] hover:border-[var(--s-border-hover)]',
                    )}
                  >
                    <Mark hue={l.hue} glyph={l.glyph} label={l.name} size={26} />
                    <span className="flex-1">
                      <span className="block font-data text-[13px] font-semibold text-[var(--s-text)]">{m.name}</span>
                      <span className="block font-data text-[11px] text-[var(--s-text-muted)]">{l.name}</span>
                    </span>
                    <span className="font-data text-[12px] tabular-nums text-[var(--s-text-muted)]">{pricePerM(m.list[kind])}</span>
                  </button>
                )
              })}
            </div>
          </Section>
        )}

        {/* 3. Amount + price */}
        {model && selectedModel && (
          <Section label="Amount & price" done>
            <div className="space-y-5">
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

              <Field label="Tokens to sell" hint={<>≈ {fmtTokens(amount)}</>}>
                <Slider value={logTokens} min={Math.log10(1_000_000)} max={Math.log10(500_000_000)} step={0.01} onChange={setLogTokens} />
                <div className="mt-1.5 flex justify-between font-data text-[10px] text-[var(--s-text-subtle)]">
                  <span>1M</span>
                  <span>50M</span>
                  <span>500M</span>
                </div>
              </Field>

              <Field label="Your discount to list" hint={<span className="text-[var(--s-emerald)]">{pct(discount, 0)} off</span>}>
                <Slider value={discount} min={0.03} max={0.45} step={0.005} onChange={setDiscount} />
                <div className="mt-2 flex items-center justify-between rounded-[6px] border border-[var(--s-divider)] px-3 py-2 font-data text-[12px]">
                  <span className="text-[var(--s-text-muted)]">
                    Effective price <span className="font-semibold text-[var(--s-text)]">{pricePerM(effectivePrice)}</span>
                    <span className="text-[var(--s-text-subtle)]"> / 1M</span>
                  </span>
                  <span className="text-[var(--s-text-muted)]">
                    You net <span className="font-semibold text-[var(--s-emerald)]">{usd(netTake, netTake >= 100 ? 0 : 2)}</span>
                  </span>
                </div>
              </Field>
            </div>
          </Section>
        )}

        {/* 4. Back the supply */}
        {model && (
          <Section label="Back the supply" done={!!ready}>
            <Segmented
              value={backing}
              onChange={setBacking}
              options={[
                { value: 'connect', label: 'Connect source' },
                { value: 'collateral', label: 'Post collateral' },
              ]}
            />
            {backing === 'connect' ? (
              <div className="mt-3">
                <Field label={`${venueObj?.name ?? 'Venue'} API key`} hint="fulfills redemptions through your account">
                  <div className="flex h-11 items-center rounded-[6px] border border-[var(--s-border)] bg-[var(--s-surface)] px-3">
                    <span className="i-ph:key mr-2 text-[15px] text-[var(--s-text-muted)]" />
                    <input
                      type="password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder="sk-or-v1-…"
                      className="w-full bg-transparent font-data text-[13px] text-[var(--s-text)] outline-none placeholder:text-[var(--s-text-subtle)]"
                    />
                    {apiKey.length > 8 && <span className="i-ph:check-circle-fill text-[16px] text-[var(--s-emerald)]" />}
                  </div>
                </Field>
                <p className="mt-2 flex items-start gap-1.5 font-body text-[11px] leading-snug text-[var(--s-text-muted)]">
                  <span className="i-ph:lock-simple mt-px text-[13px]" />
                  Encrypted client-side and held by the fulfilling operator only for redemptions you sell. Revocable anytime.
                </p>
              </div>
            ) : (
              <div className="mt-3 rounded-[6px] border border-[var(--s-divider)] px-3.5 py-3">
                <div className="flex items-center justify-between">
                  <span className="font-data text-[12px] text-[var(--s-text-muted)]">Required collateral</span>
                  <span className="font-data text-[15px] font-bold tabular-nums text-[var(--s-text)]">{usd(collateralReq, 2)}</span>
                </div>
                <p className="mt-1.5 font-body text-[11px] leading-snug text-[var(--s-text-muted)]">
                  Covers the lot's full refund value plus the {pct(0.05, 0)} default penalty. Returned as buyers redeem; the trustless path needs no API key.
                </p>
              </div>
            )}
          </Section>
        )}

        {/* Live listing preview — always visible, fills in as you choose */}
        <div className="mt-1 overflow-hidden rounded-[6px] border border-[var(--s-divider)] bg-[var(--s-surface)]">
          <div className="border-b border-[var(--s-divider)] px-4 py-2">
            <span className="mono-label">What buyers will see</span>
          </div>
          {selectedModel && lab ? (
            <div className="flex items-center gap-3 px-4 py-3">
              <Mark hue={lab.hue} glyph={lab.glyph} label={lab.name} />
              <div className="min-w-0 flex-1">
                <div className="font-data text-[13px] font-semibold text-[var(--s-text)]">{selectedModel.name}</div>
                <div className="font-data text-[11px] text-[var(--s-text-muted)]">
                  {venueObj?.name} · {fmtTokens(amount)} {kind} · {compactUsd(grossTake * 1_000_000)} offered
                </div>
              </div>
              <div className="text-right">
                <Badge tone="emerald">{pct(discount, 0)} off</Badge>
                <div className="mt-1 font-data text-[13px] font-bold tabular-nums text-[var(--s-accent)]">{pricePerM(effectivePrice)}</div>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3 px-4 py-3 opacity-50">
              <div className="h-7 w-7 rounded-[6px] border border-dashed border-[var(--s-border)]" />
              <div className="flex-1">
                <div className="font-data text-[13px] text-[var(--s-text-muted)]">Your offer preview</div>
                <div className="font-data text-[11px] text-[var(--s-text-subtle)]">pick a venue and model to start</div>
              </div>
              <span className="font-data text-[13px] text-[var(--s-text-subtle)]">— /1M</span>
            </div>
          )}
        </div>

        <button onClick={() => setListed(true)} disabled={!ready} className="btn-primary mt-4 h-12 w-full !text-[14px]">
          {ready ? 'Sign & list offer' : 'Complete the steps above'}
        </button>
        <p className="mt-2 text-center font-body text-[11px] text-[var(--s-text-muted)]">
          Listing signs an EIP-712 order — no gas until a buyer fills it.
        </p>
       </div>
      </div>
    </div>
  )
}

function Section({ label, done, children }: { label: string; done?: boolean; children: React.ReactNode }) {
  return (
    <div className="s-fade-up mb-5">
      <div className="mb-2.5 flex items-center gap-2">
        <span
          className={cn(
            'flex h-4 w-4 items-center justify-center rounded-full border',
            done ? 'border-[var(--s-accent)] bg-[var(--s-accent)]' : 'border-[var(--s-border)]',
          )}
        >
          {done && <span className="i-ph:check text-[10px] text-[var(--s-accent-text)]" />}
        </span>
        <span className="mono-label !text-[var(--s-text-secondary)] !text-[11px]">{label}</span>
      </div>
      <div className="pl-6">{children}</div>
    </div>
  )
}

function ListedSuccess({
  modelName,
  labHue,
  glyph,
  venueName,
  amount,
  discount,
  net,
  onView,
  onAgain,
}: {
  modelName: string
  labHue: string
  glyph: string
  venueName: string
  amount: number
  discount: number
  net: number
  onView: () => void
  onAgain: () => void
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-4 py-20 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[var(--s-accent-soft)]">
        <span className="i-ph:check-circle-fill text-[40px] text-[var(--s-accent)]" />
      </div>
      <h2 className="mt-4 font-display text-[22px] font-bold text-[var(--s-text)]">Offer is live</h2>
      <p className="mt-1.5 font-body text-[13px] text-[var(--s-text-muted)]">
        {fmtTokens(amount)} tokens of {modelName} via {venueName}, {pct(discount, 0)} below list. Resting on the book.
      </p>
      <div className="mt-5 flex w-full items-center gap-3 panel px-4 py-3">
        <Mark hue={labHue} glyph={glyph} label={modelName} />
        <div className="flex-1 text-left">
          <div className="mono-label">Projected net</div>
          <div className="font-data text-[18px] font-bold tabular-nums text-[var(--s-emerald)]">{usd(net, net >= 100 ? 0 : 2)}</div>
        </div>
        <span className="h-2 w-2 animate-pulse rounded-full bg-[var(--s-emerald)]" />
      </div>
      <button onClick={onView} className="btn-primary mt-5 h-11 w-full !text-[13px]">
        View my offers
      </button>
      <button onClick={onAgain} className="btn-secondary mt-2 h-9 w-full !text-[12px]">
        List another
      </button>
    </div>
  )
}
