import { OperatorMemory } from './memory'
import { selectOperators } from './selection'
import type { TorTransport } from './tor'

export interface RedemptionOperator {
  id: string
  /** Base URL the operator serves on — a `.onion` service or clearnet HTTPS. */
  url: string
}

export interface TorRedemptionOptions {
  operators: RedemptionOperator[]
  transport: TorTransport
  /** Cross-redemption anti-stickiness memory. Created if omitted. */
  memory?: OperatorMemory
  /** Anti-stickiness strength. Default 0.8. */
  stickinessPenalty?: number
  /** Deterministic randomness for selection. Inject for tests. */
  rand?: () => number
}

export interface RedemptionResult {
  operator: string
  status: number
  body: Buffer
}

/**
 * Redeem surplus inference privately: pick a fulfilling operator weighted away
 * from this seller's recent operators, then reach it through Tor. Anonymity is
 * Tor's; operator spread is `selectOperators`'; the two compose so no operator
 * sees the seller's IP and no operator sees the seller's flow concentrate.
 */
export class TorRedemptionClient {
  private readonly operators: RedemptionOperator[]
  private readonly transport: TorTransport
  private readonly memory: OperatorMemory
  private readonly stickinessPenalty: number
  private readonly rand: (() => number) | undefined

  constructor(opts: TorRedemptionOptions) {
    this.operators = opts.operators
    this.transport = opts.transport
    this.memory = opts.memory ?? new OperatorMemory()
    this.stickinessPenalty = opts.stickinessPenalty ?? 0.8
    this.rand = opts.rand
  }

  /**
   * Send `body` to a privately-selected operator on behalf of `identity` (the
   * seller's shielded commitment) and return the operator's response.
   */
  async redeem(identity: string, path: string, body: Uint8Array): Promise<RedemptionResult> {
    const [operator] = selectOperators({
      operators: this.operators,
      count: 1,
      recentIds: this.memory.recent(identity),
      stickinessPenalty: this.stickinessPenalty,
      ...(this.rand ? { rand: this.rand } : {}),
    })
    if (!operator) throw new Error('no operator selected')
    const url = `${operator.url.replace(/\/$/, '')}${path}`
    const res = await this.transport.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body,
    })
    this.memory.record(identity, [operator.id])
    return { operator: operator.id, status: res.status, body: res.body }
  }
}
