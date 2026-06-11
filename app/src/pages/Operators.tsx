import { Link } from 'react-router-dom'
import { PageHeader } from '~/components/PageHeader'
import { Badge, Mark, Panel, Stat } from '~/components/ui'
import { cn } from '~/lib/cn'
import { compactUsd, pct, tokens, usd } from '~/lib/format'

interface Op {
  handle: string
  addr: string
  models: number
  venues: string[]
  bondUsd: number
  served7dMicro: number
  fillRate: number
  redemptions: number
  uptime: number
  slashes: number
  hue: string
}

const OPERATORS: Op[] = [
  { handle: 'tangle-mm-01', addr: '0x7a3f…0a12', models: 14, venues: ['OpenRouter', 'Anthropic', 'Together'], bondUsd: 48_200, served7dMicro: 1_240_000_000_000, fillRate: 0.998, redemptions: 18420, uptime: 0.9997, slashes: 0, hue: '#50d2c1' },
  { handle: 'h100farm', addr: '0x19bc…77f3', models: 9, venues: ['Fireworks', 'Together'], bondUsd: 31_500, served7dMicro: 820_000_000_000, fillRate: 0.994, redemptions: 11210, uptime: 0.9989, slashes: 0, hue: '#9b7cff' },
  { handle: 'venice-desk', addr: '0x4d21…91ab', models: 6, venues: ['Venice AI', 'OpenRouter'], bondUsd: 22_750, served7dMicro: 540_000_000_000, fillRate: 0.991, redemptions: 7640, uptime: 0.9972, slashes: 1, hue: '#e23b4e' },
  { handle: 'idlecluster', addr: '0x88fa…2c40', models: 11, venues: ['OpenRouter', 'Google'], bondUsd: 39_900, served7dMicro: 690_000_000_000, fillRate: 0.996, redemptions: 9930, uptime: 0.9991, slashes: 0, hue: '#4285f4' },
  { handle: 'nightshift', addr: '0xc0de…5e88', models: 5, venues: ['Together'], bondUsd: 14_300, served7dMicro: 210_000_000_000, fillRate: 0.987, redemptions: 3120, uptime: 0.9954, slashes: 0, hue: '#f5a623' },
]

export default function OperatorsPage() {
  const totalBond = OPERATORS.reduce((s, o) => s + o.bondUsd, 0)
  const totalServed = OPERATORS.reduce((s, o) => s + o.served7dMicro, 0)
  const totalRedemptions = OPERATORS.reduce((s, o) => s + o.redemptions, 0)
  return (
    <div>
      <PageHeader
        title="Operators"
        subtitle="Market makers who quote both sides and fulfill redemptions. Each posts collateral and stakes restake — slashed if they fail to serve a valid credit."
        right={
          <Link to="/operators/register" className="btn-primary h-9">
            <span className="i-ph:plus text-[15px]" /> Register
          </Link>
        }
      />

      <div className="px-4 py-4 sm:px-6">
        <div className="panel grid grid-cols-2 divide-x divide-[var(--s-divider)] sm:grid-cols-4">
          <Stat label="Active operators" value={OPERATORS.length} tone="accent" />
          <Stat label="Total bonded" value={usd(totalBond, 0)} />
          <Stat label="7d served" value={compactUsd(totalServed)} />
          <Stat label="Redemptions" value={tokens(totalRedemptions)} sub="7d" />
        </div>

        <Panel className="mt-4" title="Registered operators">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] border-collapse">
              <thead>
                <tr className="border-b border-[var(--s-divider)] text-left">
                  <Th>Operator</Th>
                  <Th>Venues</Th>
                  <Th align="right">Models</Th>
                  <Th align="right">Bond</Th>
                  <Th align="right">7d served</Th>
                  <Th align="right">Fill rate</Th>
                  <Th align="right">Uptime</Th>
                  <Th align="right">Slashes</Th>
                </tr>
              </thead>
              <tbody>
                {OPERATORS.map((o) => (
                  <tr key={o.handle} className="border-b border-[var(--s-divider)] last:border-0 hover:bg-[var(--s-panel)]">
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <Mark hue={o.hue} glyph="i-ph:hard-drives" label={o.handle} />
                        <div>
                          <div className="font-data text-[13px] font-semibold text-[var(--s-text)]">{o.handle}</div>
                          <div className="font-data text-[11px] text-[var(--s-text-muted)]">{o.addr}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {o.venues.map((v) => (
                          <span key={v} className="rounded-[4px] bg-[var(--s-panel-strong)] px-1.5 py-0.5 font-data text-[10px] text-[var(--s-text-muted)]">
                            {v}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right font-data text-[13px] tabular-nums text-[var(--s-text-secondary)]">{o.models}</td>
                    <td className="px-3 py-2.5 text-right font-data text-[13px] tabular-nums text-[var(--s-text)]">{usd(o.bondUsd, 0)}</td>
                    <td className="px-3 py-2.5 text-right font-data text-[13px] tabular-nums text-[var(--s-text-secondary)]">{compactUsd(o.served7dMicro)}</td>
                    <td className="px-3 py-2.5 text-right font-data text-[13px] tabular-nums text-[var(--s-emerald)]">{pct(o.fillRate, 1)}</td>
                    <td className="px-3 py-2.5 text-right font-data text-[13px] tabular-nums text-[var(--s-text-secondary)]">{pct(o.uptime, 2)}</td>
                    <td className="px-3 py-2.5 text-right">
                      {o.slashes === 0 ? (
                        <Badge tone="emerald" icon="i-ph:shield-check-fill">clean</Badge>
                      ) : (
                        <Badge tone="crimson">{o.slashes}</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </div>
  )
}

function Th({ children, align = 'left' }: { children?: React.ReactNode; align?: 'left' | 'right' }) {
  return <th className={cn('mono-label h-9 px-3 font-semibold', align === 'right' ? 'text-right' : 'text-left')}>{children}</th>
}
