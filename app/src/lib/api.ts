/**
 * Real data layer. Two live sources:
 *
 * - The InferenceBazaar operator venue (Hetzner blueprint-operators box, Base Sepolia
 *   blueprint 17 / service 4): instruments listed via on-chain jobs, the live
 *   order book the MM quotes two-sided, order placement, settlement outbox.
 * - The Tangle Router catalog: every model's real list price — the reference
 *   the market discounts against.
 *
 * If the router catalog is down, the app uses a small static catalog for the
 * models already listed by live venues. Execution still requires live venue
 * RFQs and on-chain settlement.
 */
import { useQuery } from '@tanstack/react-query'
import { cacheKey, readBrowserCache, writeBrowserCache } from './browser-cache'

// `import.meta.env?` (not `.env.`) so these modules also load under plain
// node/tsx (the SOR/NBBO checks run outside Vite, where import.meta.env is
// undefined); in the Vite build it resolves exactly as before.
export const VENUE_URL =
  import.meta.env?.VITE_INFERENCE_BAZAAR_VENUE_URL || 'https://bazaar.178.104.232.124.sslip.io'
export const ROUTER_URL = import.meta.env?.VITE_TANGLE_ROUTER_URL || 'https://router.tangle.tools'

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
const CATALOG_CACHE_MS = 24 * 60 * 60_000
const INSTRUMENT_CACHE_MS = 5 * 60_000
const BOOK_CACHE_MS = 30_000
const BOOK_FALLBACK_CACHE_MS = 2 * 60_000
const OUTBOX_CACHE_MS = 60_000

const FALLBACK_CATALOG: CatalogModel[] = [
  {
    id: 'anthropic/claude-opus-4-8',
    name: 'Claude Opus 4.8',
    provider: 'anthropic',
    description: '',
    contextLength: 0,
    inputMicroPerM: 15_000_000,
    outputMicroPerM: 75_000_000,
    modalities: ['text'],
  },
  {
    id: 'claude-haiku-4-5-20251001',
    name: 'Claude Haiku 4.5',
    provider: 'anthropic',
    description: '',
    contextLength: 0,
    inputMicroPerM: 100_000,
    outputMicroPerM: 500_000,
    modalities: ['text'],
  },
  {
    id: 'claude-opus-4-7',
    name: 'Claude Opus 4.7',
    provider: 'anthropic',
    description: '',
    contextLength: 0,
    inputMicroPerM: 5_000_000,
    outputMicroPerM: 25_000_000,
    modalities: ['text'],
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    description: '',
    contextLength: 0,
    inputMicroPerM: 3_000_000,
    outputMicroPerM: 15_000_000,
    modalities: ['text'],
  },
  {
    id: 'deepseek/deepseek-chat',
    name: 'DeepSeek: DeepSeek V3',
    provider: 'deepseek',
    description: '',
    contextLength: 0,
    inputMicroPerM: 200_200,
    outputMicroPerM: 800_100,
    modalities: ['text'],
  },
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    provider: 'google',
    description: '',
    contextLength: 0,
    inputMicroPerM: 300_000,
    outputMicroPerM: 2_500_000,
    modalities: ['text'],
  },
  {
    id: 'gemini-3.1-pro-preview',
    name: 'Gemini 3.1 Pro Preview',
    provider: 'google',
    description: '',
    contextLength: 0,
    inputMicroPerM: 2_000_000,
    outputMicroPerM: 12_000_000,
    modalities: ['text'],
  },
  {
    id: 'glm-5',
    name: 'glm-5',
    provider: 'zai',
    description: '',
    contextLength: 0,
    inputMicroPerM: 600_000,
    outputMicroPerM: 1_920_000,
    modalities: ['text'],
  },
  {
    id: 'gpt-5',
    name: 'gpt-5',
    provider: 'openai',
    description: '',
    contextLength: 0,
    inputMicroPerM: 1_250_000,
    outputMicroPerM: 10_000_000,
    modalities: ['text'],
  },
  {
    id: 'gpt-5-mini',
    name: 'gpt-5-mini',
    provider: 'openai',
    description: '',
    contextLength: 0,
    inputMicroPerM: 250_000,
    outputMicroPerM: 2_000_000,
    modalities: ['text'],
  },
  {
    id: 'mistral-large-2512',
    name: 'mistral-large-2512',
    provider: 'mistral',
    description: '',
    contextLength: 0,
    inputMicroPerM: 500_000,
    outputMicroPerM: 1_500_000,
    modalities: ['text'],
  },
]

function fallbackCatalog(): Map<string, CatalogModel> {
  return new Map(FALLBACK_CATALOG.map((m) => [m.id, m]))
}

function catalogCacheKey(): string {
  return cacheKey('catalog', ROUTER_URL)
}

function readCachedCatalog(maxAgeMs = CATALOG_CACHE_MS): Map<string, CatalogModel> | undefined {
  return readBrowserCache<Array<[string, CatalogModel]>, Map<string, CatalogModel>>(catalogCacheKey(), {
    maxAgeMs,
    revive: (entries) => new Map(entries),
  })
}

function writeCachedCatalog(catalog: Map<string, CatalogModel>): void {
  writeBrowserCache(catalogCacheKey(), catalog, {
    serialize: (value) => [...value.entries()],
  })
}

export async function fetchCatalog(): Promise<Map<string, CatalogModel>> {
  let data: RouterModel[]
  try {
    const catalog = await getJson<{ data: RouterModel[] }>(`${ROUTER_URL}/v1/models`)
    data = catalog.data
  } catch {
    return readCachedCatalog() ?? fallbackCatalog()
  }
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
  writeCachedCatalog(map)
  return map
}

export function useCatalog() {
  return useQuery({
    queryKey: ['catalog'],
    queryFn: fetchCatalog,
    initialData: () => readCachedCatalog(),
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
  })
}

// ── Venue ────────────────────────────────────────────────────────────────────

export function useInstruments() {
  return useQuery({
    queryKey: ['instruments'],
    queryFn: async () => {
      try {
        const instruments = await getJson<VenueInstrument[]>(`${VENUE_URL}/instruments`)
        if (instruments.length > 0) writeBrowserCache(cacheKey('instruments', VENUE_URL), instruments)
        return instruments
      } catch (error) {
        const cached = readBrowserCache<VenueInstrument[]>(cacheKey('instruments', VENUE_URL), {
          maxAgeMs: INSTRUMENT_CACHE_MS,
        })
        if (cached) return cached
        throw error
      }
    },
    initialData: () =>
      readBrowserCache<VenueInstrument[]>(cacheKey('instruments', VENUE_URL), { maxAgeMs: INSTRUMENT_CACHE_MS }),
    staleTime: 30_000,
    gcTime: 30 * 60_000,
    refetchInterval: 30_000,
  })
}

export async function fetchBook(instrumentId: string): Promise<VenueBook> {
  const key = cacheKey('book', VENUE_URL, instrumentId)
  try {
    const book = await getJson<VenueBook>(`${VENUE_URL}/book`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instrumentId }),
    })
    writeBrowserCache(key, book)
    return book
  } catch (error) {
    const cached = readBrowserCache<VenueBook>(key, { maxAgeMs: BOOK_FALLBACK_CACHE_MS })
    if (cached) return cached
    throw error
  }
}

export function useBook(instrumentId: string | null) {
  const key = instrumentId ? cacheKey('book', VENUE_URL, instrumentId) : null
  return useQuery({
    queryKey: ['book', instrumentId],
    queryFn: () => fetchBook(instrumentId!),
    enabled: !!instrumentId,
    initialData: () => (key ? readBrowserCache<VenueBook>(key, { maxAgeMs: BOOK_CACHE_MS }) : undefined),
    staleTime: 5_000,
    gcTime: 10 * 60_000,
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
    queryFn: async () => {
      const key = cacheKey('outbox', VENUE_URL)
      try {
        const outbox = await getJson<SettlementOutbox>(`${VENUE_URL}/settlement/outbox`)
        writeBrowserCache(key, outbox)
        return outbox
      } catch (error) {
        const cached = readBrowserCache<SettlementOutbox>(key, { maxAgeMs: OUTBOX_CACHE_MS })
        if (cached) return cached
        throw error
      }
    },
    initialData: () => readBrowserCache<SettlementOutbox>(cacheKey('outbox', VENUE_URL), { maxAgeMs: OUTBOX_CACHE_MS }),
    staleTime: 10_000,
    gcTime: 10 * 60_000,
    refetchInterval: 20_000,
  })
}
