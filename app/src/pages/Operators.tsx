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
    const m = new Map<string, { url: string; healthy: boolean }>()
    for (const v of registry.data ?? []) {
      m.set(v.operator.toLowerCase(), { url: v.url, healthy: v.healthy })
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
          {addrs.map((addr, i) => {
            const bond = bonds.data?.[i]?.result as bigint | undefined
            const venue = venueByOp.get(addr.toLowerCase())
            const serving = venue?.healthy ?? false
            return (
              <div
                key={addr}
                className="flex flex-wrap items-center gap-4 border-b border-[var(--s-divider)] px-4 py-4 last:border-0"
              >
                <span className="overflow-hidden rounded-full ring-1 ring-[var(--s-border)]">
                  <Identicon address={addr} size={36} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
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
                  </div>
                  <div className="mt-0.5 font-data text-[15px] text-[var(--s-text-muted)]">
                    {serving
                      ? `serves the venue API · ${venue!.url.replace('https://', '')}`
                      : 'joined the operator set on-chain'}
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
                    {issuerFunds.data?.[i * 2]?.result !== undefined
                      ? compactUsd(Number(issuerFunds.data[i * 2]!.result))
                      : '…'}
                  </div>
                  <div className="font-data text-[12px] tabular-nums text-[var(--s-text-muted)]">
                    {issuerFunds.data?.[i * 2 + 1]?.result !== undefined
                      ? `liability ${compactUsd(Number(issuerFunds.data[i * 2 + 1]!.result))}`
                      : ''}
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
