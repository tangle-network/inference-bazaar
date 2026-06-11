import { PageHeader } from '~/components/PageHeader'
import { Panel, Stat } from '~/components/ui'
import { CHAIN, useSettlementOutbox, useVenueHealth } from '~/lib/api'

/**
 * Real venue activity: the operator's settlement outbox (intents emitted by
 * live fills, awaiting the settlement spine) and the on-chain service trail.
 */
export default function ActivityPage() {
  const outbox = useSettlementOutbox()
  const health = useVenueHealth()
  const entries = (outbox.data ?? []) as Record<string, unknown>[]

  return (
    <div>
      <PageHeader
        title="Activity"
        subtitle="Settlement intents from live fills, and the service's on-chain trail."
      />

      <div className="px-4 py-4 sm:px-6">
        <div className="panel grid grid-cols-2 divide-x divide-[var(--s-divider)] sm:grid-cols-3">
          <Stat label="Outbox intents" value={outbox.isLoading ? '…' : entries.length} tone="accent" />
          <Stat
            label="Venue"
            value={health.data?.ok ? 'live' : health.isError ? 'down' : '…'}
            tone={health.data?.ok ? 'emerald' : 'crimson'}
          />
          <Stat label="Service" value={`#${CHAIN.serviceId}`} sub="Base Sepolia" />
        </div>

        <Panel className="mt-4" title="Settlement outbox">
          {outbox.isError && <Empty text="Venue unreachable — outbox unavailable until it recovers." />}
          {outbox.isLoading && <Empty text="Reading outbox…" />}
          {outbox.isSuccess && entries.length === 0 && (
            <Empty text="No pending settlement intents. Fills land here the moment an order crosses the book." />
          )}
          {entries.map((e, i) => (
            <div
              key={i}
              className="border-b border-[var(--s-divider)] px-4 py-3 font-data text-[13px] last:border-0"
            >
              <pre className="overflow-x-auto whitespace-pre-wrap text-[var(--s-text-secondary)]">
                {JSON.stringify(e, null, 2)}
              </pre>
            </div>
          ))}
        </Panel>

        <Panel className="mt-4" title="On-chain trail">
          <div className="grid gap-1 px-4 py-4 font-data text-[14px]">
            <a
              className="text-[var(--s-accent)] hover:underline"
              href={`${CHAIN.explorer}/address/${CHAIN.tangle}`}
              target="_blank"
              rel="noreferrer"
            >
              Tangle protocol — job calls + results for service {CHAIN.serviceId} ↗
            </a>
            <a
              className="text-[var(--s-accent)] hover:underline"
              href={`${CHAIN.explorer}/address/${CHAIN.staking}`}
              target="_blank"
              rel="noreferrer"
            >
              Restaking — operator bonds ↗
            </a>
          </div>
        </Panel>
      </div>
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return (
    <div className="px-4 py-10 text-center font-data text-[13px] text-[var(--s-text-muted)]">{text}</div>
  )
}
