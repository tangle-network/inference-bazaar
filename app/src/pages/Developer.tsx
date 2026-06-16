import { useState } from 'react'
import { useAccount, useReadContract, useSignTypedData } from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import type { Address, Hex } from 'viem'
import { PageHeader } from '~/components/PageHeader'
import { ApiKeyMint } from '~/components/ApiKeyMint'
import { CodeBlock } from '~/components/CodeBlock'
import { Badge, Panel, Segmented, Stat } from '~/components/ui'
import { compactUsd, tokens, truncAddr } from '~/lib/format'
import { CHAIN, ROUTER_URL, VENUE_URL } from '~/lib/api'
import {
  EIP712_DOMAIN,
  SETTLEMENT,
  SETTLEMENT_ABI,
  USAGE_QUERY_TYPES,
  fetchVenueUsage,
  useMyLots,
  type CreditLot,
  type MeterRow,
} from '~/lib/settlement'
import { useVenueRegistry, endpointFor, type Venue } from '~/lib/venues'
import { privacyOn } from '~/lib/privacy'

type Tab = 'gateway' | 'router' | 'tcloud'

/** Three ways to spend credits over the API. Each tab is the real integration
 * for that path; availability is tagged honestly — the router credit-debit and
 * the tcloud SDK surface are still rolling out, so they're marked, not faked. */
const TABS: Record<Tab, { label: string; badge: { tone: 'emerald' | 'amber'; text: string }; note: string; code: string }> = {
  gateway: {
    label: 'Gateway',
    badge: { tone: 'emerald', text: 'Live' },
    note: 'Zero trust — the gateway runs on your machine and holds the session key; the operator can never bill more than it signs.',
    code: `from openai import OpenAI

# 1. mint a key below, then run the gateway with it:
#    inference-bazaar-gateway
# 2. point any OpenAI client at the local gateway — no wallet in the request path:
client = OpenAI(base_url="http://127.0.0.1:8088/v1", api_key="sk-inference-bazaar")

resp = client.chat.completions.create(
    model="anthropic/claude-opus-4-8",
    messages=[{"role": "user", "content": "hello"}],
)`,
  },
  router: {
    label: 'Router',
    badge: { tone: 'amber', text: 'Credits rolling out' },
    note: 'One endpoint for every model on Tangle. The endpoint is live; auto-spending your held credit lots through it is rolling out — today route via your platform balance or shielded credits.',
    code: `from openai import OpenAI

# The Tangle Router — one base URL for every model, routed to a bonded operator.
client = OpenAI(base_url="${ROUTER_URL}/v1", api_key="tngl-...")

resp = client.chat.completions.create(
    model="anthropic/claude-opus-4-8",
    messages=[{"role": "user", "content": "hello"}],
)`,
  },
  tcloud: {
    label: 'tcloud',
    badge: { tone: 'amber', text: 'Preview · tcloud#41' },
    note: 'The tcloud buyer SDK: `pricing` picks how you pay. credits spends your discounted lots soonest-expiry-first; market/limit cap the price you accept.',
    code: `import { chat } from "@tangle-network/tcloud"

const res = await chat({
  model: "anthropic/claude-opus-4-8",
  messages: [{ role: "user", content: "hello" }],
  pricing: { credits: true, mode: "market" },
})`,
  },
}

function Quickstart() {
  const [tab, setTab] = useState<Tab>('gateway')
  const t = TABS[tab]
  return (
    <Panel className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-[17px] font-semibold text-[var(--s-text)]">Connect your app</h2>
        <Segmented
          size="sm"
          value={tab}
          onChange={setTab}
          options={(Object.keys(TABS) as Tab[]).map((k) => ({ value: k, label: TABS[k].label }))}
        />
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <Badge tone={t.badge.tone}>{t.badge.text}</Badge>
        <span className="font-body text-[15px] text-[var(--s-text-muted)]">{t.note}</span>
      </div>
      <CodeBlock code={t.code} className="mt-3" />
    </Panel>
  )
}

/** The venue that issued a lot — its operator is the only one that meters it. */
function venueUrlForLot(lot: CreditLot, venues: Venue[] | undefined): string {
  const issuer = venues?.find(
    (v) => v.healthy && v.operator.toLowerCase() === lot.issuer.toLowerCase(),
  )
  return issuer ? endpointFor(issuer, privacyOn()) : VENUE_URL
}

/** On-chain draw-down (settled). When a signed live read is present, the
 * vouchered-but-unsettled `inflight` is shown too — it's the spend the chain
 * can't see yet. */
function SpendMeter({ lot, live }: { lot: CreditLot; live?: MeterRow }) {
  const filled = Number(lot.filledTokens)
  const spendable = Number(lot.qtyTokens - lot.lockedTokens)
  const locked = Number(lot.lockedTokens)
  const spent = Math.max(0, filled - Number(lot.qtyTokens))
  const pctSpent = filled > 0 ? Math.min(100, (spent / filled) * 100) : 0
  const pctLocked = filled > 0 ? Math.min(100 - pctSpent, (locked / filled) * 100) : 0
  const pctInflight =
    live && filled > 0 ? Math.min(100 - pctSpent - pctLocked, (live.inflightTokens / filled) * 100) : 0
  return (
    <div className="w-full">
      <div className="flex items-baseline justify-between font-data text-[15px]">
        <span className="text-[var(--s-emerald)]">{tokens(spendable)} left</span>
        <span className="text-[var(--s-text-muted)]">
          {tokens(spent)} spent of {tokens(filled)}
          {live && live.inflightTokens > 0 && (
            <span className="text-[var(--s-accent)]"> · {tokens(live.inflightTokens)} in-flight</span>
          )}
        </span>
      </div>
      <div className="mt-1.5 flex h-1.5 w-full overflow-hidden rounded-full bg-[var(--s-emerald-soft)]">
        <span className="h-full bg-[var(--s-text-muted)]" style={{ width: `${pctSpent}%` }} />
        <span className="h-full bg-[var(--s-amber)]" style={{ width: `${pctLocked}%` }} />
        <span className="h-full bg-[var(--s-accent)]" style={{ width: `${pctInflight}%` }} />
      </div>
    </div>
  )
}

function LotKey({ lot, venueUrl, live }: { lot: CreditLot; venueUrl: string; live?: MeterRow }) {
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
        <SpendMeter lot={lot} live={live} />
      </div>
      <div className="shrink-0">
        <ApiKeyMint lot={lot} venueUrl={venueUrl} />
      </div>
    </Panel>
  )
}

/**
 * Holder-signed read of live spend across every venue the holder has lots with.
 * ONE signature (UsageQuery is venue-independent) is fanned out to each distinct
 * venue; an unreachable venue is skipped, not fatal. Returns rows keyed by lotId.
 */
function useLiveUsage(address: Address | undefined) {
  const { signTypedDataAsync } = useSignTypedData()
  const [rows, setRows] = useState<Map<Hex, MeterRow> | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function sync(lots: CreditLot[], venues: Venue[] | undefined) {
    if (!address) return
    setSyncing(true)
    setError(null)
    try {
      const expiry = Math.floor(Date.now() / 1000) + 300
      const sig = (await signTypedDataAsync({
        domain: EIP712_DOMAIN,
        types: USAGE_QUERY_TYPES,
        primaryType: 'UsageQuery',
        message: { holder: address, expiry: BigInt(expiry) },
      })) as Hex
      const urls = [...new Set(lots.map((l) => venueUrlForLot(l, venues)))]
      const merged = new Map<Hex, MeterRow>()
      const results = await Promise.allSettled(
        urls.map((u) => fetchVenueUsage(u, address, expiry, sig)),
      )
      for (const r of results) {
        if (r.status === 'fulfilled') for (const [k, v] of r.value) merged.set(k, v)
      }
      if (merged.size === 0 && results.every((r) => r.status === 'rejected')) {
        throw new Error('no venue could be reached')
      }
      setRows(merged)
    } catch (e) {
      setError(e instanceof Error ? e.message.split('\n')[0]! : String(e))
    } finally {
      setSyncing(false)
    }
  }

  return { rows, syncing, error, sync }
}

/**
 * The developer surface: credits as an API. On-chain balances and spend are read
 * straight from the chain (filled − remaining), so they can't drift from what the
 * settlement contract enforces. "Sync live usage" signs a UsageQuery and overlays
 * the real-time, vouchered-but-unsettled spend the chain can't show yet.
 */
export default function DeveloperPage() {
  const { address, isConnected } = useAccount()
  const lots = useMyLots(address)
  const registry = useVenueRegistry()
  const meter = useLiveUsage(address)
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
  const liveKeys = all.filter((l) => l.qtyTokens - l.lockedTokens > 0n && Number(l.expiry) * 1000 > Date.now())
  const inflight = meter.rows ? [...meter.rows.values()].reduce((n, r) => n + r.inflightTokens, 0) : null

  return (
    <div>
      <PageHeader
        title="Developer"
        subtitle="Your inference credits, as an OpenAI-compatible API."
        right={
          all.length > 0 ? (
            <button
              onClick={() => void meter.sync(all, registry.data)}
              disabled={meter.syncing}
              className="btn-secondary h-9 whitespace-nowrap"
              title="Sign a read-only query to fetch live, unsettled spend from your operators"
            >
              <span className={meter.syncing ? 'i-ph:circle-notch animate-spin text-[16px]' : 'i-ph:pulse text-[16px]'} />
              {meter.syncing ? 'Signing…' : meter.rows ? 'Refresh live usage' : 'Sync live usage'}
            </button>
          ) : undefined
        }
      />

      <div className="px-4 py-4 sm:px-6">
        <div className="panel grid grid-cols-2 divide-x divide-[var(--s-divider)] sm:grid-cols-4">
          <Stat label="Credits left" value={lots.isLoading ? '…' : tokens(remaining)} tone="emerald" sub="spendable tokens" />
          <Stat
            label="Spent"
            value={lots.isLoading ? '…' : tokens(spent)}
            sub={inflight != null && inflight > 0 ? `+${tokens(inflight)} in-flight` : 'drawn down on-chain'}
          />
          <Stat label="Active keys" value={lots.isLoading ? '…' : liveKeys.length} tone="accent" sub="usable lots" />
          <Stat
            label="Settlement balance"
            value={settlementBalance.data !== undefined ? compactUsd(Number(settlementBalance.data)) : '…'}
            sub="deposited tsUSD"
          />
        </div>
        {meter.error && (
          <p className="mt-2 font-data text-[12px] text-[var(--s-crimson)]">Live usage: {meter.error}</p>
        )}
      </div>

      <div className="px-4 sm:px-6">
        <Quickstart />
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
              <LotKey
                key={lot.lotId}
                lot={lot}
                venueUrl={venueUrlForLot(lot, registry.data)}
                live={meter.rows?.get(lot.lotId)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
