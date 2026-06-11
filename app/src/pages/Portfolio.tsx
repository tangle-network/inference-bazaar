import { useAccount, useBalance, useReadContract } from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import { formatUnits } from 'viem'
import { Identicon } from '@tangle-network/blueprint-ui/components'
import type { Address } from 'viem'
import { PageHeader } from '~/components/PageHeader'
import { Panel, Stat } from '~/components/ui'
import { truncAddr } from '~/lib/format'
import { CHAIN } from '~/lib/api'

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
        <div className="panel grid grid-cols-2 divide-x divide-[var(--s-divider)] sm:grid-cols-3">
          <Stat
            label="ETH"
            value={eth.data ? Number(formatUnits(eth.data.value, eth.data.decimals)).toFixed(4) : '…'}
            tone="accent"
            sub="gas on Base Sepolia"
          />
          <Stat
            label="TNT"
            value={
              tnt.data !== undefined ? Number(formatUnits(tnt.data as bigint, 18)).toLocaleString() : '…'
            }
            sub="restaking asset"
          />
          <Stat label="Network" value="Base Sepolia" sub={`#${CHAIN.id}`} />
        </div>

        <Panel className="mt-4" title="Credits">
          <div className="px-4 py-10 text-center">
            <p className="font-data text-[13px] text-[var(--s-text-muted)]">
              No credits held yet. Fills you make on the venue settle into collateral-backed credit
              lots through the settlement spine — they'll appear here with their strike, remaining
              quota, and expiry.
            </p>
          </div>
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
