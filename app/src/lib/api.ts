/**
 * Real data layer. Two live sources, no mocks, no fallbacks:
 *
 * - The Surplus operator venue (Hetzner blueprint-operators box, Base Sepolia
 *   blueprint 17 / service 4): instruments listed via on-chain jobs, the live
 *   order book the MM quotes two-sided, order placement, settlement outbox.
 * - The Tangle Router catalog: every model's real list price — the reference
 *   the market discounts against.
 *
 * If a source is down the UI says so. It never invents numbers.
 */
import { useQuery } from '@tanstack/react-query'

export const VENUE_URL =
  import.meta.env.VITE_SURPLUS_VENUE_URL || 'https://surplus.178.104.232.124.sslip.io'
export const ROUTER_URL = import.meta.env.VITE_TANGLE_ROUTER_URL || 'https://router.tangle.tools'

/** Base Sepolia coordinates of the live deployment. */
export const CHAIN = {
  id: 84532,
  tangle: '0x8299d60f373f3a4a8c4878e335cb9d840e6e3730' as const,
  staking: '0x91b1186f4f31d6e02e481c0af29c7244a3fe417d' as const,
  tnt: '0x62b3407a22e50183b1055e54d70ee21f59bf865b' as const,
  blueprintId: 17,
  serviceId: 4,
  explorer: 'https://sepolia.basescan.org',
}

// ── Types (wire shapes, verbatim) ────────────────────────────────────────────

export interface VenueInstrument {
  id: string
  model_id: string
  token_kind: 'input' | 'output'
  tick_size: number
  min_qty: number
}

export interface BookLevel {
  price: number
  qty: number
  orders: number
}

export interface VenueBook {
  book: {
    instrument_id: string
    bids: BookLevel[]
    asks: BookLevel[]
    last_trade_price: number | null
  }
  inventoryTokens: number
  refMid: number
}

export interface RouterModel {
  id: string
  name: string
  description?: string
  _provider?: string
  context_length?: number
  pricing?: { prompt?: string; completion?: string }
  architecture?: { input_modalities?: string[]; output_modalities?: string[] }
}

/** Catalog entry with prices converted to micro-tsUSD per 1M tokens. */
export interface CatalogModel {
  id: string
  name: string
  provider: string
  description: string
  contextLength: number
  inputMicroPerM: number
  outputMicroPerM: number
  modalities: string[]
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`${url}: ${res.status} ${await res.text().catch(() => '')}`)
  return res.json() as Promise<T>
}

// ── Router catalog ───────────────────────────────────────────────────────────

const USD_PER_TOKEN_TO_MICRO_PER_M = 1e12 // USD/token × 1M tokens × 1e6 micro

export async function fetchCatalog(): Promise<Map<string, CatalogModel>> {
  const { data } = await getJson<{ data: RouterModel[] }>(`${ROUTER_URL}/v1/models`)
  const map = new Map<string, CatalogModel>()
  for (const m of data) {
    const inp = Number(m.pricing?.prompt ?? 0)
    const out = Number(m.pricing?.completion ?? 0)
    map.set(m.id, {
      id: m.id,
      name: m.name || m.id,
      provider: m._provider ?? 'unknown',
      description: m.description ?? '',
      contextLength: m.context_length ?? 0,
      inputMicroPerM: Number.isFinite(inp) ? Math.round(inp * USD_PER_TOKEN_TO_MICRO_PER_M) : 0,
      outputMicroPerM: Number.isFinite(out) ? Math.round(out * USD_PER_TOKEN_TO_MICRO_PER_M) : 0,
      modalities: m.architecture?.input_modalities ?? [],
    })
  }
  return map
}

export function useCatalog() {
  return useQuery({ queryKey: ['catalog'], queryFn: fetchCatalog, staleTime: 5 * 60_000 })
}

// ── Venue ────────────────────────────────────────────────────────────────────

export function useInstruments() {
  return useQuery({
    queryKey: ['instruments'],
    queryFn: () => getJson<VenueInstrument[]>(`${VENUE_URL}/instruments`),
    refetchInterval: 30_000,
  })
}

export async function fetchBook(instrumentId: string): Promise<VenueBook> {
  return getJson<VenueBook>(`${VENUE_URL}/book`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instrumentId }),
  })
}

export function useBook(instrumentId: string | null) {
  return useQuery({
    queryKey: ['book', instrumentId],
    queryFn: () => fetchBook(instrumentId!),
    enabled: !!instrumentId,
    refetchInterval: 10_000,
  })
}


export function useVenueHealth() {
  return useQuery({
    queryKey: ['venue-health'],
    queryFn: async () => {
      const t0 = performance.now()
      await getJson<{ ok: boolean }>(`${VENUE_URL}/health`)
      return { ok: true, latencyMs: Math.round(performance.now() - t0) }
    },
    refetchInterval: 20_000,
    retry: 1,
  })
}


/** The venue returns an OBJECT — { count, fillsHash, fills: [...] } — not a
 * bare array; mapping it directly was a live crash on /activity. */
export interface SettlementOutbox {
  count: number
  fillsHash: string
  fills: Record<string, unknown>[]
}

export function useSettlementOutbox() {
  return useQuery({
    queryKey: ['outbox'],
    queryFn: () => getJson<SettlementOutbox>(`${VENUE_URL}/settlement/outbox`),
    refetchInterval: 20_000,
  })
}

