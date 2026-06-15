/**
 * Consumer-side privacy: a Tor preference + anti-sticky operator selection.
 *
 * The operator is the SELLER (it issues lots and serves the model); the party
 * who needs privacy is the CONSUMER — the buyer/holder who redeems a lot — and
 * the privacy is *from* the operators. Two separable problems (see
 * ARCHITECTURE.md "Privacy"):
 *  - NETWORK anonymity: hide the consumer's IP from the fulfilling operator. That
 *    is Tor's job — when privacy is on, the app dials the operator's `.onion`
 *    (via `endpointFor` in venues.ts). A plain browser cannot SOCKS-proxy fetch,
 *    so effective anonymity requires Tor Browser / a system Tor proxy (or the
 *    Node SDK's TorRedemptionClient). This module only records the preference.
 *  - ANTI-STICKINESS: which operator a consumer ACQUIRES credits from (a lot can
 *    only be redeemed against its own issuer, so acquisition is the lever). Left
 *    naive, a consumer's flow concentrates on a few operators who can correlate
 *    it. `pickAntiSticky` weights acquisition away from recently-used operators,
 *    persisting the recent list per identity in localStorage.
 *
 * Ported from `@inference-bazaar/router-bridge` (selectOperators + OperatorMemory); the
 * app is a separate workspace and cannot import it directly. Keep in sync.
 */

const PRIVACY_KEY = 'inference-bazaar.privacy'
const RECENT_KEY = 'inference-bazaar.recentOperators'
const MAX_RECENT = 12
const STICKINESS_PENALTY = 0.8

export function privacyOn(): boolean {
  try {
    return localStorage.getItem(PRIVACY_KEY) === 'tor'
  } catch {
    return false
  }
}

export function setPrivacy(on: boolean): void {
  try {
    localStorage.setItem(PRIVACY_KEY, on ? 'tor' : 'off')
  } catch {
    /* storage unavailable — privacy stays off */
  }
}

function recentFor(identity: string): string[] {
  try {
    const all = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '{}') as Record<string, string[]>
    return all[identity] ?? []
  } catch {
    return []
  }
}

/** Record `operatorId` as most-recently-used for `identity` (bounded, deduped). */
export function rememberOperator(identity: string, operatorId: string): void {
  try {
    const all = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '{}') as Record<string, string[]>
    const next = [operatorId, ...(all[identity] ?? []).filter((id) => id !== operatorId)].slice(0, MAX_RECENT)
    all[identity] = next
    localStorage.setItem(RECENT_KEY, JSON.stringify(all))
  } catch {
    /* storage unavailable — anti-stickiness degrades to none */
  }
}

/**
 * Pick one operator id weighted AWAY from `identity`'s recently-used ones.
 * weight(op) = max(ε, 1 − penalty·recencyWeight); recencyWeight decays linearly
 * with position (last-used penalized most); ε keeps every operator possible.
 * Faithful port of router-bridge selectOperators (count = 1).
 */
export function pickAntiSticky(operatorIds: string[], identity: string, rand: () => number = Math.random): string {
  if (operatorIds.length === 0) throw new Error('no operators to pick from')
  const recent = recentFor(identity)
  const recencyWeight = new Map<string, number>()
  recent.forEach((id, index) => {
    const w = 1 - index / Math.max(recent.length, 1)
    recencyWeight.set(id, Math.max(recencyWeight.get(id) ?? 0, w))
  })
  const pool = operatorIds.map((id) => ({
    id,
    weight: Math.max(0.02, 1 - STICKINESS_PENALTY * (recencyWeight.get(id) ?? 0)),
  }))
  const total = pool.reduce((sum, p) => sum + p.weight, 0)
  let target = rand() * total
  for (const p of pool) {
    target -= p.weight
    if (target <= 0) return p.id
  }
  return pool[pool.length - 1]!.id
}
