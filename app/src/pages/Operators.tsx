import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useReadContracts } from 'wagmi'
import { useQueryClient } from '@tanstack/react-query'
import { Identicon } from '@tangle-network/blueprint-ui/components'
import type { Address } from 'viem'
import { formatUnits } from 'viem'
import { PageHeader } from '~/components/PageHeader'
import { Badge, Panel, Stat } from '~/components/ui'
import { cn } from '~/lib/cn'
import { compactUsd, truncAddr } from '~/lib/format'
import { CHAIN, useInstruments, useVenueHealth } from '~/lib/api'
import { SETTLEMENT, SETTLEMENT_ABI } from '~/lib/settlement'
import { useVenueRegistry, useMarketRequests, requestMarket, type Venue } from '~/lib/venues'

const STAKING_ABI = [
  {
    type: 'function',
    name: 'getOperatorStake',
    inputs: [{ name: 'operator', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'isOperator',
    inputs: [{ name: 'operator', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
  },
] as const

function formatTntBond(bond: bigint | undefined) {
  if (bond === undefined) return '…'
  const tnt = Number(formatUnits(bond, 18))
  return `${tnt.toLocaleString('en-US', { maximumFractionDigits: tnt >= 100 ? 0 : 2 })} TNT`
}

function displayVenueUrl(url: string | undefined) {
  return url ? url.replace(/^https?:\/\//, '').replace(/\/$/, '') : '—'
}

/** Buyer-side demand: request a market operators aren't quoting yet, and see the
 * aggregated demand book (what's wanted vs already quoted) across the operator set. */
function RequestMarket({ venues, servedIds }: { venues: Venue[] | undefined; servedIds: Set<string> }) {
  const [model, setModel] = useState('')
  const [kind, setKind] = useState<'output' | 'input'>('output')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState<string | null>(null)
  const demand = useMarketRequests(venues)
  const qc = useQueryClient()
  const reachable = (venues ?? []).filter((v) => v.healthy).length

  async function submit() {
    const m = model.trim()
    if (!m || busy) return
    setBusy(true)
    setSent(null)
    try {
      const n = await requestMarket(venues, m, kind)
      setSent(
        n > 0
          ? `Requested ${m}:${kind} — ${n} operator${n === 1 ? '' : 's'} notified`
          : 'No operators reachable right now',
      )
      setModel('')
      void qc.invalidateQueries({ queryKey: ['market-requests'] })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel className="mt-4 p-4" title="Request a market">
      <p className="font-body text-[15px] text-[var(--s-text-muted)]">
        Want a model the operators aren't quoting yet? Signal demand — operators read the demand
        book to decide what to list next.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="anthropic/claude-opus-4-8"
          className="h-10 min-w-[240px] flex-1 rounded-[8px] border border-[var(--s-border)] bg-[var(--s-glass)] px-3 font-data text-[15px] text-[var(--s-text)] placeholder:text-[var(--s-text-subtle)] focus-ring"
        />
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as 'output' | 'input')}
          className="h-10 rounded-[8px] border border-[var(--s-border)] bg-[var(--s-glass)] px-2 font-data text-[15px] text-[var(--s-text)]"
        >
          <option value="output">output</option>
          <option value="input">input</option>
        </select>
        <button
          onClick={submit}
          disabled={busy || !model.trim() || reachable === 0}
          className="btn-primary h-10"
        >
          {busy ? 'Sending…' : 'Request'}
        </button>
      </div>
      {sent && <div className="mt-2 font-data text-[15px] text-[var(--s-emerald)]">{sent}</div>}

      {(demand.data?.length ?? 0) > 0 && (
        <div className="mt-4">
          <div className="mono-label mb-2">Most requested</div>
          <div className="flex flex-col gap-1.5">
            {demand.data!.slice(0, 8).map((d) => (
              <div
                key={d.instrumentId}
                className="flex items-center justify-between gap-3 rounded-[6px] bg-[var(--s-bg)]/40 px-3 py-1.5"
              >
                <span className="font-data text-[15px] text-[var(--s-text)]">{d.instrumentId}</span>
                <span className="flex items-center gap-2">
                  {servedIds.has(d.instrumentId) ? (
                    <Badge tone="emerald">quoted</Badge>
                  ) : (
                    <Badge tone="amber">wanted</Badge>
                  )}
                  <span className="font-data text-[15px] tabular-nums text-[var(--s-text-muted)]">
                    {d.count}×
                  </span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Panel>
  )
}

export default function OperatorsPage() {
  // Multi-instance: the directory is the UNION of operators across every ACTIVE
  // blueprint-17 service instance (the live registry), not a single pinned
  // service — an operator joining any instance shows up here with no app change.
  const registry = useVenueRegistry()
  const addrs = useMemo(
    () => [...new Map((registry.data ?? []).map((v) => [v.operator.toLowerCase(), v.operator])).values()] as Address[],
    [registry.data],
  )
  const bonds = useReadContracts({
    contracts: addrs.map((a) => ({
      address: CHAIN.staking,
      abi: STAKING_ABI,
      functionName: 'getOperatorStake' as const,
      args: [a] as const,
      chainId: CHAIN.id,
    })),
    query: { enabled: addrs.length > 0 },
  })
  const health = useVenueHealth()
  const instruments = useInstruments()
  // Which operators actually serve a live venue (vs merely registered on-chain).
  const venueByOp = useMemo(() => {
    const m = new Map<string, { url: string; healthy: boolean; latencyMs: number | null; onion: string | null }>()
    for (const v of registry.data ?? []) {
      m.set(v.operator.toLowerCase(), { url: v.url, healthy: v.healthy, latencyMs: v.latencyMs, onion: v.onion })
    }
    return m
  }, [registry.data])
  const issuerFunds = useReadContracts({
    contracts: addrs.flatMap((a) => [
      { address: SETTLEMENT.address, abi: SETTLEMENT_ABI, functionName: 'collateral' as const, args: [a] as const, chainId: CHAIN.id },
      { address: SETTLEMENT.address, abi: SETTLEMENT_ABI, functionName: 'liability' as const, args: [a] as const, chainId: CHAIN.id },
    ]),
    query: { enabled: addrs.length > 0 },
  })
  const rows = useMemo(
    () =>
      addrs.map((addr, i) => {
        const venue = venueByOp.get(addr.toLowerCase())
        return {
          addr,
          bond: bonds.data?.[i]?.result as bigint | undefined,
          collateral: issuerFunds.data?.[i * 2]?.result as bigint | undefined,
          liability: issuerFunds.data?.[i * 2 + 1]?.result as bigint | undefined,
          serving: venue?.healthy ?? false,
          venue,
        }
      }).sort((a, b) => {
        if (a.serving !== b.serving) return a.serving ? -1 : 1
        const la = a.venue?.latencyMs ?? Infinity
        const lb = b.venue?.latencyMs ?? Infinity
        if (la !== lb) return la - lb
        const ba = a.bond ?? 0n
        const bb = b.bond ?? 0n
        return bb > ba ? 1 : bb < ba ? -1 : 0
      }),
    [addrs, bonds.data, issuerFunds.data, venueByOp],
  )

  return (
    <div>
      <PageHeader
        title="Operators"
        subtitle="Every operator across Inference Bazaar's live instances on Base Sepolia — bonded restake, slashed for refusing valid redemptions."
        right={
          <Link to="/operators/register" className="btn-primary h-10">
            <span className="i-ph:plus text-[15px]" /> Become an operator
          </Link>
        }
      />

      <div className="px-4 py-4 sm:px-6">
        <div className="panel grid grid-cols-2 divide-x divide-[var(--s-divider)] sm:grid-cols-4">
          <Stat
            label="Operators"
            value={registry.isLoading ? '…' : addrs.length}
            tone="accent"
            sub={`blueprint ${CHAIN.blueprintId} · all instances`}
          />
          <Stat
            label="Venue"
            value={health.data?.ok ? 'live' : health.isError ? 'down' : '…'}
            tone={health.data?.ok ? 'emerald' : 'crimson'}
            sub={health.data ? `${health.data.latencyMs}ms` : undefined}
          />
          <Stat label="Markets quoted" value={instruments.data?.length ?? '…'} />
          <Stat label="Chain" value="Base Sepolia" sub={`#${CHAIN.id}`} />
        </div>

        <RequestMarket
          venues={registry.data}
          servedIds={new Set((instruments.data ?? []).map((i) => i.id))}
        />

        <Panel className="mt-4" title="On-chain operator set">
          {registry.isError && (
            <div className="px-4 py-8 text-center font-data text-[15px] text-[var(--s-text-muted)]">
              Chain read failed — check RPC connectivity.
            </div>
          )}
          {registry.isLoading && (
            <div className="px-4 py-8 text-center font-data text-[15px] text-[var(--s-text-muted)]">
              Discovering operators across instances…
            </div>
          )}
          {!registry.isLoading && !registry.isError && rows.length === 0 && (
            <div className="px-4 py-8 text-center font-data text-[15px] text-[var(--s-text-muted)]">
              No operators are active for blueprint {CHAIN.blueprintId}.
            </div>
          )}
          {rows.length > 0 && (
            <>
              <div className="md:hidden">
                {rows.map((row) => (
                  <div
                    key={row.addr}
                    className="border-b border-[var(--s-divider)] px-4 py-4 last:border-0"
                  >
                    <div className="flex items-center gap-3">
                      <span className="overflow-hidden rounded-full ring-1 ring-[var(--s-border)]">
                        <Identicon address={row.addr} size={36} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <a
                          href={`${CHAIN.explorer}/address/${row.addr}`}
                          target="_blank"
                          rel="noreferrer"
                          className="font-data text-[15px] font-semibold text-[var(--s-text)] hover:text-[var(--s-accent)]"
                        >
                          {truncAddr(row.addr)}
                        </a>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          <Badge tone="emerald" icon="i-ph:shield-check-fill">bonded</Badge>
                          {row.serving ? <Badge tone="accent">quoting</Badge> : <Badge>offline</Badge>}
                          {row.venue?.onion && <Badge tone="neutral" icon="i-ph:shield">.onion</Badge>}
                        </div>
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-3 font-data">
                      <div>
                        <div className="mono-label">Restake bond</div>
                        <div className="mt-1 text-[15px] font-bold tabular-nums text-[var(--s-text)]">
                          {formatTntBond(row.bond)}
                        </div>
                      </div>
                      <div>
                        <div className="mono-label">Issuance collateral</div>
                        <div className="mt-1 text-[15px] font-bold tabular-nums text-[var(--s-emerald)]">
                          {row.collateral !== undefined ? compactUsd(Number(row.collateral)) : '…'}
                        </div>
                        <div className="mt-0.5 text-[12px] tabular-nums text-[var(--s-text-muted)]">
                          liability {row.liability !== undefined ? compactUsd(Number(row.liability)) : '…'}
                        </div>
                      </div>
                    </div>
                    <div className="mt-3 truncate font-data text-[13px] text-[var(--s-text-muted)]">
                      {row.serving ? displayVenueUrl(row.venue?.url) : 'joined on-chain, venue offline'}
                      {row.venue?.latencyMs != null && (
                        <span className={row.venue.latencyMs < 400 ? 'text-[var(--s-emerald)]' : undefined}>
                          {' '}· {row.venue.latencyMs}ms
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <div className="hidden overflow-x-auto md:block">
                <table className="w-full min-w-[1060px] border-collapse">
                  <thead>
                    <tr className="border-b border-[var(--s-divider)] text-left">
                      <th className="mono-label px-4 py-3">Operator</th>
                      <th className="mono-label px-3 py-3">Status</th>
                      <th className="mono-label min-w-[340px] px-3 py-3">Venue</th>
                      <th className="mono-label px-3 py-3 text-right">Restake bond</th>
                      <th className="mono-label px-4 py-3 text-right">Issuance collateral</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.addr} className="border-b border-[var(--s-divider)] last:border-0">
                        <td className="px-4 py-3.5">
                          <div className="flex min-w-[170px] items-center gap-3">
                            <span className="overflow-hidden rounded-full ring-1 ring-[var(--s-border)]">
                              <Identicon address={row.addr} size={34} />
                            </span>
                            <a
                              href={`${CHAIN.explorer}/address/${row.addr}`}
                              target="_blank"
                              rel="noreferrer"
                              className="font-data text-[15px] font-semibold text-[var(--s-text)] hover:text-[var(--s-accent)]"
                            >
                              {truncAddr(row.addr)}
                            </a>
                          </div>
                        </td>
                        <td className="px-3 py-3.5">
                          <div className="flex min-w-[132px] flex-wrap gap-1.5">
                            <Badge tone="emerald" icon="i-ph:shield-check-fill">bonded</Badge>
                            {row.serving ? <Badge tone="accent">quoting</Badge> : <Badge>offline</Badge>}
                            {row.venue?.onion && <Badge tone="neutral" icon="i-ph:shield">.onion</Badge>}
                          </div>
                        </td>
                        <td className="min-w-[340px] px-3 py-3.5">
                          <div className="flex min-w-0 items-center gap-1.5 font-data text-[13px] text-[var(--s-text-muted)]">
                            <span className="min-w-0 truncate">
                              {row.serving ? displayVenueUrl(row.venue?.url) : 'joined on-chain'}
                            </span>
                            {row.venue?.latencyMs != null && (
                              <span
                                className={cn(
                                  'shrink-0',
                                  row.venue.latencyMs < 400 && 'text-[var(--s-emerald)]',
                                )}
                              >
                                · {row.venue.latencyMs}ms
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-3.5 text-right font-data text-[15px] font-bold tabular-nums text-[var(--s-text)]">
                          {formatTntBond(row.bond)}
                        </td>
                        <td className="px-4 py-3.5 text-right">
                          <div className="font-data text-[15px] font-bold tabular-nums text-[var(--s-emerald)]">
                            {row.collateral !== undefined ? compactUsd(Number(row.collateral)) : '…'}
                          </div>
                          <div className="mt-0.5 font-data text-[12px] tabular-nums text-[var(--s-text-muted)]">
                            liability {row.liability !== undefined ? compactUsd(Number(row.liability)) : '…'}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Panel>

        <div className={cn('panel mt-4 px-4 py-3 font-data text-[15px] text-[var(--s-text-muted)]')}>
          Every lot is cash-collateralized at mint: the contract rejects issuance unless collateral
          covers outstanding liability plus the default penalty. Refusal to serve is slashable;
          principal never depends on the slash.{' '}
          <a
            href={`${CHAIN.explorer}/address/${CHAIN.staking}`}
            target="_blank"
            rel="noreferrer"
            className="text-[var(--s-accent)] hover:underline"
          >
            Restaking contract ↗
          </a>
        </div>
      </div>
    </div>
  )
}
