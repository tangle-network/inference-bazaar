import { Link } from 'react-router-dom'
import { useAccount, useReadContract, useWaitForTransactionReceipt, useWriteContract } from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import { formatUnits, parseUnits } from 'viem'
import { PageHeader } from '~/components/PageHeader'
import { Panel } from '~/components/ui'
import { cn } from '~/lib/cn'
import { CHAIN, VENUE_URL } from '~/lib/api'

const TNT_ABI = [
  { type: 'function', name: 'approve', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'allowance', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'balanceOf', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const

const STAKING_ABI = [
  { type: 'function', name: 'registerOperatorWithAsset', inputs: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'isOperator', inputs: [{ name: 'operator', type: 'address' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
] as const

const BOND = parseUnits('10000', 18) // 10k TNT — what the live operators bonded

/**
 * Real onboarding: the wallet performs the actual on-chain steps the two live
 * operators went through — approve TNT, bond into restaking — then the
 * runtime command registers for the blueprint and serves.
 */
export default function OperatorRegisterPage() {
  const { address, isConnected } = useAccount()
  const tntBalance = useReadContract({
    address: CHAIN.tnt, abi: TNT_ABI, functionName: 'balanceOf',
    args: address ? [address] : undefined, chainId: CHAIN.id, query: { enabled: !!address },
  })
  const allowance = useReadContract({
    address: CHAIN.tnt, abi: TNT_ABI, functionName: 'allowance',
    args: address ? [address, CHAIN.staking] : undefined, chainId: CHAIN.id, query: { enabled: !!address },
  })
  const isOp = useReadContract({
    address: CHAIN.staking, abi: STAKING_ABI, functionName: 'isOperator',
    args: address ? [address] : undefined, chainId: CHAIN.id, query: { enabled: !!address },
  })

  const approve = useWriteContract()
  const bond = useWriteContract()
  const approveRcpt = useWaitForTransactionReceipt({ hash: approve.data, chainId: CHAIN.id })
  const bondRcpt = useWaitForTransactionReceipt({ hash: bond.data, chainId: CHAIN.id })

  const approved = (allowance.data as bigint | undefined ?? 0n) >= BOND || approveRcpt.isSuccess
  const bonded = isOp.data === true || bondRcpt.isSuccess
  const hasTnt = (tntBalance.data as bigint | undefined ?? 0n) >= BOND

  return (
    <div>
      <PageHeader
        title="Become an operator"
        subtitle="Bond restake, register for the blueprint, run the venue. The same path the live operator set took."
        right={
          <Link to="/operators" className="btn-secondary h-10">
            Operator set
          </Link>
        }
      />

      <div className="grid grid-cols-1 gap-4 px-4 py-4 sm:px-6 lg:grid-cols-2">
        <Panel title="Bond 10,000 TNT — from your wallet">
          <div className="px-4 py-4">
            {!isConnected ? (
              <ConnectKitButton.Custom>
                {({ show }) => (
                  <button onClick={show} className="btn-primary h-11 w-full">
                    <span className="i-ph:wallet text-[18px]" /> Connect wallet
                  </button>
                )}
              </ConnectKitButton.Custom>
            ) : bonded ? (
              <div className="rounded-[8px] border border-[var(--s-emerald)]/30 bg-[var(--s-emerald-soft)] px-3 py-3 font-data text-[15px] text-[var(--s-emerald)]">
                This wallet is a registered restaking operator.
              </div>
            ) : (
              <div className="grid gap-2.5">
                <div className="flex items-center justify-between font-data text-[15px]">
                  <span className="text-[var(--s-text-muted)]">Your TNT</span>
                  <span className={cn('tabular-nums font-semibold', hasTnt ? 'text-[var(--s-text)]' : 'text-[var(--s-crimson)]')}>
                    {tntBalance.data !== undefined
                      ? Number(formatUnits(tntBalance.data as bigint, 18)).toLocaleString()
                      : '…'}{' '}
                    / 10,000 required
                  </span>
                </div>
                <button
                  onClick={() =>
                    approve.writeContract({
                      address: CHAIN.tnt, abi: TNT_ABI, functionName: 'approve',
                      args: [CHAIN.staking, BOND], chainId: CHAIN.id,
                    })
                  }
                  disabled={!hasTnt || approved || approve.isPending || approveRcpt.isLoading}
                  className="btn-secondary h-11 w-full"
                >
                  {approved ? '✓ TNT approved' : approve.isPending || approveRcpt.isLoading ? 'Approving…' : 'Approve 10,000 TNT'}
                </button>
                <button
                  onClick={() =>
                    bond.writeContract({
                      address: CHAIN.staking, abi: STAKING_ABI, functionName: 'registerOperatorWithAsset',
                      args: [CHAIN.tnt, BOND], chainId: CHAIN.id,
                    })
                  }
                  disabled={!approved || bond.isPending || bondRcpt.isLoading}
                  className="btn-primary h-11 w-full"
                >
                  {bond.isPending || bondRcpt.isLoading ? 'Bonding…' : 'Bond into restaking'}
                </button>
                {(approve.error || bond.error) && (
                  <div className="rounded-[8px] border border-[var(--s-crimson)]/30 bg-[var(--s-crimson-soft)] px-3 py-2 font-data text-[15px] text-[var(--s-crimson)]">
                    {(approve.error ?? bond.error)?.message.split('\n')[0]}
                  </div>
                )}
              </div>
            )}
          </div>
        </Panel>

        <Panel title="Run the venue — register + serve">
          <div className="px-4 py-4 font-data text-[15px]">
            <p className="mb-3 font-body text-[15px] leading-relaxed text-[var(--s-text-muted)]">
              With the bond live, register for blueprint {CHAIN.blueprintId} and run the operator
              runtime. It joins the service set, quotes the book, and fulfills redemptions.
            </p>
            <Cmd>cargo tangle blueprint register --blueprint-id {CHAIN.blueprintId} \
  --keystore-path ./keystore</Cmd>
            <Cmd>BLUEPRINT_ID={CHAIN.blueprintId} SERVICE_ID={CHAIN.serviceId} \
TANGLE_CONTRACT={CHAIN.tangle} \
surplus-operator run</Cmd>
            <p className="mt-3 font-body text-[15px] leading-relaxed text-[var(--s-text-muted)]">
              The live reference deployment serves{' '}
              <a className="text-[var(--s-accent)] hover:underline" href={VENUE_URL} target="_blank" rel="noreferrer">
                {VENUE_URL.replace('https://', '')}
              </a>{' '}
              from the blueprint-operators host — systemd units in{' '}
              <span className="text-[var(--s-text-secondary)]">deploy/hetzner/</span>.
            </p>
          </div>
        </Panel>
      </div>
    </div>
  )
}

function Cmd({ children }: { children: React.ReactNode }) {
  return (
    <pre className="mb-2 overflow-x-auto rounded-[8px] border border-[var(--s-border)] bg-[var(--s-bg)] px-3 py-2.5 text-[15px] leading-relaxed text-[var(--s-text-secondary)]">
      {children}
    </pre>
  )
}
