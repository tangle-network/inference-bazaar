/**
 * Anti-sticky operator selection.
 *
 * Tor (via Arti) anonymizes the network pipe — it hides the seller's IP and
 * gives Tor-grade circuit anonymity. It does NOT decide WHICH marketplace
 * operator fulfills a redemption. If we always picked the cheapest/closest
 * operator, a seller's flow would still concentrate on a few operators who
 * could correlate volume + timing across redemptions. This is the application-
 * layer piece Tor can't cover, so it stays: pick fulfilling operators weighted
 * AWAY from the ones this seller used recently.
 */

export interface OperatorRef {
  /** Operator id / router slug. */
  id: string
}

export interface SelectOperatorsOptions<T extends OperatorRef> {
  operators: T[]
  /** How many distinct operators to return. Default 1. */
  count?: number
  /** Operator ids this seller used recently, most-recent-first. */
  recentIds?: string[]
  /** Deterministic uniform source in [0,1). Inject for tests. */
  rand?: () => number
  /**
   * Per-occurrence penalty for a recently-used operator, scaled by its recency
   * weight. 0 = no anti-stickiness; 1 = strong avoidance. Default 0.8.
   */
  stickinessPenalty?: number
}

/**
 * Choose `count` distinct operators, weighted away from recently-used ones.
 *
 * weight(op) = max(ε, 1 − penalty·recencyWeight). recencyWeight decays linearly
 * with position in `recentIds` (last-used penalized most). ε > 0 keeps a fully-
 * penalized operator possible — availability beats a perfect avoid.
 */
export function selectOperators<T extends OperatorRef>(opts: SelectOperatorsOptions<T>): T[] {
  const { operators } = opts
  const count = opts.count ?? 1
  if (count <= 0) throw new Error('count must be > 0')
  if (operators.length < count) {
    throw new Error(`need >= ${count} operators, have ${operators.length}`)
  }
  const rand = opts.rand ?? Math.random
  const penalty = opts.stickinessPenalty ?? 0.8
  const recent = opts.recentIds ?? []
  const recencyWeight = new Map<string, number>()
  recent.forEach((id, index) => {
    const w = 1 - index / Math.max(recent.length, 1)
    recencyWeight.set(id, Math.max(recencyWeight.get(id) ?? 0, w))
  })

  const pool = operators.map((operator) => ({
    operator,
    weight: Math.max(0.02, 1 - penalty * (recencyWeight.get(operator.id) ?? 0)),
  }))

  const chosen: T[] = []
  for (let pick = 0; pick < count; pick += 1) {
    const total = pool.reduce((sum, p) => sum + p.weight, 0)
    let target = rand() * total
    let pickIndex = pool.length - 1
    for (let i = 0; i < pool.length; i += 1) {
      target -= pool[i]!.weight
      if (target <= 0) {
        pickIndex = i
        break
      }
    }
    chosen.push(pool[pickIndex]!.operator)
    pool.splice(pickIndex, 1) // distinct
  }
  return chosen
}
