/**
 * Per-seller circuit memory. Anti-stickiness is only meaningful if "recently
 * used" persists ACROSS redemptions — otherwise every request re-rolls from a
 * clean slate and concentration reappears. This holds a bounded, most-recent-
 * first list of relay ids per seller identity, feeding `selectCircuit` and
 * updated after each send.
 *
 * Identity is an opaque key — use the seller's shielded credit commitment, so
 * the memory is keyed by the same anonymous handle the payment rail uses and
 * never by a real-world identity.
 */
export class CircuitMemory {
  private readonly maxRecent: number
  private readonly recentByIdentity = new Map<string, string[]>()

  constructor(maxRecent = 12) {
    if (maxRecent <= 0) throw new Error('maxRecent must be > 0')
    this.maxRecent = maxRecent
  }

  /** Recently-used relay ids for an identity, most-recent-first. */
  recent(identity: string): string[] {
    return this.recentByIdentity.get(identity)?.slice() ?? []
  }

  /** Record a circuit's relays as used, newest first, bounded to `maxRecent`. */
  record(identity: string, relayIds: string[]): void {
    const prior = this.recentByIdentity.get(identity) ?? []
    const merged = [...relayIds, ...prior].slice(0, this.maxRecent)
    this.recentByIdentity.set(identity, merged)
  }

  /** Forget an identity (e.g. a rotated commitment). */
  forget(identity: string): void {
    this.recentByIdentity.delete(identity)
  }
}
