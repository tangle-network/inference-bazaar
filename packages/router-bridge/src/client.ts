import { CircuitMemory } from './memory'
import {
  openReply,
  padToCell,
  type Relay,
  selectCircuit,
  unpadCell,
  wrapOnion,
} from './onion'
import type { OnionTransport } from './relay'

export interface OnionClientOptions {
  /** The relay set to build circuits from (drawn from the router operator registry). */
  directory: Relay[]
  /** How the client reaches `circuit[0]` (in-memory network or HTTP transport). */
  transport: OnionTransport
  /** Hops per circuit (including exit). Default 3. */
  circuitLength?: number
  /** Cross-redemption memory for anti-stickiness. Created if omitted. */
  memory?: CircuitMemory
  /** Anti-stickiness strength passed to `selectCircuit`. Default 0.8. */
  stickinessPenalty?: number
  /** Deterministic randomness for selection. Inject for tests. */
  rand?: () => number
}

export interface OnionSendResult {
  response: Buffer
  /** The circuit used, in hop order. Surfaced for telemetry, not for the relays. */
  circuit: string[]
}

/**
 * The seller's onion client. One `send` = one private redemption:
 * select an anti-sticky circuit, pad + wrap the request, dispatch to the first
 * hop, and peel the layered response. No relay learns both the origin and the
 * request; no operator sees the seller's flow concentrate, because the memory
 * spreads circuits across redemptions.
 */
export class OnionClient {
  private readonly directory: Relay[]
  private readonly transport: OnionTransport
  private readonly circuitLength: number
  private readonly memory: CircuitMemory
  private readonly stickinessPenalty: number
  private readonly rand: (() => number) | undefined

  constructor(opts: OnionClientOptions) {
    this.directory = opts.directory
    this.transport = opts.transport
    this.circuitLength = opts.circuitLength ?? 3
    this.memory = opts.memory ?? new CircuitMemory()
    this.stickinessPenalty = opts.stickinessPenalty ?? 0.8
    this.rand = opts.rand
  }

  /**
   * Send `request` privately on behalf of `identity` (the seller's shielded
   * commitment) and return the fulfilled response.
   */
  async send(identity: string, request: Uint8Array): Promise<OnionSendResult> {
    const circuit = selectCircuit({
      relays: this.directory,
      length: this.circuitLength,
      recentRelayIds: this.memory.recent(identity),
      stickinessPenalty: this.stickinessPenalty,
      ...(this.rand ? { rand: this.rand } : {}),
    })
    const { message, hopKeys } = wrapOnion(circuit, padToCell(request))
    const replyCell = await this.transport.send(circuit[0]!.id, message)
    const padded = openReply(hopKeys, replyCell)
    const response = unpadCell(padded)
    this.memory.record(
      identity,
      circuit.map((r) => r.id),
    )
    return { response, circuit: circuit.map((r) => r.id) }
  }
}
