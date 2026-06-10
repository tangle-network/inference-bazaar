import { describe, expect, it } from 'vitest'
import { OnionClient } from '../src/client'
import { CircuitMemory } from '../src/memory'
import { InMemoryOnionNetwork } from '../src/network'
import {
  CELL_SIZE,
  generateRelayKeypair,
  padToCell,
  type Relay,
  type RelayKeypair,
  unpadCell,
  wrapOnion,
} from '../src/onion'
import { type ExitHandler, OnionRelay } from '../src/relay'

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Stand up an N-relay in-memory network where every relay can both forward and
 * act as exit. The exit handler is supplied per test.
 */
function buildNetwork(
  ids: string[],
  exitHandler: ExitHandler,
): { network: InMemoryOnionNetwork; directory: Relay[]; keys: RelayKeypair[] } {
  const network = new InMemoryOnionNetwork()
  const keys = ids.map(generateRelayKeypair)
  for (const key of keys) {
    network.register(new OnionRelay({ keypair: key, transport: network, exitHandler }))
  }
  return { network, directory: keys.map((k) => ({ id: k.id, publicKey: k.publicKey })), keys }
}

describe('onion network — end to end', () => {
  it('round-trips a request and response through a 3-hop circuit', async () => {
    // Exit "fulfills inference" by upcasing the request; proves the seller gets
    // a real response back through the layered return path.
    const { network, directory } = buildNetwork(
      ['op0', 'op1', 'op2', 'op3', 'op4'],
      (req) => Buffer.from(`RESPONSE:${req.toString()}`),
    )
    const client = new OnionClient({ directory, transport: network, rand: mulberry32(3) })

    const { response, circuit } = await client.send(
      'seller-commitment-abc',
      Buffer.from('infer:claude-opus-4-8:hello'),
    )
    expect(response.toString()).toBe('RESPONSE:infer:claude-opus-4-8:hello')
    expect(circuit).toHaveLength(3)
    expect(new Set(circuit).size).toBe(3)
  })

  it('no single relay sees both the seller and the request content', async () => {
    // Each relay records what it could observe. We assert the exit sees the
    // request but not the origin, and the entry sees the origin (transport) but
    // not the request.
    const observed: Record<string, { sawRequest: boolean }> = {}
    const network = new InMemoryOnionNetwork()
    const keys = ['a', 'b', 'c'].map(generateRelayKeypair)
    const SECRET = 'SECRET-PROMPT-12345'
    for (const key of keys) {
      observed[key.id] = { sawRequest: false }
      network.register(
        new OnionRelay({
          keypair: key,
          transport: network,
          exitHandler: (req) => {
            observed[key.id]!.sawRequest = req.toString().includes(SECRET)
            return Buffer.from('ok')
          },
        }),
      )
    }
    const directory = keys.map((k) => ({ id: k.id, publicKey: k.publicKey }))
    const client = new OnionClient({ directory, transport: network, rand: mulberry32(1) })
    const { circuit } = await client.send('seller-x', Buffer.from(SECRET))

    const exitId = circuit[2]!
    const entryId = circuit[0]!
    // Only the exit relay ever decrypted the request payload.
    expect(observed[exitId]!.sawRequest).toBe(true)
    expect(observed[entryId]!.sawRequest).toBe(false)
    expect(observed[circuit[1]!]!.sawRequest).toBe(false)
  })

  it('rejects a replayed onion at the entry relay', async () => {
    const network = new InMemoryOnionNetwork()
    const key = generateRelayKeypair('solo')
    network.register(
      new OnionRelay({ keypair: key, transport: network, exitHandler: () => Buffer.from('ok') }),
    )
    const { message } = wrapOnion([{ id: key.id, publicKey: key.publicKey }], padToCell(Buffer.from('x')))
    await expect(network.send('solo', message)).resolves.toBeDefined()
    // Same sealed bytes again → replay.
    await expect(network.send('solo', message)).rejects.toThrow(/replay/i)
  })

  it('pads payloads to a fixed cell size so length does not leak', () => {
    const small = padToCell(Buffer.from('hi'))
    const bigger = padToCell(Buffer.from('a much longer inference prompt that is still under a cell'))
    expect(small.length).toBe(CELL_SIZE)
    expect(bigger.length).toBe(CELL_SIZE) // same on-wire size despite different content
    expect(unpadCell(small).toString()).toBe('hi')
    // A payload spanning two cells rounds up, still hiding exact length.
    const large = padToCell(Buffer.alloc(CELL_SIZE))
    expect(large.length).toBe(CELL_SIZE * 2)
  })
})

describe('onion client — cross-redemption privacy', () => {
  it('spreads circuits across operators over repeated redemptions', async () => {
    const ids = Array.from({ length: 8 }, (_, i) => `op${i}`)
    const { network, directory } = buildNetwork(ids, (req) => req)
    const memory = new CircuitMemory(6)
    // Distinct rand per send so selection varies; memory drives the spread.
    let seed = 100
    const client = new OnionClient({
      directory,
      transport: network,
      memory,
      stickinessPenalty: 0.9,
      rand: () => mulberry32(seed)(),
    })

    const usage = new Map<string, number>()
    for (let i = 0; i < 30; i += 1) {
      seed += 1
      const { circuit } = await client.send('seller-1', Buffer.from(`req-${i}`))
      for (const id of circuit) usage.set(id, (usage.get(id) ?? 0) + 1)
    }
    // Every operator gets used at least once — flow does not collapse onto a
    // sticky few. (Without memory + penalty, selection clusters.)
    expect(usage.size).toBe(8)
    const counts = [...usage.values()]
    const max = Math.max(...counts)
    const min = Math.min(...counts)
    // Spread is bounded: the busiest operator is not wildly above the quietest.
    expect(max - min).toBeLessThanOrEqual(12)
  })

  it('keeps two sellers’ circuit histories independent', async () => {
    const memory = new CircuitMemory(4)
    memory.record('seller-a', ['op0', 'op1', 'op2'])
    memory.record('seller-b', ['op5', 'op6', 'op7'])
    expect(memory.recent('seller-a')).toEqual(['op0', 'op1', 'op2'])
    expect(memory.recent('seller-b')).toEqual(['op5', 'op6', 'op7'])
    memory.record('seller-a', ['op3'])
    expect(memory.recent('seller-a')).toEqual(['op3', 'op0', 'op1', 'op2'])
    expect(memory.recent('seller-b')).toEqual(['op5', 'op6', 'op7']) // untouched
  })
})
