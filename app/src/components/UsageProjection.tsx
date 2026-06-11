import { useMemo, useState } from 'react'
import { Slider } from '~/components/ui'
import { usd, tokens as fmtTokens } from '~/lib/format'

/**
 * The buyer's actual question, answered: "I burn ~N tokens/month — what does
 * this market save me vs list?" A log slider over monthly token volume drives a
 * cost-vs-list bar and a savings headline. This is the compelling, legible hook
 * that turns an abstract $/1M price into the buyer's real monthly decision.
 */
export function UsageProjection({
  listMicroPerM,
  bestMicroPerM,
  defaultTokens = 50_000_000,
}: {
  listMicroPerM: number
  bestMicroPerM: number
  defaultTokens?: number
}) {
  // Log slider: 1M .. 5B tokens/month.
  const MIN = Math.log10(1_000_000)
  const MAX = Math.log10(5_000_000_000)
  const [logV, setLogV] = useState(Math.log10(defaultTokens))
  const monthlyTokens = Math.round(10 ** logV)

  const { listCost, bestCost, saving, savingPct } = useMemo(() => {
    const listCost = (listMicroPerM * monthlyTokens) / 1_000_000 / 1_000_000
    const bestCost = (bestMicroPerM * monthlyTokens) / 1_000_000 / 1_000_000
    const saving = listCost - bestCost
    return { listCost, bestCost, saving, savingPct: listCost > 0 ? saving / listCost : 0 }
  }, [listMicroPerM, bestMicroPerM, monthlyTokens])

  const bestW = listCost > 0 ? Math.max(6, (bestCost / listCost) * 100) : 0

  return (
    <div>
      <div className="flex items-end justify-between">
        <div>
          <div className="mono-label">Projected monthly usage</div>
          <div className="mt-1 font-data text-[22px] font-bold tabular-nums text-[var(--s-text)]">
            {fmtTokens(monthlyTokens)} <span className="text-[14px] font-medium text-[var(--s-text-muted)]">tokens</span>
          </div>
        </div>
        <div className="text-right">
          <div className="mono-label">You save</div>
          <div className="mt-1 font-data text-[22px] font-bold tabular-nums text-[var(--s-emerald)]">
            {usd(saving, saving >= 100 ? 0 : 2)}
            <span className="ml-1 text-[14px] font-medium text-[var(--s-text-muted)]">/mo</span>
          </div>
        </div>
      </div>

      <div className="mt-4">
        <Slider value={logV} min={MIN} max={MAX} step={0.01} onChange={setLogV} />
        <div className="mt-1.5 flex justify-between font-data text-[11px] text-[var(--s-text-subtle)]">
          <span>1M</span>
          <span>50M</span>
          <span>1B</span>
          <span>5B</span>
        </div>
      </div>

      {/* Cost-vs-list bars */}
      <div className="mt-5 space-y-3">
        <div>
          <div className="mb-1 flex items-center justify-between font-data text-[12px]">
            <span className="text-[var(--s-text-muted)]">At list price</span>
            <span className="tabular-nums text-[var(--s-text-secondary)]">{usd(listCost, listCost >= 100 ? 0 : 2)}/mo</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-[var(--s-border)]">
            <div className="h-full rounded-full bg-[var(--s-text-subtle)]" style={{ width: '100%' }} />
          </div>
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between font-data text-[12px]">
            <span className="text-[var(--s-accent)]">Best market price</span>
            <span className="tabular-nums text-[var(--s-accent)]">{usd(bestCost, bestCost >= 100 ? 0 : 2)}/mo</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-[var(--s-border)]">
            <div
              className="h-full rounded-full bg-[var(--s-accent)] transition-[width] duration-300"
              style={{ width: `${bestW}%` }}
            />
          </div>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-center gap-1.5 rounded-[6px] bg-[var(--s-emerald-soft)] py-2 font-data text-[13px] font-semibold text-[var(--s-emerald)]">
        <span className="i-ph:trend-down text-[15px]" />
        {(savingPct * 100).toFixed(0)}% cheaper than list at this volume
      </div>
    </div>
  )
}
