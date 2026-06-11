import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { PageHeader } from '~/components/PageHeader'
import { Badge, Mark, Panel, Segmented, Stat } from '~/components/ui'
import { pct, tokens, usd } from '~/lib/format'
import { ALL_MODELS, LABS } from '~/lib/mock'

interface Lot {
  modelId: string
  kind: 'output' | 'input'
  remaining: number
  total: number
  paidUsd: number
  discount: number
  expiresDays: number
}
interface MyOffer {
  modelId: string
  remaining: number
  discount: number
  soldPct: number
  netUsd: number
}

const LOTS: Lot[] = [
  { modelId: 'anthropic/claude-opus-4-8', kind: 'output', remaining: 38_400_000, total: 50_000_000, paidUsd: 2940, discount: 0.21, expiresDays: 23 },
  { modelId: 'openai/gpt-5', kind: 'output', remaining: 12_000_000, total: 12_000_000, paidUsd: 312, discount: 0.18, expiresDays: 11 },
  { modelId: 'google/gemini-3-pro', kind: 'input', remaining: 4_500_000, total: 20_000_000, paidUsd: 18.4, discount: 0.27, expiresDays: 4 },
]
const OFFERS: MyOffer[] = [
  { modelId: 'meta/llama-4-405b', remaining: 14_200_000, discount: 0.24, soldPct: 0.43, netUsd: 168 },
  { modelId: 'deepseek/deepseek-v4', remaining: 8_000_000, discount: 0.31, soldPct: 0.12, netUsd: 41 },
]

export default function PortfolioPage() {
  const [tab, setTab] = useState<'lots' | 'offers'>('lots')

  const summary = useMemo(() => {
    const lotValue = LOTS.reduce((s, l) => s + (l.paidUsd * l.remaining) / l.total, 0)
    const offerNet = OFFERS.reduce((s, o) => s + o.netUsd, 0)
    return { lotValue, offerNet, lotCount: LOTS.length, offerCount: OFFERS.length }
  }, [])

  return (
    <div>
      <PageHeader
        title="Portfolio"
        subtitle="Credits you hold and offers you're running. Redeem anytime through the router; unserved or expired spend refunds in full."
        right={
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: 'lots', label: `Holdings · ${LOTS.length}` },
              { value: 'offers', label: `Offers · ${OFFERS.length}` },
            ]}
          />
        }
      />
      <div className="px-4 py-4 sm:px-6">
        <div className="panel grid grid-cols-2 divide-x divide-[var(--s-divider)] sm:grid-cols-4">
          <Stat label="Redeemable value" value={usd(summary.lotValue, 0)} tone="accent" />
          <Stat label="Credit lots" value={summary.lotCount} />
          <Stat label="Open offers" value={summary.offerCount} />
          <Stat label="Offer net (proj.)" value={usd(summary.offerNet, 0)} tone="emerald" />
        </div>

        {tab === 'lots' ? (
          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {LOTS.map((l) => {
              const model = ALL_MODELS.find((m) => m.id === l.modelId)!
              const lab = LABS[model.labId]!
              const usedPct = 1 - l.remaining / l.total
              const value = (l.paidUsd * l.remaining) / l.total
              const soon = l.expiresDays <= 7
              return (
                <Panel key={l.modelId}>
                  <div className="px-4 py-3.5">
                    <div className="flex items-center gap-2.5">
                      <Mark hue={lab.hue} glyph={lab.glyph} label={lab.name} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-data text-[14px] font-semibold text-[var(--s-text)]">{model.name}</div>
                        <div className="font-data text-[12px] text-[var(--s-text-muted)]">{l.kind} · {pct(l.discount, 0)} off</div>
                      </div>
                      <Badge tone={soon ? 'amber' : 'neutral'} icon="i-ph:clock">{l.expiresDays}d</Badge>
                    </div>

                    <div className="mt-3.5">
                      <div className="mb-1 flex items-center justify-between font-data text-[12px]">
                        <span className="text-[var(--s-text-muted)]">{tokens(l.remaining)} of {tokens(l.total)} left</span>
                        <span className="tabular-nums text-[var(--s-text-secondary)]">{pct(usedPct, 0)} used</span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-[var(--s-border)]">
                        <div className="h-full bg-[var(--s-accent)]" style={{ width: `${(1 - usedPct) * 100}%` }} />
                      </div>
                    </div>

                    <div className="mt-3.5 flex items-end justify-between">
                      <div>
                        <div className="mono-label">Redeemable value</div>
                        <div className="font-data text-[17px] font-bold tabular-nums text-[var(--s-text)]">{usd(value, 2)}</div>
                      </div>
                      <div className="flex gap-2">
                        <Link to={`/m/${model.id}`} className="btn-secondary h-8 !text-[12px]">Market</Link>
                        <button className="btn-primary h-8 !text-[12px]">Redeem</button>
                      </div>
                    </div>
                  </div>
                </Panel>
              )
            })}
          </div>
        ) : (
          <Panel className="mt-4" title="My offers">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-collapse">
                <thead>
                  <tr className="border-b border-[var(--s-divider)] text-left">
                    <th className="mono-label h-9 px-3">Model</th>
                    <th className="mono-label h-9 px-3 text-right">Discount</th>
                    <th className="mono-label h-9 px-3 text-right">Remaining</th>
                    <th className="mono-label h-9 px-3 text-right">Sold</th>
                    <th className="mono-label h-9 px-3 text-right">Net (proj.)</th>
                    <th className="mono-label h-9 px-3 text-right w-24" />
                  </tr>
                </thead>
                <tbody>
                  {OFFERS.map((o) => {
                    const model = ALL_MODELS.find((m) => m.id === o.modelId)!
                    const lab = LABS[model.labId]!
                    return (
                      <tr key={o.modelId} className="border-b border-[var(--s-divider)] last:border-0 hover:bg-[var(--s-panel)]">
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-2.5">
                            <Mark hue={lab.hue} glyph={lab.glyph} label={lab.name} size={24} />
                            <span className="font-data text-[14px] text-[var(--s-text)]">{model.name}</span>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-right font-data text-[13px] tabular-nums text-[var(--s-emerald)]">{pct(o.discount, 0)}</td>
                        <td className="px-3 py-2.5 text-right font-data text-[13px] tabular-nums text-[var(--s-text-secondary)]">{tokens(o.remaining)}</td>
                        <td className="px-3 py-2.5 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <div className="h-1 w-14 overflow-hidden rounded-full bg-[var(--s-border)]">
                              <div className="h-full bg-[var(--s-accent)]" style={{ width: `${o.soldPct * 100}%` }} />
                            </div>
                            <span className="font-data text-[13px] tabular-nums text-[var(--s-text-muted)]">{pct(o.soldPct, 0)}</span>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-right font-data text-[13px] tabular-nums text-[var(--s-emerald)]">{usd(o.netUsd, 0)}</td>
                        <td className="px-3 py-2.5 text-right">
                          <button className="btn-secondary h-7 !text-[11px]">Cancel</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Panel>
        )}
      </div>
    </div>
  )
}
