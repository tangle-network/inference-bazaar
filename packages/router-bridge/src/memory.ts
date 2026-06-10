/**
 * Per-seller operator memory. Anti-stickiness only means something if "recently
 * used" persists ACROSS redemptions — otherwise every request re-rolls from a
 * clean slate and concentration reappears. This holds a bounded, most-recent-
 * first list of operator ids per seller identity, feeding `selectOperators` and
 * updated after each redemption.
 *
 * Identity is an opaque key — use the seller's shielded credit commitment, so
 * the memory is keyed by the same anonymous handle the payment rail uses and
 * never by a real-world identity.
 */
export class OperatorMemory {
  private readonly maxRecent: number
  private readonly recentByIdentity = new Map<string, string[]>()

  constructor(maxRecent = 12) {
    if (maxRecent <= 0) throw new Error('maxRecent must be > 0')
    this.maxRecent = maxRecent
  }

  /** Recently-used operator ids for an identity, most-recent-first. */
  recent(identity: string): string[] {
    return this.recentByIdentity.get(identity)?.slice() ?? []
  }

  /** Record operators as used, newest first, bounded to `maxRecent`. */
  record(identity: string, operatorIds: string[]): void {
    const prior = this.recentByIdentity.get(identity) ?? []
    const merged = [...operatorIds, ...prior].slice(0, this.maxRecent)
    this.recentByIdentity.set(identity, merged)
  }

  /** Forget an identity (e.g. a rotated commitment). */
  forget(identity: string): void {
    this.recentByIdentity.delete(identity)
  }
}
