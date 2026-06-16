/**
 * Blueprint-wide venue registry + NBBO aggregation (shared-clob.md Phase A).
 *
 * Discovery is pure chain state: sweep service ids → active services of
 * blueprint 17 → union operator sets → getOperatorPreferences rpcAddress →
 * health probe. An operator activating on-chain appears with zero app changes. Books from
 * every healthy venue merge into one ladder per instrument; the best firm
 * price across operators is the market.
 */
import { useQuery } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'
import type { Address } from 'viem'
import { CHAIN, type BookLevel, type VenueBook, type VenueInstrument } from './api'

const TANGLE_ABI = [
  {
    type: 'function',
    name: 'getOperatorPreferences',
    inputs: [
      { name: 'blueprintId', type: 'uint64' },
      { name: 'operator', type: 'address' },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'ecdsaPublicKey', type: 'bytes' },
          { name: 'rpcAddress', type: 'string' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getService',
    inputs: [{ name: 'serviceId', type: 'uint64' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'blueprintId', type: 'uint64' },
          { name: 'owner', type: 'address' },
          { name: 'createdAt', type: 'uint64' },
          { name: 'ttl', type: 'uint64' },
          { name: 'terminatedAt', type: 'uint64' },
          { name: 'lastPaymentAt', type: 'uint64' },
          { name: 'operatorCount', type: 'uint32' },
          { name: 'minOperators', type: 'uint32' },
          { name: 'maxOperators', type: 'uint32' },
          { name: 'membership', type: 'uint8' },
          { name: 'pricing', type: 'uint8' },
          { name: 'status', type: 'uint8' },
          { name: 'confidentiality', type: 'uint8' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getServiceOperators',
    inputs: [{ name: 'serviceId', type: 'uint64' }],
    outputs: [{ name: '', type: 'address[]' }],
    stateMutability: 'view',
  },
] as const

/** Service-id sweep ceiling. Global ids are sequential; raise as the chain grows. */
const SERVICE_SCAN_MAX = 48

export interface Venue {
  operator: Address
  url: string
  /** The operator's Tor onion endpoint, self-reported via /health, if it runs
   * one. Privacy-mode clients dial this so the operator never sees the consumer's
   * IP (requires the browser/SDK to route .onion through Tor — see endpointFor). */
  onion: string | null
  healthy: boolean
  latencyMs: number | null
}

/** Where to reach a venue. Under privacy mode, prefer the operator's onion so a
 * Tor-enabled client reaches it anonymously; falls back to clearnet when the
 * operator publishes no onion. NOTE: a plain browser cannot SOCKS-proxy fetch —
 * effective anonymity requires Tor Browser / a system Tor proxy (or the Node
 * SDK's TorRedemptionClient). This only ensures the right destination is dialed. */
export function endpointFor(v: Pick<Venue, 'url' | 'onion'>, privacy: boolean): string {
  return privacy && v.onion ? v.onion : v.url
}

export function useVenueRegistry() {
  const client = usePublicClient({ chainId: CHAIN.id })
  return useQuery({
    queryKey: ['venue-registry'],
    enabled: !!client,
    refetchInterval: 60_000,
    queryFn: async (): Promise<Venue[]> => {
      // Pure view-call discovery (public RPCs cap getLogs ranges): sweep
      // service ids, keep active services of this blueprint, union operators.
      const ids = [...Array(SERVICE_SCAN_MAX).keys()]
      const services = await Promise.all(
        ids.map(async (id) => {
          try {
            const svc = await client!.readContract({
              address: CHAIN.tangle,
              abi: TANGLE_ABI,
              functionName: 'getService',
              args: [BigInt(id)],
            })
            return { id, svc }
          } catch {
            return null
          }
        }),
      )
      const mine = services.filter(
        (x): x is NonNullable<typeof x> =>
          x !== null && Number(x.svc.blueprintId) === CHAIN.blueprintId && x.svc.status === 1,
      )
      const operatorSets = await Promise.all(
        mine.map((x) =>
          client!.readContract({
            address: CHAIN.tangle,
            abi: TANGLE_ABI,
            functionName: 'getServiceOperators',
            args: [BigInt(x.id)],
          }),
        ),
      )
      const operators = [...new Set(operatorSets.flat())] as Address[]
      const venues = await Promise.all(
        operators.map(async (operator): Promise<Venue> => {
          // Preferences are the source of truth (registration URL can be updated).
          const prefs = await client!.readContract({
            address: CHAIN.tangle,
            abi: TANGLE_ABI,
            functionName: 'getOperatorPreferences',
            args: [BigInt(CHAIN.blueprintId), operator],
          })
          const url = prefs.rpcAddress.replace(/\/$/, '')
          if (!url.startsWith('http')) {
            return { operator, url, onion: null, healthy: false, latencyMs: null }
          }
          try {
            const t0 = performance.now()
            const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(4000) })
            const onion = res.ok ? ((await res.json().catch(() => null))?.onion ?? null) : null
            return {
              operator,
              url,
              onion: typeof onion === 'string' && onion ? onion : null,
              healthy: res.ok,
              latencyMs: Math.round(performance.now() - t0),
            }
          } catch {
            return { operator, url, onion: null, healthy: false, latencyMs: null }
          }
        }),
      )
      return venues
    },
  })
}

// ── Aggregation ──────────────────────────────────────────────────────────────

export interface AggLevel extends BookLevel {
  operator: Address
}

export interface AggBook {
  instrumentId: string
  /** Merged, price-sorted ladders. Best of book = index 0 on each side. */
  bids: AggLevel[]
  asks: AggLevel[]
  /** Highest reference among venues quoting it (they track the same list). */
  refMid: number
  perVenue: { operator: Address; book: VenueBook }[]
}

async function fetchVenueBook(url: string, instrumentId: string): Promise<VenueBook | null> {
  try {
    const res = await fetch(`${url}/book`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instrumentId }),
      signal: AbortSignal.timeout(6000),
    })
    if (!res.ok) return null
    return (await res.json()) as VenueBook
  } catch {
    return null
  }
}

export async function fetchAggBook(venues: Venue[], instrumentId: string): Promise<AggBook> {
  const live = venues.filter((v) => v.healthy)
  const perVenue = (
    await Promise.all(
      live.map(async (v) => {
        const book = await fetchVenueBook(v.url, instrumentId)
        return book ? { operator: v.operator, book } : null
      }),
    )
  ).filter((x): x is { operator: Address; book: VenueBook } => x !== null)

  const bids: AggLevel[] = []
  const asks: AggLevel[] = []
  let refMid = 0
  for (const { operator, book } of perVenue) {
    refMid = Math.max(refMid, book.refMid)
    for (const l of book.book.bids) bids.push({ ...l, operator })
    for (const l of book.book.asks) asks.push({ ...l, operator })
  }
  bids.sort((a, b) => b.price - a.price)
  asks.sort((a, b) => a.price - b.price)
  return { instrumentId, bids, asks, refMid, perVenue }
}

export function useAggBook(venues: Venue[] | undefined, instrumentId: string | null) {
  return useQuery({
    queryKey: ['agg-book', instrumentId, (venues ?? []).map((v) => v.url).join(',')],
    enabled: !!instrumentId && (venues ?? []).some((v) => v.healthy),
    refetchInterval: 10_000,
    queryFn: () => fetchAggBook(venues!, instrumentId!),
  })
}

export function useAggBooks(venues: Venue[] | undefined, instrumentIds: string[]) {
  return useQuery({
    queryKey: ['agg-books', instrumentIds.join(','), (venues ?? []).map((v) => v.url).join(',')],
    enabled: instrumentIds.length > 0 && (venues ?? []).some((v) => v.healthy),
    refetchInterval: 15_000,
    queryFn: async () => {
      const entries = await Promise.all(
        instrumentIds.map(async (id) => [id, await fetchAggBook(venues!, id)] as const),
      )
      return new Map(entries)
    },
  })
}

/** Union of instruments listed across all healthy venues. */
export function useAggInstruments(venues: Venue[] | undefined) {
  return useQuery({
    queryKey: ['agg-instruments', (venues ?? []).map((v) => v.url).join(',')],
    enabled: (venues ?? []).some((v) => v.healthy),
    refetchInterval: 60_000,
    queryFn: async (): Promise<VenueInstrument[]> => {
      const all = await Promise.all(
        venues!
          .filter((v) => v.healthy)
          .map(async (v) => {
            try {
              const res = await fetch(`${v.url}/instruments`, { signal: AbortSignal.timeout(6000) })
              return res.ok ? ((await res.json()) as VenueInstrument[]) : []
            } catch {
              return []
            }
          }),
      )
      const byId = new Map<string, VenueInstrument>()
      for (const list of all) for (const i of list) byId.set(i.id, i)
      return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
    },
  })
}

export interface MarketDemand {
  instrumentId: string
  count: number
  lastRequestedAt: number
}

/** Signal demand for a market: POST to every healthy operator so the whole set
 * sees it (the demand book is read back aggregated). Returns how many accepted. */
export async function requestMarket(
  venues: Venue[] | undefined,
  model: string,
  kind: string,
): Promise<number> {
  const healthy = (venues ?? []).filter((v) => v.healthy)
  const results = await Promise.allSettled(
    healthy.map((v) =>
      fetch(`${v.url}/market-requests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, kind }),
      }),
    ),
  )
  return results.filter((r) => r.status === 'fulfilled' && r.value.ok).length
}

/** The aggregated demand book across every healthy operator, most-wanted first. */
export function useMarketRequests(venues: Venue[] | undefined) {
  return useQuery({
    queryKey: ['market-requests', (venues ?? []).map((v) => v.url).sort()],
    enabled: !!venues,
    refetchInterval: 30_000,
    queryFn: async (): Promise<MarketDemand[]> => {
      const healthy = (venues ?? []).filter((v) => v.healthy)
      const results = await Promise.allSettled(
        healthy.map((v) =>
          fetch(`${v.url}/market-requests`).then((r) => (r.ok ? r.json() : { requests: [] })),
        ),
      )
      const agg = new Map<string, MarketDemand>()
      for (const r of results) {
        if (r.status !== 'fulfilled') continue
        for (const req of (r.value.requests ?? []) as MarketDemand[]) {
          const e = agg.get(req.instrumentId) ?? {
            instrumentId: req.instrumentId,
            count: 0,
            lastRequestedAt: 0,
          }
          e.count += req.count
          e.lastRequestedAt = Math.max(e.lastRequestedAt, req.lastRequestedAt)
          agg.set(req.instrumentId, e)
        }
      }
      return [...agg.values()].sort((a, b) => b.count - a.count)
    },
  })
}
