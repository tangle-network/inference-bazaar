import { Link } from 'react-router-dom'
import { useReadContract, useReadContracts } from 'wagmi'
import { Identicon } from '@tangle-network/blueprint-ui/components'
import type { Address } from 'viem'
import { formatUnits } from 'viem'
import { PageHeader } from '~/components/PageHeader'
import { Badge, Panel, Stat } from '~/components/ui'
import { cn } from '~/lib/cn'
import { compactUsd, truncAddr } from '~/lib/format'
import { CHAIN, useInstruments, useVenueHealth, VENUE_URL } from '~/lib/api'
import { SETTLEMENT, SETTLEMENT_ABI } from '~/lib/settlement'

const TANGLE_ABI = [
  {
    type: 'function',
    name: 'getServiceOperators',
    inputs: [{ name: 'serviceId', type: 'uint64' }],
    outputs: [{ name: '', type: 'address[]' }],
    stateMutability: 'view',
  },
] as const

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
  const operators = useReadContract({
    address: CHAIN.tangle,
    abi: TANGLE_ABI,
    functionName: 'getServiceOperators',
    args: [BigInt(CHAIN.serviceId)],
    chainId: CHAIN.id,
  })
  const addrs = (operators.data ?? []) as Address[]
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
        subtitle="The on-chain operator set of Surplus service 4 — bonded restake, slashed for refusing valid redemptions."
        right={
          <Link to="/operators/register" className="btn-primary h-10">
            <span className="i-ph:plus text-[15px]" /> Become an operator
          </Link>
        }
      />

      <div className="px-4 py-4 sm:px-6">
        <div className="panel grid grid-cols-2 divide-x divide-[var(--s-divider)] sm:grid-cols-4">
          <Stat
            label="Service operators"
            value={operators.isLoading ? '…' : addrs.length}
            tone="accent"
            sub={`service ${CHAIN.serviceId} · blueprint ${CHAIN.blueprintId}`}
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
          {operators.isError && (
            <div className="px-4 py-8 text-center font-data text-[13px] text-[var(--s-text-muted)]">
              Chain read failed — check RPC connectivity.
            </div>
          )}
          {operators.isLoading && (
            <div className="px-4 py-8 text-center font-data text-[13px] text-[var(--s-text-muted)]">
              Reading service operator set…
            </div>
          )}
          {addrs.map((addr, i) => {
            const bond = bonds.data?.[i]?.result as bigint | undefined
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
                    {i === 0 && <Badge tone="accent">quoting</Badge>}
                  </div>
                  <div className="mt-0.5 font-data text-[12px] text-[var(--s-text-muted)]">
                    {i === 0 ? `serves the venue API · ${VENUE_URL.replace('https://', '')}` : 'joined the operator set on-chain'}
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
                  <div className="font-data text-[11px] tabular-nums text-[var(--s-text-muted)]">
                    {issuerFunds.data?.[i * 2 + 1]?.result !== undefined
                      ? `liability ${compactUsd(Number(issuerFunds.data[i * 2 + 1]!.result))}`
                      : ''}
                  </div>
                </div>
              </div>
            )
          })}
        </Panel>

        <div className={cn('panel mt-4 px-4 py-3 font-data text-[13px] text-[var(--s-text-muted)]')}>
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
