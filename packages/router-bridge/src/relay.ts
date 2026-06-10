import { createHash } from 'node:crypto'
import {
  decodeReplyCell,
  encodeReplyCell,
  type OnionMessage,
  padToCell,
  peelOnion,
  type RelayKeypair,
  type ReplyCell,
  sealReply,
  unpadCell,
} from './onion'

/**
 * The forward transport a relay uses to reach the NEXT hop. The in-memory
 * network and any HTTP transport implement it. It is request/response: the
 * returned `ReplyCell` is the next hop's already-layered response, which this
 * relay seals under its own key before returning upstream.
 */
export interface OnionTransport {
  send(relayId: string, message: OnionMessage): Promise<ReplyCell>
}

/** What the exit relay does with the recovered request: fulfill it, return bytes. */
export type ExitHandler = (request: Buffer) => Promise<Uint8Array> | Uint8Array

export interface OnionRelayOptions {
  keypair: RelayKeypair
  /** How this relay forwards to the next hop (omit for an exit-only relay). */
  transport?: OnionTransport
  /** Fulfillment at the exit (omit for a pure forwarder). */
  exitHandler?: ExitHandler
  /** Max remembered message digests for replay protection. Default 100_000. */
  replayWindow?: number
}

/**
 * An onion relay. It peels exactly one layer of each message: a non-exit layer
 * reveals only the next hop (forwarded blindly); the exit layer reveals the
 * request, which `exitHandler` fulfills. The response travels back through the
 * same call chain, each relay sealing it under its own hop key, so only the
 * original sender can read it.
 *
 * Replay protection: a relay rejects any forward message it has already peeled
 * (digest of the sealed bytes), so a captured onion cannot be re-injected to
 * probe the path or re-bill a payment.
 */
export class OnionRelay {
  readonly id: string
  private readonly keypair: RelayKeypair
  private readonly transport: OnionTransport | undefined
  private readonly exitHandler: ExitHandler | undefined
  private readonly seen = new Set<string>()
  private readonly seenOrder: string[] = []
  private readonly replayWindow: number

  constructor(opts: OnionRelayOptions) {
    this.id = opts.keypair.id
    this.keypair = opts.keypair
    this.transport = opts.transport
    this.exitHandler = opts.exitHandler
    this.replayWindow = opts.replayWindow ?? 100_000
  }

  /** Public identity for a directory entry. */
  relay(): { id: string; publicKey: string } {
    return { id: this.keypair.id, publicKey: this.keypair.publicKey }
  }

  async handle(message: OnionMessage): Promise<ReplyCell> {
    this.guardReplay(message)
    const peeled = peelOnion(this.keypair.privateKey, message)

    if (peeled.next === null) {
      if (!this.exitHandler) {
        throw new Error(`relay ${this.id} is an exit for this circuit but has no exitHandler`)
      }
      const response = await this.exitHandler(unpadCell(peeled.payload))
      // Exit cell-pads the response so its length is hidden too, then seals it;
      // upstream relays wrap it further. The client unpads after peeling.
      return sealReply(peeled.layerKey, padToCell(response))
    }

    if (!this.transport) {
      throw new Error(`relay ${this.id} must forward to ${peeled.next} but has no transport`)
    }
    const innerMessage = JSON.parse(peeled.payload.toString()) as OnionMessage
    const downstream = await this.transport.send(peeled.next, innerMessage)
    // Wrap the downstream reply in this hop's layer on the way back.
    return sealReply(peeled.layerKey, encodeReplyCell(downstream))
  }

  private guardReplay(message: OnionMessage): void {
    const digest = createHash('sha256')
      .update(message.ephemeralPublicKey)
      .update(message.iv)
      .update(message.ciphertext)
      .update(message.tag)
      .digest('hex')
    if (this.seen.has(digest)) {
      throw new Error(`relay ${this.id}: replayed onion rejected`)
    }
    this.seen.add(digest)
    this.seenOrder.push(digest)
    if (this.seenOrder.length > this.replayWindow) {
      const evicted = this.seenOrder.shift()
      if (evicted) this.seen.delete(evicted)
    }
  }
}

// re-exported for callers wiring transports without importing onion directly
export { decodeReplyCell }
