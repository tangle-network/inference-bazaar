/**
 * Typed client for the tangle-router public surface the marketplace needs:
 * the model catalog (reference pricing the market quotes around) and the
 * operator registry (who can sell, who can relay).
 */

export interface RouterClientOptions {
  /** e.g. https://router.tangle.tools */
  baseUrl: string
  apiKey?: string
  fetchImpl?: typeof fetch
}

export interface RouterModel {
  id: string
  pricing?: {
    /** USD per token, decimal string — OpenRouter convention. */
    prompt?: string
    completion?: string
  }
  context_length?: number
}

export interface RouterOperator {
  id: string
  slug: string
  name: string
  status: 'pending' | 'active' | 'degraded' | 'suspended' | 'off-chain'
  endpointUrl: string
  reputationScore?: number
  uptimePercent?: number
  avgLatencyMs?: number
  teeAttested?: boolean
  models?: Array<{
    modelId: string
    inputPrice?: number | string
    outputPrice?: number | string
    status?: string
  }>
}

/** Reference quote for an instrument, micro-tsUSD per 1M tokens. */
export interface ReferenceQuote {
  modelId: string
  inputMicroPerM: number
  outputMicroPerM: number
}

export class RouterClient {
  private readonly baseUrl: string
  private readonly apiKey: string | undefined
  private readonly fetchImpl: typeof fetch

  constructor(opts: RouterClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.apiKey = opts.apiKey
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  async models(): Promise<RouterModel[]> {
    const body = await this.get<{ data?: RouterModel[] }>('/v1/models')
    return body.data ?? []
  }

  async operators(): Promise<RouterOperator[]> {
    const body = await this.get<{ operators?: RouterOperator[] } | RouterOperator[]>(
      '/api/operators',
    )
    return Array.isArray(body) ? body : (body.operators ?? [])
  }

  /**
   * The market's reference price: router list pricing converted to this
   * repo's units. USD-per-token "0.000015" → 15_000_000 micro-tsUSD per 1M.
   */
  async referenceQuote(modelId: string): Promise<ReferenceQuote | undefined> {
    const all = await this.models()
    const model = all.find((m) => m.id === modelId)
    if (!model?.pricing) return undefined
    const input = usdPerTokenToMicroPerM(model.pricing.prompt)
    const output = usdPerTokenToMicroPerM(model.pricing.completion)
    if (input === undefined && output === undefined) return undefined
    return { modelId, inputMicroPerM: input ?? 0, outputMicroPerM: output ?? 0 }
  }

  private async get<T>(path: string): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: {
        accept: 'application/json',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
    })
    if (!response.ok) {
      throw new Error(`router ${path} → ${response.status} ${response.statusText}`)
    }
    return (await response.json()) as T
  }
}

export function usdPerTokenToMicroPerM(usdPerToken: string | undefined): number | undefined {
  if (usdPerToken === undefined) return undefined
  const perToken = Number(usdPerToken)
  if (!Number.isFinite(perToken) || perToken < 0) return undefined
  // per token → per 1M tokens, USD → micro-tsUSD: ×1e6 twice.
  return Math.round(perToken * 1_000_000 * 1_000_000)
}
