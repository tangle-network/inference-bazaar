import type { OnionMessage, ReplyCell } from './onion'
import type { OnionRelay, OnionTransport } from './relay'

/**
 * In-memory onion network: routes a message to the relay registered under its
 * id. This is the transport for tests, local dev, and single-process
 * simulation. In production each relay is a separate operator process and the
 * transport is HTTP — implement `OnionTransport.send` to POST the message to
 * `https://<operator>/onion` and read back the `ReplyCell`; the relay logic
 * (`OnionRelay`) and the crypto are unchanged.
 */
export class InMemoryOnionNetwork implements OnionTransport {
  private readonly relays = new Map<string, OnionRelay>()

  register(relay: OnionRelay): this {
    if (this.relays.has(relay.id)) throw new Error(`relay ${relay.id} already registered`)
    this.relays.set(relay.id, relay)
    return this
  }

  async send(relayId: string, message: OnionMessage): Promise<ReplyCell> {
    const relay = this.relays.get(relayId)
    if (!relay) throw new Error(`no relay registered for id ${relayId}`)
    return relay.handle(message)
  }
}
