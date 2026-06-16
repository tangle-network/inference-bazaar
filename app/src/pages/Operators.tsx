import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useReadContracts } from 'wagmi'
import { Identicon } from '@tangle-network/blueprint-ui/components'
import type { Address } from 'viem'
import { formatUnits } from 'viem'
import { PageHeader } from '~/components/PageHeader'
import { Badge, Panel, Stat } from '~/components/ui'
import { cn } from '~/lib/cn'
import { compactUsd, truncAddr } from '~/lib/format'
import { CHAIN, useInstruments, useVenueHealth } from '~/lib/api'
import { SETTLEMENT, SETTLEMENT_ABI } from '~/lib/settlement'
import { useVenueRegistry } from '~/lib/venues'

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
          {addrs
            .map((addr, i) => ({
              addr,
              bond: bonds.data?.[i]?.result as bigint | undefined,
              venue: venueByOp.get(addr.toLowerCase()),
              collateral: issuerFunds.data?.[i * 2]?.result as bigint | undefined,
              liability: issuerFunds.data?.[i * 2 + 1]?.result as bigint | undefined,
            }))
            // Best-first: serving operators, then lowest latency, then biggest bond.
            .sort((a, b) => {
              const sa = a.venue?.healthy ? 1 : 0
              const sb = b.venue?.healthy ? 1 : 0
              if (sa !== sb) return sb - sa
              const la = a.venue?.latencyMs ?? Infinity
              const lb = b.venue?.latencyMs ?? Infinity
              if (la !== lb) return la - lb
              const ba = a.bond ?? 0n
              const bb = b.bond ?? 0n
              return bb > ba ? 1 : bb < ba ? -1 : 0
            })
            .map(({ addr, bond, venue, collateral, liability }) => {
              const serving = venue?.healthy ?? false
              const fast = (venue?.latencyMs ?? Infinity) < 400
              return (
                <div
                  key={addr}
                  className="flex flex-wrap items-center gap-4 border-b border-[var(--s-divider)] px-4 py-4 last:border-0"
                >
                  <span className="relative overflow-hidden rounded-full ring-1 ring-[var(--s-border)]">
                    <Identicon address={addr} size={36} />
                    <span
                      className={cn(
                        'absolute -bottom-0 -right-0 h-3 w-3 rounded-full ring-2 ring-[var(--s-panel)]',
                        serving ? 'bg-[var(--s-emerald)]' : 'bg-[var(--s-text-subtle)]',
                      )}
                      title={serving ? 'serving' : 'on-chain only'}
                    />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <a
                        href={`${CHAIN.explorer}/address/${addr}`}
                        target="_blank"
                        rel="noreferrer"
                        className="font-data text-[15px] font-semibold text-[var(--s-text)] hover:text-[var(--s-accent)]"
                      >
                        {truncAddr(addr)}
                      </a>
                      <Badge tone="emerald" icon="i-ph:shield-check-fill">bonded</Badge>
                      {serving && <Badge tone="accent">quoting</Badge>}
                      {venue?.onion && (
                        <Badge tone="neutral" icon="i-ph:shield">.onion</Badge>
                      )}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 font-data text-[15px] text-[var(--s-text-muted)]">
                      {serving ? (
                        <>
                          <span>{venue!.url.replace('https://', '')}</span>
                          {venue?.latencyMs != null && (
                            <span className={fast ? 'text-[var(--s-emerald)]' : undefined}>
                              · {venue.latencyMs}ms
                            </span>
                          )}
                        </>
                      ) : (
                        'joined the operator set on-chain'
                      )}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="mono-label">Restake bond</div>
                    <div className="font-data text-[15px] font-bold tabular-nums text-[var(--s-text)]">
                      {bond !== undefined ? `${Number(formatUnits(bond, 18)).toLocaleString()} TNT` : '…'}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="mono-label">Issuance collateral</div>
                    <div className="font-data text-[15px] font-bold tabular-nums text-[var(--s-emerald)]">
                      {collateral !== undefined ? compactUsd(Number(collateral)) : '…'}
                    </div>
                    <div className="font-data text-[12px] tabular-nums text-[var(--s-text-muted)]">
                      {liability !== undefined ? `liability ${compactUsd(Number(liability))}` : ''}
                    </div>
                  </div>
                </div>
              )
            })}
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
