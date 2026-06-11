/**
 * Deterministic mock dataset. Seeded PRNG so the market is stable across
 * renders and screenshots. This is the swappable seam: every `getX` here is
 * what a real `@surplus/router-bridge` client would return — replace the bodies
 * with fetches to the operator venue API and the UI is unchanged.
 */
import type {
  Capability,
  Lab,
  Model,
  ModelMarket,
  Offer,
  OrderLevel,
  Trade,
  TokenKind,
  Venue,
} from './types'

function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

export const LABS: Record<string, Lab> = {
  anthropic: { id: 'anthropic', name: 'Anthropic', hue: '#d97757', glyph: 'i-ph:brain' },
  openai: { id: 'openai', name: 'OpenAI', hue: '#10a37f', glyph: 'i-ph:circle-fill' },
  google: { id: 'google', name: 'Google', hue: '#4285f4', glyph: 'i-ph:sparkle' },
  meta: { id: 'meta', name: 'Meta', hue: '#1d8cf8', glyph: 'i-ph:infinity' },
  mistral: { id: 'mistral', name: 'Mistral', hue: '#fa5418', glyph: 'i-ph:wind' },
  deepseek: { id: 'deepseek', name: 'DeepSeek', hue: '#5b6cff', glyph: 'i-ph:waves' },
  xai: { id: 'xai', name: 'xAI', hue: '#9aa0a6', glyph: 'i-ph:x' },
  blackforest: { id: 'blackforest', name: 'Black Forest', hue: '#8b5cf6', glyph: 'i-ph:image' },
}

export const VENUES: Record<string, Venue> = {
  openrouter: { id: 'openrouter', name: 'OpenRouter', hue: '#6566f1' },
  venice: { id: 'venice', name: 'Venice AI', hue: '#e23b4e' },
  anthropic: { id: 'anthropic', name: 'Anthropic API', hue: '#d97757' },
  openai: { id: 'openai', name: 'OpenAI API', hue: '#10a37f' },
  google: { id: 'google', name: 'Vertex AI', hue: '#4285f4' },
  together: { id: 'together', name: 'Together', hue: '#0f9d8c' },
  fireworks: { id: 'fireworks', name: 'Fireworks', hue: '#f5a623' },
  tangle: { id: 'tangle', name: 'Tangle Operators', hue: '#50d2c1' },
}

const TEXT_TOOLS_REASON: Capability[] = ['text', 'tools', 'reasoning']
const FRONTIER: Capability[] = ['text', 'tools', 'vision', 'reasoning']

// micro-tsUSD per 1M tokens. input/output/cache.
const MODELS: Model[] = [
  m('anthropic/claude-opus-4-8', 'Claude Opus 4.8', 'anthropic', FRONTIER, 200, 15_000_000, 75_000_000, 1_500_000),
  m('anthropic/claude-sonnet-4-6', 'Claude Sonnet 4.6', 'anthropic', FRONTIER, 200, 3_000_000, 15_000_000, 300_000),
  m('anthropic/claude-haiku-4-5', 'Claude Haiku 4.5', 'anthropic', ['text', 'tools', 'vision'], 200, 800_000, 4_000_000, 80_000),
  m('openai/gpt-5', 'GPT-5', 'openai', FRONTIER, 256, 10_000_000, 30_000_000, 1_000_000),
  m('openai/gpt-5-mini', 'GPT-5 mini', 'openai', ['text', 'tools', 'vision'], 256, 600_000, 2_400_000, 60_000),
  m('openai/o4', 'o4', 'openai', TEXT_TOOLS_REASON, 200, 8_000_000, 32_000_000, 800_000),
  m('google/gemini-3-pro', 'Gemini 3 Pro', 'google', [...FRONTIER, 'audio', 'video'], 1000, 5_000_000, 20_000_000, 500_000),
  m('google/gemini-3-flash', 'Gemini 3 Flash', 'google', ['text', 'tools', 'vision', 'audio'], 1000, 350_000, 1_400_000, 35_000),
  m('meta/llama-4-405b', 'Llama 4 405B', 'meta', ['text', 'tools', 'vision'], 256, 1_200_000, 1_800_000, 120_000),
  m('meta/llama-4-scout', 'Llama 4 Scout', 'meta', ['text', 'tools'], 320, 250_000, 600_000, 25_000),
  m('mistral/mistral-large-3', 'Mistral Large 3', 'mistral', ['text', 'tools', 'reasoning'], 256, 2_000_000, 6_000_000, 200_000),
  m('deepseek/deepseek-v4', 'DeepSeek V4', 'deepseek', TEXT_TOOLS_REASON, 164, 550_000, 2_200_000, 55_000),
  m('deepseek/deepseek-r2', 'DeepSeek R2', 'deepseek', ['text', 'reasoning'], 164, 700_000, 2_800_000, 70_000),
  m('xai/grok-5', 'Grok 5', 'xai', FRONTIER, 256, 6_000_000, 18_000_000, 600_000),
  m('blackforest/flux-2-pro', 'FLUX.2 Pro', 'blackforest', ['image'], 0, 0, 0, 0),
  m('openai/gpt-realtime-2', 'GPT Realtime 2', 'openai', ['text', 'audio', 'voice', 'tools'], 128, 4_000_000, 16_000_000, 400_000),
]

function m(
  id: string,
  name: string,
  labId: string,
  capabilities: Capability[],
  contextK: number,
  input: number,
  output: number,
  cache: number,
): Model {
  return { id, name, labId, capabilities, contextK, list: { input, output, cache } }
}

// Which venues sell which model (resellers' sources).
function venuesFor(model: Model): string[] {
  const base = ['tangle']
  if (model.labId === 'anthropic') base.push('openrouter', 'anthropic', 'together')
  else if (model.labId === 'openai') base.push('openrouter', 'openai', 'venice')
  else if (model.labId === 'google') base.push('openrouter', 'google')
  else if (model.labId === 'meta') base.push('openrouter', 'together', 'fireworks', 'venice')
  else if (model.labId === 'deepseek') base.push('openrouter', 'together', 'fireworks', 'venice')
  else base.push('openrouter', 'together')
  return base
}

const SELLER_HANDLES = [
  'gpurich.eth', 'idlecluster', 'overbought.eth', 'surplus-desk', 'nightshift',
  'creditflip', 'tokenwhale.eth', 'h100farm', 'prepaid.eth', 'venice-resell',
  'arb-bot-7', 'coldstorage.eth',
]

function makeOffers(model: Model): Offer[] {
  const rnd = mulberry32(hash(model.id))
  const venues = venuesFor(model)
  const offers: Offer[] = []
  let oi = 0
  for (const venueId of venues) {
    const count = 2 + Math.floor(rnd() * 3) // 2-4 sellers per venue
    for (let k = 0; k < count; k++) {
      const discount = 0.06 + rnd() * 0.34 // 6%-40% off
      const offered = Math.round((6 + rnd() * 220) * 1_000_000) // 6M - 226M tokens
      const sold = Math.round(offered * (0.1 + rnd() * 0.7))
      const remaining = Math.max(0, offered - sold)
      const handle = SELLER_HANDLES[(hash(model.id + venueId + k) % SELLER_HANDLES.length + SELLER_HANDLES.length) % SELLER_HANDLES.length]!
      const verified = venueId === 'tangle' || rnd() > 0.45
      offers.push({
        id: `${model.id}:${venueId}:${k}`,
        modelId: model.id,
        venueId,
        seller: `0x${(hash(handle + oi) >>> 0).toString(16).padStart(8, '0')}…${(hash(venueId + k) % 9999).toString().padStart(4, '0')}`,
        sellerLabel: handle,
        verified,
        discount,
        price: {
          input: Math.round(model.list.input * (1 - discount)),
          output: Math.round(model.list.output * (1 - discount)),
          cache: Math.round(model.list.cache * (1 - discount)),
        },
        offeredTokens: offered,
        soldTokens: sold,
        remainingTokens: remaining,
        ageS: Math.floor(rnd() * 5400),
      })
      oi++
    }
  }
  return offers.sort((a, b) => b.discount - a.discount)
}

function priceKind(model: Model, kind: TokenKind): number {
  return model.list[kind]
}

function makeStats(model: Model, offers: Offer[], kind: TokenKind) {
  const rnd = mulberry32(hash(model.id + kind))
  const list = priceKind(model, kind)
  const best = offers.length ? Math.min(...offers.map((o) => o.price[kind])) : list
  const bestDiscount = offers.length ? Math.max(...offers.map((o) => o.discount)) : 0
  const liquidityTokens = offers.reduce((s, o) => s + o.remainingTokens, 0)
  const liquidityNotionalMicro = offers.reduce(
    (s, o) => s + Math.round((o.price[kind] * o.remainingTokens) / 1_000_000),
    0,
  )
  const volume24hMicro = Math.round(liquidityNotionalMicro * (0.3 + rnd() * 1.4))
  const trades24h = 40 + Math.floor(rnd() * 900)
  const spreadBps = 8 + Math.floor(rnd() * 60)
  const spark: number[] = []
  let p = list * (1 - bestDiscount * 0.7)
  for (let i = 0; i < 24; i++) {
    p *= 1 + (rnd() - 0.5) * 0.04
    spark.push(Math.round(p))
  }
  return {
    bestDiscount,
    listOut: list,
    bestOut: best,
    liquidityTokens,
    liquidityNotionalMicro,
    volume24hMicro,
    trades24h,
    activeOffers: offers.length,
    venues: new Set(offers.map((o) => o.venueId)).size,
    spreadBps,
    spark,
  }
}

function makeOrderbook(model: Model, kind: TokenKind): { bids: OrderLevel[]; asks: OrderLevel[] } {
  const rnd = mulberry32(hash(model.id + kind + 'ob'))
  const list = priceKind(model, kind)
  const mid = list * (1 - (0.1 + rnd() * 0.2))
  const tick = Math.max(1000, Math.round(list / 400))
  const bids: OrderLevel[] = []
  const asks: OrderLevel[] = []
  for (let i = 0; i < 9; i++) {
    bids.push({
      price: Math.round((mid - tick * (i + 1)) / tick) * tick,
      tokens: Math.round((1 + rnd() * 9) * 1_000_000),
      orders: 1 + Math.floor(rnd() * 6),
    })
    asks.push({
      price: Math.round((mid + tick * (i + 1)) / tick) * tick,
      tokens: Math.round((1 + rnd() * 9) * 1_000_000),
      orders: 1 + Math.floor(rnd() * 6),
    })
  }
  return { bids, asks }
}

function makeTrades(model: Model, kind: TokenKind, n = 18): Trade[] {
  const rnd = mulberry32(hash(model.id + kind + 'tr'))
  const list = priceKind(model, kind)
  const venues = venuesFor(model)
  const out: Trade[] = []
  let t = Date.now()
  for (let i = 0; i < n; i++) {
    t -= Math.floor(rnd() * 240_000)
    out.push({
      id: `${model.id}:t:${i}`,
      modelId: model.id,
      kind,
      side: rnd() > 0.5 ? 'buy' : 'sell',
      price: Math.round(list * (1 - (0.08 + rnd() * 0.28))),
      tokens: Math.round((0.2 + rnd() * 8) * 1_000_000),
      venueId: venues[Math.floor(rnd() * venues.length)]!,
      tsMs: t,
    })
  }
  return out
}

// ── Public API seam ──────────────────────────────────────────────────────────

export function getMarkets(kind: TokenKind = 'output'): ModelMarket[] {
  return MODELS.map((model) => {
    const offers = model.list[kind] > 0 ? makeOffers(model) : []
    return { model, lab: LABS[model.labId]!, stats: makeStats(model, offers, kind) }
  })
}

export function getModel(id: string): Model | undefined {
  return MODELS.find((x) => x.id === id)
}

export function getOffers(modelId: string): Offer[] {
  const model = getModel(modelId)
  return model ? makeOffers(model) : []
}

export function getMarket(modelId: string, kind: TokenKind): ModelMarket | undefined {
  const model = getModel(modelId)
  if (!model) return undefined
  const offers = makeOffers(model)
  return { model, lab: LABS[model.labId]!, stats: makeStats(model, offers, kind) }
}

export function getOrderbook(modelId: string, kind: TokenKind) {
  const model = getModel(modelId)
  return model ? makeOrderbook(model, kind) : { bids: [], asks: [] }
}

export function getTrades(modelId: string, kind: TokenKind, n?: number): Trade[] {
  const model = getModel(modelId)
  return model ? makeTrades(model, kind, n) : []
}

export function getRecentTradesGlobal(n = 30): (Trade & { modelName: string })[] {
  const all: (Trade & { modelName: string })[] = []
  for (const model of MODELS) {
    if (model.list.output <= 0) continue
    for (const t of makeTrades(model, 'output', 4)) all.push({ ...t, modelName: model.name })
  }
  return all.sort((a, b) => b.tsMs - a.tsMs).slice(0, n)
}

export const ALL_MODELS = MODELS
