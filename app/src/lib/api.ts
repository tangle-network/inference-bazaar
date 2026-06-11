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

/** Books for many instruments at once (markets table). */
export function useBooks(instrumentIds: string[]) {
  return useQuery({
    queryKey: ['books', instrumentIds.join(',')],
    queryFn: async () => {
      const entries = await Promise.all(
        instrumentIds.map(async (id) => [id, await fetchBook(id).catch(() => null)] as const),
      )
      return new Map(entries.filter(([, b]) => b !== null) as [string, VenueBook][])
    },
    enabled: instrumentIds.length > 0,
    refetchInterval: 15_000,
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

export interface PlaceOrderResult {
  ok?: boolean
  orderId?: string
  fills?: { price: number; qty_tokens?: number; qtyTokens?: number }[]
  [k: string]: unknown
}

/** Place a real order on the live venue book. `owner` is the wallet address. */
export async function placeOrder(params: {
  instrumentId: string
  side: 'buy' | 'sell'
  price: number
  qtyTokens: number
  owner: string
}): Promise<PlaceOrderResult> {
  return getJson<PlaceOrderResult>(`${VENUE_URL}/order`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...params, rail: 'router-credits' }),
  })
}

export function useSettlementOutbox() {
  return useQuery({
    queryKey: ['outbox'],
    queryFn: () => getJson<unknown[]>(`${VENUE_URL}/settlement/outbox`),
    refetchInterval: 20_000,
  })
}

// ── Derived market stats (pure, from real book + catalog) ────────────────────

export interface MarketRow {
  instrument: VenueInstrument
  model: CatalogModel
  book: VenueBook | null
  listMicroPerM: number
  bestAsk: number | null
  bestBid: number | null
  /** 1 − ask/list when both known. */
  discount: number | null
  liquidityTokens: number
  liquidityNotionalMicro: number
}

export function deriveRow(
  instrument: VenueInstrument,
  model: CatalogModel,
  book: VenueBook | null,
): MarketRow {
  const list = instrument.token_kind === 'output' ? model.outputMicroPerM : model.inputMicroPerM
  const bestAsk = book?.book.asks[0]?.price ?? null
  const bestBid = book?.book.bids[0]?.price ?? null
  const levels = book ? [...book.book.bids, ...book.book.asks] : []
  const liquidityTokens = levels.reduce((s, l) => s + l.qty, 0)
  const liquidityNotionalMicro = levels.reduce((s, l) => s + Math.round((l.price * l.qty) / 1e6), 0)
  return {
    instrument,
    model,
    book,
    listMicroPerM: list,
    bestAsk,
    bestBid,
    discount: bestAsk !== null && list > 0 ? 1 - bestAsk / list : null,
    liquidityTokens,
    liquidityNotionalMicro,
  }
}
