import { describe, expect, it } from 'vitest'
import {
  generateRelayKeypair,
  peelOnion,
  type Relay,
  selectCircuit,
  wrapOnion,
} from '../src/onion'

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('onion wrap/peel', () => {
  it('delivers the payload through a 3-hop circuit, one layer per relay', () => {
    const keys = ['r1', 'r2', 'r3'].map(generateRelayKeypair)
    const byId = new Map(keys.map((k) => [k.id, k]))
    const circuit: Relay[] = keys.map((k) => ({ id: k.id, publicKey: k.publicKey }))
    const payload = Buffer.from('inference-request:claude-opus-4-8:prompt-hash-abc')

    let message = wrapOnion(circuit, payload).message
    const path: string[] = []
    let exitPayload: Buffer | undefined
    let hopId: string | null = circuit[0]!.id
    while (hopId) {
      path.push(hopId)
      const relay = byId.get(hopId)!
      const peeled = peelOnion(relay.privateKey, message)
      if (peeled.next === null) {
        exitPayload = peeled.payload
        break
      }
      message = JSON.parse(peeled.payload.toString())
      hopId = peeled.next
    }

    expect(path).toEqual(['r1', 'r2', 'r3'])
    expect(exitPayload?.toString()).toBe(payload.toString())
  })

  it('a relay sees only its next hop, never the origin or final payload', () => {
    const keys = ['a', 'b', 'c'].map(generateRelayKeypair)
    const circuit: Relay[] = keys.map((k) => ({ id: k.id, publicKey: k.publicKey }))
    const secret = Buffer.from('TOP-SECRET-INFERENCE')
    const message = wrapOnion(circuit, secret).message

    // First relay's view: knows next = 'b', payload is still an onion (not the secret).
    const first = peelOnion(keys[0]!.privateKey, message)
    expect(first.next).toBe('b')
    expect(first.payload.toString()).not.toContain('TOP-SECRET')

    // Wrong key cannot peel — AEAD auth tag fails.
    expect(() => peelOnion(keys[2]!.privateKey, message)).toThrow()
  })

  it('tampering with ciphertext is rejected by the auth tag', () => {
    const relay = generateRelayKeypair('solo')
    const message = wrapOnion([{ id: relay.id, publicKey: relay.publicKey }], Buffer.from('x')).message
    const tampered = { ...message, ciphertext: message.ciphertext.replace(/.$/, '0') }
    expect(() => peelOnion(relay.privateKey, tampered)).toThrow()
  })
})

describe('selectCircuit anti-stickiness', () => {
  const relays: Relay[] = Array.from({ length: 8 }, (_, i) => ({
    id: `op${i}`,
    publicKey: '00'.repeat(32),
  }))

  it('selects distinct relays of the requested length', () => {
    const circuit = selectCircuit({ relays, length: 3, rand: mulberry32(1) })
    expect(circuit).toHaveLength(3)
    expect(new Set(circuit.map((r) => r.id)).size).toBe(3)
  })

  it('is deterministic for a fixed rand source', () => {
    const a = selectCircuit({ relays, length: 3, rand: mulberry32(7) })
    const b = selectCircuit({ relays, length: 3, rand: mulberry32(7) })
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id))
  })

  it('spreads flow away from recently-used relays over many redemptions', () => {
    const recentHeavy = ['op0', 'op1']
    const exitCounts = new Map<string, number>()
    for (let trial = 0; trial < 400; trial += 1) {
      const circuit = selectCircuit({
        relays,
        length: 3,
        recentRelayIds: recentHeavy,
        stickinessPenalty: 0.9,
        rand: mulberry32(trial + 1),
      })
      for (const r of circuit) exitCounts.set(r.id, (exitCounts.get(r.id) ?? 0) + 1)
    }
    // The two recently-used relays should be selected materially less than a
    // fresh relay across the run.
    const fresh = exitCounts.get('op4') ?? 0
    const recent0 = exitCounts.get('op0') ?? 0
    const recent1 = exitCounts.get('op1') ?? 0
    expect(recent0).toBeLessThan(fresh)
    expect(recent1).toBeLessThan(fresh)
  })

  it('throws when there are too few relays for the circuit', () => {
    expect(() => selectCircuit({ relays: relays.slice(0, 2), length: 3 })).toThrow(/relays/)
  })
})
