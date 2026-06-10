import { describe, expect, it } from 'vitest'
import { OperatorMemory } from '../src/memory'
import { type OperatorRef, selectOperators } from '../src/selection'

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const operators: OperatorRef[] = Array.from({ length: 8 }, (_, i) => ({ id: `op${i}` }))

describe('selectOperators anti-stickiness', () => {
  it('returns the requested count, all distinct', () => {
    const picked = selectOperators({ operators, count: 3, rand: mulberry32(1) })
    expect(picked).toHaveLength(3)
    expect(new Set(picked.map((o) => o.id)).size).toBe(3)
  })

  it('is deterministic for a fixed rand source', () => {
    const a = selectOperators({ operators, count: 3, rand: mulberry32(7) })
    const b = selectOperators({ operators, count: 3, rand: mulberry32(7) })
    expect(a.map((o) => o.id)).toEqual(b.map((o) => o.id))
  })

  it('selects recently-used operators less often over many redemptions', () => {
    const recent = ['op0', 'op1']
    const counts = new Map<string, number>()
    for (let trial = 0; trial < 400; trial += 1) {
      const [op] = selectOperators({
        operators,
        count: 1,
        recentIds: recent,
        stickinessPenalty: 0.9,
        rand: mulberry32(trial + 1),
      })
      counts.set(op!.id, (counts.get(op!.id) ?? 0) + 1)
    }
    const fresh = counts.get('op4') ?? 0
    expect((counts.get('op0') ?? 0)).toBeLessThan(fresh)
    expect((counts.get('op1') ?? 0)).toBeLessThan(fresh)
  })

  it('throws when there are too few operators', () => {
    expect(() => selectOperators({ operators: operators.slice(0, 2), count: 3 })).toThrow(/operators/)
  })
})

describe('OperatorMemory', () => {
  it('keeps recent operators newest-first, bounded, and per-identity', () => {
    const memory = new OperatorMemory(4)
    memory.record('seller-a', ['op0', 'op1', 'op2'])
    memory.record('seller-b', ['op5'])
    expect(memory.recent('seller-a')).toEqual(['op0', 'op1', 'op2'])
    memory.record('seller-a', ['op3'])
    expect(memory.recent('seller-a')).toEqual(['op3', 'op0', 'op1', 'op2'])
    memory.record('seller-a', ['op9']) // bounded to 4
    expect(memory.recent('seller-a')).toEqual(['op9', 'op3', 'op0', 'op1'])
    expect(memory.recent('seller-b')).toEqual(['op5']) // independent
    memory.forget('seller-a')
    expect(memory.recent('seller-a')).toEqual([])
  })
})
