import { describe, expect, it } from 'vitest'
import {
  costMicro,
  CreditBook,
  ShieldedRedemptionPlanner,
  type Credit,
  type PlannedSpendAuth,
} from '../src/index'

const MODEL = 'anthropic/claude-opus-4-8'
const STRIKE = 14_900_000
const QTY = 100_000
const COMMITMENT = `0x${'ab'.repeat(32)}`
const OPERATOR = `0x${'cd'.repeat(20)}`

function credit(overrides: Partial<Credit> = {}): Credit {
  const qty = overrides.qtyIssued ?? QTY
  return {
    id: 'cr_1',
    owner: COMMITMENT,
    model: MODEL,
    tokenKind: 'output',
    qtyIssued: qty,
    qtyRemaining: qty,
    strikeMicroPerM: STRIKE,
    backingMicro: costMicro(STRIKE, qty),
    expiry: 2_000_000_000,
    ...overrides,
  }
}

function setup(credits: Credit[] = [credit()]) {
  const book = new CreditBook()
  const planner = new ShieldedRedemptionPlanner(book)
  for (const c of credits) {
    book.issue(c)
    planner.bind({
      creditId: c.id,
      commitment: c.owner,
      operatorAddress: OPERATOR,
      serviceId: 7n,
    })
  }
  return { book, planner }
}

const call = (tokens: number, ts = 1_000_000_000, creditId = 'cr_1') => ({
  creditId,
  model: MODEL,
  tokenKind: 'output' as const,
  tokens,
  ts,
  operator: 'op_alpha',
})

// Same odd-sized sequence as the closure proof — sums to exactly QTY.
const CALLS = [33_333, 7, 12_345, 1, 999, 25_000, 8_641, 19_674]

describe('auth-layer unit closure', () => {
  it('sum of auth amounts == backing issued; nonces monotonic; operator pinned', () => {
    const { book, planner } = setup()
    const backingIssued = BigInt(book.get('cr_1')!.backingMicro)

    let total = 0n
    let expectedNonce = 0n
    for (const tokens of CALLS) {
      const planned = planner.authorize(call(tokens))
      if ('kind' in planned) throw new Error(`unexpected error: ${planned.kind}`)
      expect(planned.auth.amount).toBe(BigInt(planned.debit.operatorPayoutMicro))
      expect(planned.auth.operator).toBe(OPERATOR)
      expect(planned.auth.commitment).toBe(COMMITMENT)
      expect(planned.auth.serviceId).toBe(7n)
      expect(planned.auth.nonce).toBe(expectedNonce)
      expect(planned.auth.expiry).toBe(BigInt(1_000_000_000 + 300))
      expectedNonce++
      total += planned.auth.amount
    }

    expect(total).toBe(backingIssued) // escrow exhausts exactly when quota does
    expect(book.get('cr_1')!.qtyRemaining).toBe(0)
    expect(book.get('cr_1')!.backingMicro).toBe(0)
  })

  it('a drained credit authorizes nothing further', () => {
    const { planner } = setup()
    for (const tokens of CALLS) planner.authorize(call(tokens))
    expect(planner.authorize(call(1))).toEqual({
      kind: 'insufficient-quota',
      qtyRemaining: 0,
      requested: 1,
    })
  })
})

describe('rejected calls never burn replay protection', () => {
  it('expired and wrong-instrument calls consume no nonce', () => {
    const { planner } = setup([credit({ expiry: 1_000 })])

    const late = planner.authorize(call(10, 1_001))
    expect(late).toEqual({ kind: 'expired', expiry: 1_000, ts: 1_001 })

    const wrongKind = planner.authorize({ ...call(10, 900), tokenKind: 'input' })
    expect(wrongKind).toMatchObject({ kind: 'wrong-instrument' })

    const ok = planner.authorize(call(10, 900))
    if ('kind' in ok) throw new Error('expected success')
    expect(ok.auth.nonce).toBe(0n) // first nonce, despite two prior rejections
  })

  it('unbound credits are rejected; double-binding throws', () => {
    const { book, planner } = setup()
    book.issue(credit({ id: 'cr_unbound' }))
    expect(planner.authorize(call(10, 1_000_000_000, 'cr_unbound'))).toEqual({
      kind: 'unknown-credit',
      creditId: 'cr_unbound',
    })
    expect(() =>
      planner.bind({ creditId: 'cr_1', commitment: COMMITMENT, operatorAddress: OPERATOR, serviceId: 7n }),
    ).toThrow(/already bound/)
    expect(() =>
      planner.bind({ creditId: 'cr_ghost', commitment: COMMITMENT, operatorAddress: OPERATOR, serviceId: 7n }),
    ).toThrow(/unknown credit/)
  })
})

describe('independent escrows', () => {
  it('credits on different commitments keep independent nonce streams', () => {
    const other = `0x${'ef'.repeat(32)}`
    const { planner } = setup([
      credit({ id: 'cr_a', qtyIssued: 100, qtyRemaining: 100, backingMicro: costMicro(STRIKE, 100) }),
      credit({
        id: 'cr_b',
        owner: other,
        qtyIssued: 100,
        qtyRemaining: 100,
        backingMicro: costMicro(STRIKE, 100),
      }),
    ])
    const a1 = planner.authorize(call(10, 1_000_000_000, 'cr_a')) as PlannedSpendAuth
    const b1 = planner.authorize(call(10, 1_000_000_000, 'cr_b')) as PlannedSpendAuth
    const a2 = planner.authorize(call(10, 1_000_000_000, 'cr_a')) as PlannedSpendAuth
    expect(a1.auth.nonce).toBe(0n)
    expect(b1.auth.nonce).toBe(0n)
    expect(a2.auth.nonce).toBe(1n)
    expect(b1.auth.commitment).toBe(other)
  })
})

describe('determinism', () => {
  it('same call sequence → identical auth stream', () => {
    const run = () => {
      const { planner } = setup()
      return CALLS.map((tokens) => planner.authorize(call(tokens)))
    }
    expect(run()).toEqual(run())
  })
})
