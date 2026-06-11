import { useState } from 'react'
import {
  useAccount,
  useBalance,
  usePublicClient,
  useReadContract,
  useSignTypedData,
  useWriteContract,
} from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import { formatUnits, keccak256, toBytes } from 'viem'
import { Identicon } from '@tangle-network/blueprint-ui/components'
import type { Address, Hex } from 'viem'
import { PageHeader } from '~/components/PageHeader'
import { Panel, Stat } from '~/components/ui'
import { compactUsd, tokens, truncAddr } from '~/lib/format'
import { CHAIN, useInstruments, VENUE_URL } from '~/lib/api'
import {
  EIP712_DOMAIN,
  instrumentHash,
  RECEIPT_TYPES,
  SERVE_DOMAIN,
  SERVE_TYPES,
  SETTLEMENT,
  SETTLEMENT_ABI,
  useMyLots,
  type CreditLot,
} from '~/lib/settlement'
import { useVenueRegistry } from '~/lib/venues'

const REDEEM_ABI = [
  { type: 'function', name: 'requestRedemption', inputs: [{ name: 'lotId', type: 'bytes32' }, { name: 'qty', type: 'uint64' }], outputs: [{ name: '', type: 'bytes32' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'openRedemptionOf', inputs: [{ name: 'lotId', type: 'bytes32' }], outputs: [{ name: '', type: 'bytes32' }], stateMutability: 'view' },
] as const

/**
 * The whole consumption loop, in-wallet: open a redemption on the lot, sign
 * the EIP-712 serve authorization, get a real completion from the issuing
 * operator (through the Tangle Router), sign the receipt, settle on-chain.
 */
function SpendLot({ lot }: { lot: CreditLot }) {
  const client = usePublicClient({ chainId: CHAIN.id })
  const { writeContractAsync } = useWriteContract()
  const { signTypedDataAsync } = useSignTypedData()
  const registry = useVenueRegistry()
  const [redemptionId, setRedemptionId] = useState<Hex | null>(null)
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [served, setServed] = useState<{ text: string; servedTokens: number } | null>(null)

  // Serve calls go to the operator that issued the lot — its venue is the
  // only one that can meter this credit.
  const venueUrl =
    registry.data?.find((v) => v.healthy && v.operator.toLowerCase() === lot.issuer.toLowerCase())
      ?.url ?? VENUE_URL

  async function open() {
    setBusy('Opening redemption…')
    setError(null)
    try {
      const existing = (await client!.readContract({
        address: SETTLEMENT.address, abi: REDEEM_ABI, functionName: 'openRedemptionOf', args: [lot.lotId],
      })) as Hex
      if (existing !== `0x${'0'.repeat(64)}`) {
        setRedemptionId(existing)
        return
      }
      const qty = lot.qtyTokens - lot.lockedTokens
      const tx = await writeContractAsync({
        address: SETTLEMENT.address, abi: REDEEM_ABI, functionName: 'requestRedemption',
        args: [lot.lotId, qty], chainId: CHAIN.id,
      })
      await client!.waitForTransactionReceipt({ hash: tx })
      const rid = (await client!.readContract({
        address: SETTLEMENT.address, abi: REDEEM_ABI, functionName: 'openRedemptionOf', args: [lot.lotId],
      })) as Hex
      setRedemptionId(rid)
    } catch (e) {
      setError(e instanceof Error ? e.message.split('\n')[0]! : String(e))
    } finally {
      setBusy(null)
    }
  }

  async function serve() {
    if (!redemptionId || !prompt.trim()) return
    setBusy('Authorize in wallet…')
    setError(null)
    try {
      const messages = [{ role: 'user', content: prompt.trim() }]
      const maxTokens = 300
      const expiry = BigInt(Math.floor(Date.now() / 1000) + 300)
      const signature = await signTypedDataAsync({
        domain: SERVE_DOMAIN,
        types: SERVE_TYPES,
        primaryType: 'ServeRequest',
        message: {
          redemptionId,
          messagesHash: keccak256(toBytes(JSON.stringify(messages))),
          maxTokens: BigInt(maxTokens),
          expiry,
        },
      })
      setBusy('Serving from your credit…')
      const res = await fetch(`${venueUrl}/redeem`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redemptionId, messages, maxTokens, auth: { expiry: Number(expiry), signature } }),
      })
      if (!res.ok) throw new Error(await res.text())
      const out = await res.json()
      const text: string = out.completion?.choices?.[0]?.message?.content ?? ''
      setBusy('Sign the receipt…')
      const receiptSig = await signTypedDataAsync({
        domain: EIP712_DOMAIN,
        types: RECEIPT_TYPES,
        primaryType: 'RedemptionReceipt',
        message: { redemptionId, servedTokens: BigInt(out.totalServedTokens) },
      })
      setBusy('Settling on-chain…')
      const res2 = await fetch(`${venueUrl}/redeem/receipt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redemptionId, servedTokens: out.totalServedTokens, signature: receiptSig }),
      })
      if (!res2.ok) throw new Error(await res2.text())
      setServed({ text, servedTokens: Number(out.totalServedTokens) })
      setRedemptionId(null)
    } catch (e) {
      setError(e instanceof Error ? e.message.split('\n')[0]! : String(e))
    } finally {
      setBusy(null)
    }
  }

  if (served) {
    return (
      <div className="w-full rounded-[8px] border border-[var(--s-emerald)]/25 bg-[var(--s-emerald-soft)] px-3 py-2.5">
        <p className="whitespace-pre-wrap font-body text-[13px] leading-relaxed text-[var(--s-text)]">{served.text}</p>
        <div className="mt-1.5 font-data text-[12px] text-[var(--s-emerald)]">
          {served.servedTokens} tokens debited at your locked strike — settled on-chain.
        </div>
      </div>
    )
  }
  if (redemptionId) {
    return (
      <div className="flex w-full items-center gap-2">
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !busy && serve()}
          placeholder="Ask anything — billed to this credit"
          className="h-10 flex-1 rounded-[8px] border border-[var(--s-border)] bg-[var(--s-glass)] px-3 font-body text-[14px] text-[var(--s-text)] placeholder:text-[var(--s-text-subtle)] focus-ring"
        />
        <button onClick={serve} disabled={!!busy || !prompt.trim()} className="btn-primary h-10 shrink-0">
          {busy ?? 'Run'}
        </button>
        {error && <span className="w-full font-data text-[11px] text-[var(--s-crimson)]">{error}</span>}
      </div>
    )
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <button onClick={open} disabled={!!busy} className="btn-primary h-9">
        {busy ?? 'Spend'}
      </button>
      {error && <span className="font-data text-[11px] text-[var(--s-crimson)]">{error}</span>}
    </div>
  )
}

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
                <SpendLot lot={lot} />
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
