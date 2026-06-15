import { useState } from 'react'
import { useAccount, useReadContract } from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import { PageHeader } from '~/components/PageHeader'
import { ApiKeyMint } from '~/components/ApiKeyMint'
import { Panel, Stat } from '~/components/ui'
import { compactUsd, tokens, truncAddr } from '~/lib/format'
import { CHAIN, VENUE_URL } from '~/lib/api'
import { SETTLEMENT, SETTLEMENT_ABI, useMyLots, type CreditLot } from '~/lib/settlement'
import { useVenueRegistry, endpointFor } from '~/lib/venues'
import { privacyOn } from '~/lib/privacy'

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => { void navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
      className="font-data text-[15px] font-semibold text-[var(--s-accent)] hover:underline"
    >
      {copied ? 'copied ✓' : 'copy'}
    </button>
  )
}

/** What a credit lot has drawn down vs what it was minted with — both on-chain. */
function SpendMeter({ lot }: { lot: CreditLot }) {
  const filled = Number(lot.filledTokens)
  const spendable = Number(lot.qtyTokens - lot.lockedTokens)
  const locked = Number(lot.lockedTokens)
  const spent = Math.max(0, filled - Number(lot.qtyTokens))
  const pctSpent = filled > 0 ? Math.min(100, (spent / filled) * 100) : 0
  const pctLocked = filled > 0 ? Math.min(100 - pctSpent, (locked / filled) * 100) : 0
  return (
    <div className="w-full">
      <div className="flex items-baseline justify-between font-data text-[15px]">
        <span className="text-[var(--s-emerald)]">{tokens(spendable)} left</span>
        <span className="text-[var(--s-text-muted)]">{tokens(spent)} spent of {tokens(filled)}</span>
      </div>
      <div className="mt-1.5 flex h-1.5 w-full overflow-hidden rounded-full bg-[var(--s-emerald-soft)]">
        <span className="h-full bg-[var(--s-text-muted)]" style={{ width: `${pctSpent}%` }} />
        <span className="h-full bg-[var(--s-amber)]" style={{ width: `${pctLocked}%` }} />
      </div>
    </div>
  )
}

function LotKey({ lot }: { lot: CreditLot }) {
  const registry = useVenueRegistry()
  const issuerVenue = registry.data?.find(
    (v) => v.healthy && v.operator.toLowerCase() === lot.issuer.toLowerCase(),
  )
  const venueUrl = issuerVenue ? endpointFor(issuerVenue, privacyOn()) : VENUE_URL
  const expired = Number(lot.expiry) * 1000 < Date.now()
  return (
    <Panel bodyClassName="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-center gap-2 font-data text-[15px] text-[var(--s-text-secondary)]">
          <span className="i-ph:hard-drives shrink-0 text-[16px] text-[var(--s-text-muted)]" />
          <a
            href={`${CHAIN.explorer}/address/${lot.issuer}`}
            target="_blank"
            rel="noreferrer"
            className="hover:text-[var(--s-accent)] hover:underline"
          >
            {truncAddr(lot.issuer)}
          </a>
          <span className="text-[var(--s-text-subtle)]">·</span>
          <span className={expired ? 'text-[var(--s-crimson)]' : 'text-[var(--s-text-muted)]'}>
            {expired ? 'expired' : `expires ${new Date(Number(lot.expiry) * 1000).toLocaleDateString()}`}
          </span>
        </div>
        <SpendMeter lot={lot} />
      </div>
      <div className="shrink-0">
        <ApiKeyMint lot={lot} venueUrl={venueUrl} />
      </div>
    </Panel>
  )
}

const QUICKSTART = `from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8088/v1", api_key="sk-inference-bazaar")
resp = client.chat.completions.create(
    model="anthropic/claude-opus-4-8",
    messages=[{"role": "user", "content": "hello"}],
)`

/**
 * The developer surface: credits as an API. Balances and spend are read straight
 * from the chain (filled − remaining), so the numbers can't drift from what the
 * settlement contract enforces. Per-call telemetry (calls/USD) is a follow-up
 * served by the operator meter through the Tangle Router — not faked here.
 */
export default function DeveloperPage() {
  const { address, isConnected } = useAccount()
  const lots = useMyLots(address)
  const settlementBalance = useReadContract({
    address: SETTLEMENT.address,
    abi: SETTLEMENT_ABI,
    functionName: 'balances',
    args: address ? [address] : undefined,
    chainId: CHAIN.id,
    query: { enabled: !!address },
  })

  if (!isConnected || !address) {
    return (
      <div>
        <PageHeader title="Developer" subtitle="Your inference credits, as an OpenAI-compatible API." />
        <div className="flex flex-col items-center gap-4 px-6 py-20 text-center">
          <span className="i-ph:code text-[44px] text-[var(--s-text-subtle)]" />
          <p className="max-w-sm font-body text-[15px] text-[var(--s-text-muted)]">
            Connect to mint API keys from your credit lots and watch them draw down on-chain.
          </p>
          <ConnectKitButton.Custom>
            {({ show }) => (
              <button onClick={show} className="btn-primary h-11">
                <span className="i-ph:wallet text-[18px]" /> Connect wallet
              </button>
            )}
          </ConnectKitButton.Custom>
        </div>
      </div>
    )
  }

  const all = lots.data ?? []
  const remaining = all.reduce((n, l) => n + Number(l.qtyTokens - l.lockedTokens), 0)
  const spent = all.reduce((n, l) => n + Math.max(0, Number(l.filledTokens - l.qtyTokens)), 0)
  const live = all.filter((l) => l.qtyTokens - l.lockedTokens > 0n && Number(l.expiry) * 1000 > Date.now())

  return (
    <div>
      <PageHeader title="Developer" subtitle="Your inference credits, as an OpenAI-compatible API." />

      <div className="px-4 py-4 sm:px-6">
        <div className="panel grid grid-cols-2 divide-x divide-[var(--s-divider)] sm:grid-cols-4">
          <Stat label="Credits left" value={lots.isLoading ? '…' : tokens(remaining)} tone="emerald" sub="spendable tokens" />
          <Stat label="Spent" value={lots.isLoading ? '…' : tokens(spent)} sub="drawn down on-chain" />
          <Stat label="Active keys" value={lots.isLoading ? '…' : live.length} tone="accent" sub="usable lots" />
          <Stat
            label="Settlement balance"
            value={settlementBalance.data !== undefined ? compactUsd(Number(settlementBalance.data)) : '…'}
            sub="deposited tsUSD"
          />
        </div>
      </div>

      <div className="px-4 sm:px-6">
        <Panel className="p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-display text-[17px] font-semibold text-[var(--s-text)]">Quickstart</h2>
            <CopyButton text={QUICKSTART} />
          </div>
          <p className="mt-1 font-body text-[15px] text-[var(--s-text-muted)]">
            Mint a key below, run the gateway with it, then call it like any OpenAI endpoint.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-[8px] bg-[var(--s-bg)]/60 px-4 py-3 font-data text-[15px] leading-relaxed text-[var(--s-text)]">
            {QUICKSTART}
          </pre>
        </Panel>
      </div>

      <div className="px-4 py-4 sm:px-6">
        <h2 className="mb-2 font-display text-[17px] font-semibold text-[var(--s-text)]">API keys</h2>
        {lots.isLoading ? (
          <p className="px-1 py-6 font-body text-[15px] text-[var(--s-text-muted)]">Reading your lots from the chain…</p>
        ) : all.length === 0 ? (
          <Panel bodyClassName="flex flex-col items-center gap-3 px-6 py-12 text-center">
            <span className="i-ph:key text-[36px] text-[var(--s-text-subtle)]" />
            <p className="max-w-sm font-body text-[15px] text-[var(--s-text-muted)]">
              No credit lots yet. Buy discounted inference, then mint a key here to spend it over the API.
            </p>
            <a href="/" className="btn-primary h-10">
              <span className="i-ph:lightning text-[16px]" /> Buy inference
            </a>
          </Panel>
        ) : (
          <div className="flex flex-col gap-3">
            {all.map((lot) => (
              <LotKey key={lot.lotId} lot={lot} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
