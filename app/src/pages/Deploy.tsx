import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAccount } from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import type { Address } from 'viem'
import { useServiceRequest } from '@tangle-network/blueprint-ui'
import { Identicon } from '@tangle-network/blueprint-ui/components'
import { PageHeader } from '~/components/PageHeader'
import { Badge, Panel, Stat } from '~/components/ui'
import { cn } from '~/lib/cn'
import { truncAddr } from '~/lib/format'
import { CHAIN } from '~/lib/api'
import { useVenueRegistry, type Venue } from '~/lib/venues'

// requestService(uint64,address[],bytes,address[],uint64,address,uint256).
// The bazaar bills through its own settlement layer (prepaid credits), so the
// Services request is filed with no upfront payment; operators read no custom
// config. ttl is in blocks — ~1 day at Base Sepolia's 2s block time.
const REQUEST_TTL_BLOCKS = 43_200n
const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000'

interface OpRow {
  addr: Address
  venue: Venue
}

export default function DeployPage() {
  const { address, isConnected, chain } = useAccount()
  const registry = useVenueRegistry()
  const { requestService, isPending, error, txHash } = useServiceRequest()

  const rows = useMemo<OpRow[]>(() => {
    // Same dedup as the Operators page: one row per operator address, original
    // case preserved so the picked addresses are valid checksum-less Addresses.
    const byAddr = new Map<string, OpRow>()
    for (const v of registry.data ?? []) {
      const key = v.operator.toLowerCase()
      if (!byAddr.has(key)) byAddr.set(key, { addr: v.operator, venue: v })
    }
    return [...byAddr.values()].sort((a, b) => {
      if (a.venue.healthy !== b.venue.healthy) return a.venue.healthy ? -1 : 1
      const la = a.venue.latencyMs ?? Infinity
      const lb = b.venue.latencyMs ?? Infinity
      return la - lb
    })
  }, [registry.data])

  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [done, setDone] = useState<`0x${string}` | null>(null)

  const wrongChain = isConnected && chain?.id !== CHAIN.id
  const healthyAddrs = rows.filter((r) => r.venue.healthy).map((r) => r.addr.toLowerCase())

  function toggle(addr: string) {
    setPicked((prev) => {
      const next = new Set(prev)
      next.has(addr) ? next.delete(addr) : next.add(addr)
      return next
    })
  }

  async function submit() {
    if (!address || picked.size === 0 || isPending) return
    setDone(null)
    const operators = rows.filter((r) => picked.has(r.addr.toLowerCase())).map((r) => r.addr)
    const hash = await requestService({
      blueprintId: BigInt(CHAIN.blueprintId),
      operators,
      config: '0x',
      permittedCallers: [address],
      ttl: REQUEST_TTL_BLOCKS,
      paymentToken: ZERO_ADDRESS,
      paymentAmount: 0n,
    })
    setDone(hash)
  }

  return (
    <div>
      <PageHeader
        title="Request instance"
        subtitle={`Spin up a new Inference Bazaar service on blueprint ${CHAIN.blueprintId}. Pick the operators, sign the request — they approve and their managers spawn the instance.`}
        right={
          <Link to="/operators" className="btn-secondary h-10">
            Operator set
          </Link>
        }
      />

      <div className="px-4 py-4 sm:px-6">
        <div className="panel grid grid-cols-2 divide-x divide-[var(--s-divider)] sm:grid-cols-4">
          <Stat label="Blueprint" value={CHAIN.blueprintId} tone="accent" sub="Inference Bazaar" />
          <Stat label="Chain" value="Base Sepolia" sub={`#${CHAIN.id}`} />
          <Stat
            label="Operators"
            value={registry.isLoading ? '…' : rows.length}
            sub={`${healthyAddrs.length} live`}
          />
          <Stat label="Selected" value={picked.size} tone={picked.size > 0 ? 'emerald' : undefined} />
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
          <Panel title="Pick operators">
            <div className="px-2 py-2">
              {registry.isLoading && (
                <div className="px-2 py-8 text-center font-data text-[15px] text-[var(--s-text-muted)]">
                  Discovering operators across instances…
                </div>
              )}
              {!registry.isLoading && rows.length === 0 && (
                <div className="px-2 py-8 text-center font-data text-[15px] text-[var(--s-text-muted)]">
                  No operators are active for blueprint {CHAIN.blueprintId}.
                </div>
              )}
              {rows.length > 0 && (
                <>
                  <div className="flex items-center justify-between px-2 py-1.5">
                    <span className="mono-label">{picked.size} of {rows.length} selected</span>
                    <button
                      onClick={() =>
                        setPicked((prev) =>
                          healthyAddrs.every((a) => prev.has(a)) ? new Set() : new Set(healthyAddrs),
                        )
                      }
                      className="font-data text-[13px] font-semibold uppercase tracking-wide text-[var(--s-accent)] hover:underline"
                    >
                      {healthyAddrs.every((a) => picked.has(a)) ? 'Clear' : 'Select live'}
                    </button>
                  </div>
                  <ul className="flex flex-col gap-0.5">
                    {rows.map((row) => {
                      const key = row.addr.toLowerCase()
                      const on = picked.has(key)
                      return (
                        <li key={row.addr}>
                          <label
                            className={cn(
                              'flex cursor-pointer items-center gap-3 rounded-[8px] px-2 py-2.5 transition-colors',
                              on ? 'bg-[var(--s-accent-soft)]' : 'hover:bg-[var(--s-panel)]',
                            )}
                          >
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={() => toggle(key)}
                              className="h-4 w-4 accent-[var(--s-accent)]"
                            />
                            <span className="overflow-hidden rounded-full ring-1 ring-[var(--s-border)]">
                              <Identicon address={row.addr} size={32} />
                            </span>
                            <a
                              href={`${CHAIN.explorer}/address/${row.addr}`}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="font-data text-[15px] font-semibold text-[var(--s-text)] hover:text-[var(--s-accent)]"
                            >
                              {truncAddr(row.addr)}
                            </a>
                            <span className="ml-auto flex items-center gap-1.5">
                              {row.venue.healthy ? (
                                <Badge tone="accent">live</Badge>
                              ) : (
                                <Badge>offline</Badge>
                              )}
                              {row.venue.latencyMs != null && row.venue.healthy && (
                                <span className="font-data text-[13px] tabular-nums text-[var(--s-text-muted)]">
                                  {row.venue.latencyMs}ms
                                </span>
                              )}
                            </span>
                          </label>
                        </li>
                      )
                    })}
                  </ul>
                </>
              )}
            </div>
          </Panel>

          <Panel title="Request summary">
            <div className="flex flex-col gap-3 px-4 py-4 font-data text-[15px]">
              <SummaryRow label="Blueprint">
                <span className="tabular-nums text-[var(--s-text)]">{CHAIN.blueprintId}</span>
              </SummaryRow>
              <SummaryRow label="Services contract">
                <a
                  href={`${CHAIN.explorer}/address/${CHAIN.tangle}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[var(--s-accent)] hover:underline"
                >
                  {truncAddr(CHAIN.tangle)}
                </a>
              </SummaryRow>
              <SummaryRow label="Permitted caller">you — {address ? truncAddr(address) : '—'}</SummaryRow>
              <SummaryRow label="TTL">~1 day · {Number(REQUEST_TTL_BLOCKS).toLocaleString()} blocks</SummaryRow>
              <SummaryRow label="Payment">
                <span className="text-[var(--s-text-muted)]">none — billed via settlement</span>
              </SummaryRow>

              {!isConnected ? (
                <ConnectKitButton.Custom>
                  {({ show }) => (
                    <button onClick={show} className="btn-primary mt-1 h-11 w-full">
                      <span className="i-ph:wallet text-[18px]" /> Connect wallet
                    </button>
                  )}
                </ConnectKitButton.Custom>
              ) : (
                <>
                  {wrongChain && (
                    <div className="rounded-[8px] border border-[var(--s-amber)]/30 bg-[var(--s-amber-soft)] px-3 py-2 text-[15px] text-[var(--s-amber)]">
                      Switch your wallet to Base Sepolia to submit this request.
                    </div>
                  )}
                  <button
                    onClick={submit}
                    disabled={picked.size === 0 || isPending || wrongChain}
                    className="btn-primary mt-1 h-11 w-full"
                  >
                    {isPending ? 'Signing…' : `Request ${picked.size || ''} instance${picked.size === 1 ? '' : 's'}`.trim()}
                  </button>
                </>
              )}

              {error && (
                <div className="rounded-[8px] border border-[var(--s-crimson)]/30 bg-[var(--s-crimson-soft)] px-3 py-2 text-[15px] text-[var(--s-crimson)]">
                  {error.message.split('\n')[0]}
                </div>
              )}

              {(done || txHash) && !error && (
                <div className="rounded-[8px] border border-[var(--s-emerald)]/30 bg-[var(--s-emerald-soft)] px-3 py-2.5 text-[15px] text-[var(--s-emerald)]">
                  <div className="flex items-center gap-1.5">
                    <span className="i-ph:check-circle-fill text-[16px]" /> Request submitted
                  </div>
                  <a
                    href={`${CHAIN.explorer}/tx/${done ?? txHash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 block font-data text-[13px] text-[var(--s-emerald)] hover:underline"
                  >
                    {truncAddr(done ?? txHash!)} ↗
                  </a>
                  <div className="mt-1 text-[13px] text-[var(--s-emerald)]/80">
                    Operators must approve before their managers spawn the instance.
                  </div>
                </div>
              )}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  )
}

function SummaryRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="mono-label">{label}</span>
      <span className="text-right text-[var(--s-text-secondary)]">{children}</span>
    </div>
  )
}
