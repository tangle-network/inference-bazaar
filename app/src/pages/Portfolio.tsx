import { useAccount, useBalance, useReadContract } from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import { formatUnits } from 'viem'
import { Identicon } from '@tangle-network/blueprint-ui/components'
import type { Address } from 'viem'
import { PageHeader } from '~/components/PageHeader'
import { Panel, Stat } from '~/components/ui'
import { compactUsd, tokens, truncAddr } from '~/lib/format'
import { CHAIN, useInstruments } from '~/lib/api'
import { instrumentHash, SETTLEMENT, SETTLEMENT_ABI, useMyLots } from '~/lib/settlement'

const ERC20_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const

/** Wallet truth only: live balances on Base Sepolia, no invented positions. */
export default function PortfolioPage() {
  const { address, isConnected } = useAccount()
  const eth = useBalance({ address, chainId: CHAIN.id })
  const tnt = useReadContract({
    address: CHAIN.tnt,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: CHAIN.id,
    query: { enabled: !!address },
  })
  const settlementBalance = useReadContract({
    address: SETTLEMENT.address,
    abi: SETTLEMENT_ABI,
    functionName: 'balances',
    args: address ? [address] : undefined,
    chainId: CHAIN.id,
    query: { enabled: !!address },
  })
  const lots = useMyLots(address)
  const instruments = useInstruments()

  if (!isConnected || !address) {
    return (
      <div>
        <PageHeader title="Portfolio" subtitle="Your balances and credits, read from the chain." />
        <div className="flex flex-col items-center gap-4 px-6 py-20 text-center">
          <span className="i-ph:wallet text-[40px] text-[var(--s-text-subtle)]" />
          <p className="max-w-sm font-body text-[14px] text-[var(--s-text-muted)]">
            Connect to see live Base Sepolia balances and your fills on the venue.
          </p>
          <ConnectKitButton.Custom>
            {({ show }) => (
              <button onClick={show} className="btn-primary h-11">
                <span className="i-ph:wallet text-[16px]" /> Connect wallet
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
        title="Portfolio"
        subtitle="Live Base Sepolia balances for the connected wallet."
        right={
          <span className="flex items-center gap-2 rounded-[8px] border border-[var(--s-border)] px-3 py-1.5">
            <span className="overflow-hidden rounded-full">
              <Identicon address={address as Address} size={20} />
            </span>
            <span className="font-data text-[13px] text-[var(--s-text-secondary)]">{truncAddr(address)}</span>
          </span>
        }
      />

      <div className="px-4 py-4 sm:px-6">
        <div className="panel grid grid-cols-2 divide-x divide-[var(--s-divider)] sm:grid-cols-4">
          <Stat
            label="Settlement balance"
            value={settlementBalance.data !== undefined ? compactUsd(Number(settlementBalance.data)) : '…'}
            tone="accent"
            sub="deposited tsUSD"
          />
          <Stat
            label="Credit lots"
            value={lots.isLoading ? '…' : (lots.data?.length ?? 0)}
            tone="emerald"
            sub="held on-chain"
          />
          <Stat
            label="ETH"
            value={eth.data ? Number(formatUnits(eth.data.value, eth.data.decimals)).toFixed(4) : '…'}
            sub="gas"
          />
          <Stat
            label="TNT"
            value={
              tnt.data !== undefined ? Number(formatUnits(tnt.data as bigint, 18)).toLocaleString() : '…'
            }
            sub="restaking asset"
          />
        </div>

        <Panel className="mt-4" title="Credit lots — on-chain">
          {lots.isLoading && (
            <div className="px-4 py-8 text-center font-data text-[13px] text-[var(--s-text-muted)]">
              Scanning SurplusSettlement fills…
            </div>
          )}
          {lots.isSuccess && (lots.data?.length ?? 0) === 0 && (
            <div className="px-4 py-8 text-center font-data text-[13px] text-[var(--s-text-muted)]">
              No credit lots in this wallet. A firm buy settles into a lot here, with its quantity,
              cost basis, expiry, and issuer.
            </div>
          )}
          {(lots.data ?? []).map((lot) => {
            const inst = (instruments.data ?? []).find((i) => instrumentHash(i.id) === lot.instrument)
            return (
              <div key={lot.lotId} className="flex flex-wrap items-center gap-4 border-b border-[var(--s-divider)] px-4 py-3.5 font-data text-[14px] last:border-0">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-[var(--s-text)]">{inst?.id ?? `${lot.instrument.slice(0, 18)}…`}</div>
                  <div className="mt-0.5 text-[12px] text-[var(--s-text-muted)]">
                    issuer {truncAddr(lot.issuer)} ·{' '}
                    {Number(lot.expiry) * 1000 > Date.now()
                      ? `expires in ${Math.max(1, Math.round((Number(lot.expiry) * 1000 - Date.now()) / 86_400_000))}d`
                      : 'expired — refund claimable'}
                  </div>
                </div>
                <div className="text-right">
                  <div className="tabular-nums font-bold text-[var(--s-text)]">{tokens(Number(lot.qtyTokens))} tok</div>
                  <div className="text-[12px] tabular-nums text-[var(--s-text-muted)]">basis {compactUsd(Number(lot.notionalMicro))}</div>
                </div>
                <a
                  className="font-data text-[12px] text-[var(--s-accent)] hover:underline"
                  href={`${CHAIN.explorer}/tx/${lot.txHash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  settlement tx ↗
                </a>
              </div>
            )
          })}
        </Panel>

        <Panel className="mt-4" title="On-chain">
          <div className="grid gap-1 px-4 py-4 font-data text-[14px]">
            <a
              className="text-[var(--s-accent)] hover:underline"
              href={`${CHAIN.explorer}/address/${address}`}
              target="_blank"
              rel="noreferrer"
            >
              Your address on Basescan ↗
            </a>
          </div>
        </Panel>
      </div>
    </div>
  )
}
