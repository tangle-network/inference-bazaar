import { describe, expect, it } from 'vitest'
import {
  costMicro,
  CreditBook,
  DefaultRedemptionAdapter,
  MockOperator,
  SimulatedRouter,
  type Credit,
  type ServeOutcome,
} from '../src/index'

const MODEL = 'anthropic/claude-opus-4-8'
const STRIKE = 14_900_000
const LIST = 15_000_000

function credit(overrides: Partial<Credit> = {}): Credit {
  const qty = overrides.qtyIssued ?? 1_000
  const strike = overrides.strikeMicroPerM ?? STRIKE
  return {
    id: 'cr_1',
    owner: 'buyer_1',
    model: MODEL,
    tokenKind: 'output',
    qtyIssued: qty,
    qtyRemaining: overrides.qtyRemaining ?? qty,
    strikeMicroPerM: strike,
    backingMicro: costMicro(strike, overrides.qtyRemaining ?? qty),
    expiry: 2_000_000_000,
    ...overrides,
  }
}

function setup(credits: Credit[]) {
  const book = new CreditBook()
  for (const c of credits) book.issue(c)
  const adapter = new DefaultRedemptionAdapter(book)
  const router = new SimulatedRouter({ adapter, listPriceMicroPerM: LIST })
  router.deposit('buyer_1', 10_000_000)
  return { book, adapter, router }
}

describe('overflow falls back (§8.3)', () => {
  it('debits the remainder, bills the overflow at list from the buyer balance', () => {
    const { book, router } = setup([credit({ qtyIssued: 1_000 })])
    const operator = new MockOperator('op_alpha')
    const outcome = router.serve({
      owner: 'buyer_1',
      model: MODEL,
      tokenKind: 'output',
      tokens: 1_500,
      ts: 1_000_000_000,
      operator,
    })
    expect(outcome.source).toBe('credit')
    expect(outcome.tokensDebited).toBe(1_000)
    expect(outcome.overflowTokens).toBe(500)
    expect(outcome.paidFromBackingMicro).toBe(costMicro(STRIKE, 1_000))
    expect(outcome.billedToBalanceMicro).toBe(costMicro(LIST, 500))
    expect(router.balanceOf('buyer_1')).toBe(10_000_000 - costMicro(LIST, 500))
    expect(operator.paidFromBackingMicro).toBe(costMicro(STRIKE, 1_000))
    expect(operator.paidFromBalanceMicro).toBe(costMicro(LIST, 500))
    expect(book.get('cr_1')!.qtyRemaining).toBe(0)
  })

  it('never over-debits: a fully-drained credit yields insufficient-quota', () => {
    const { book } = setup([credit({ qtyIssued: 1_000 })])
    book.debit({
      creditId: 'cr_1',
      model: MODEL,
      tokenKind: 'output',
      tokens: 1_000,
      ts: 1_000_000_000,
      operator: 'op_alpha',
    })
    const drained = book.debit({
      creditId: 'cr_1',
      model: MODEL,
      tokenKind: 'output',
      tokens: 1,
      ts: 1_000_000_000,
      operator: 'op_alpha',
    })
    expect(drained).toEqual({ kind: 'insufficient-quota', qtyRemaining: 0, requested: 1 })
  })
})

describe('expiry refunds the remainder (§8.4)', () => {
  it('rejects calls after expiry; close refunds exactly backingRemaining', () => {
    const { book, adapter } = setup([credit({ expiry: 1_000 })])
    book.debit({
      creditId: 'cr_1',
      model: MODEL,
      tokenKind: 'output',
      tokens: 300,
      ts: 900,
      operator: 'op_alpha',
    })
    const backingRemaining = book.get('cr_1')!.backingMicro
    expect(backingRemaining).toBe(costMicro(STRIKE, 700))

    expect(adapter.selectCredit('buyer_1', MODEL, 'output', 1_001)).toBeNull()
    const late = book.debit({
      creditId: 'cr_1',
      model: MODEL,
      tokenKind: 'output',
      tokens: 1,
      ts: 1_001,
      operator: 'op_alpha',
    })
    expect(late).toEqual({ kind: 'expired', expiry: 1_000, ts: 1_001 })

    const refund = book.close('cr_1', 1_001)
    expect(refund).toEqual({
      creditId: 'cr_1',
      owner: 'buyer_1',
      amountMicro: backingRemaining,
      reason: 'expired',
      ts: 1_001,
    })
    expect(book.close('cr_1', 1_002)).toBeUndefined()
    expect(
      book.debit({
        creditId: 'cr_1',
        model: MODEL,
        tokenKind: 'output',
        tokens: 1,
        ts: 999,
        operator: 'op_alpha',
      }),
    ).toEqual({ kind: 'unknown-credit', creditId: 'cr_1' })
  })
})

describe('wrong instrument rejected (§8.5)', () => {
  it('an :output credit cannot pay an :input call', () => {
    const { book, adapter } = setup([credit({ tokenKind: 'output' })])
    expect(adapter.selectCredit('buyer_1', MODEL, 'input', 1_000_000_000)).toBeNull()
    const result = book.debit({
      creditId: 'cr_1',
      model: MODEL,
      tokenKind: 'input',
      tokens: 10,
      ts: 1_000_000_000,
      operator: 'op_alpha',
    })
    expect(result).toEqual({
      kind: 'wrong-instrument',
      expected: `${MODEL}:output`,
      got: `${MODEL}:input`,
    })
  })

  it('a credit for another model cannot pay this call', () => {
    const { book } = setup([credit({ model: 'openai/gpt-5' })])
    const result = book.debit({
      creditId: 'cr_1',
      model: MODEL,
      tokenKind: 'output',
      tokens: 10,
      ts: 1_000_000_000,
      operator: 'op_alpha',
    })
    expect(result).toEqual({
      kind: 'wrong-instrument',
      expected: 'openai/gpt-5:output',
      got: `${MODEL}:output`,
    })
  })
})

describe('selection policy', () => {
  it('soonest-expiry-first, deterministic tie-break by id', () => {
    const { adapter } = setup([
      credit({ id: 'cr_late', expiry: 2_000 }),
      credit({ id: 'cr_soon', expiry: 1_500 }),
      credit({ id: 'cr_also_soon', expiry: 1_500 }),
    ])
    expect(adapter.selectCredit('buyer_1', MODEL, 'output', 1_000)?.id).toBe('cr_also_soon')
    expect(adapter.selectCredit('buyer_2', MODEL, 'output', 1_000)).toBeNull()
  })

  it('exhausting one credit rolls to the next', () => {
    const { router } = setup([
      credit({ id: 'cr_a', qtyIssued: 100, expiry: 1_500 }),
      credit({ id: 'cr_b', qtyIssued: 100, expiry: 2_000 }),
    ])
    const operator = new MockOperator('op_alpha')
    const serve = (tokens: number) =>
      router.serve({ owner: 'buyer_1', model: MODEL, tokenKind: 'output', tokens, ts: 1_000, operator })
    expect(serve(100)).toMatchObject({ creditId: 'cr_a', tokensDebited: 100, overflowTokens: 0 })
    expect(serve(60)).toMatchObject({ creditId: 'cr_b', tokensDebited: 60, overflowTokens: 0 })
    expect(serve(60)).toMatchObject({ creditId: 'cr_b', tokensDebited: 40, overflowTokens: 20 })
    expect(serve(10)).toMatchObject({ source: 'balance', creditId: null })
  })
})

describe('determinism (§8.6)', () => {
  it('same call sequence → same debits, payouts, and final state', () => {
    const sequence = [137, 1, 999, 250, 88, 13, 412] // partial drain, then overflow later
    const run = (): { outcomes: ServeOutcome[]; finalBalance: number; finalCredit: Credit } => {
      const { book, router } = setup([credit({ qtyIssued: 1_500 })])
      const operator = new MockOperator('op_alpha')
      const outcomes = sequence.map((tokens) =>
        router.serve({
          owner: 'buyer_1',
          model: MODEL,
          tokenKind: 'output',
          tokens,
          ts: 1_000_000_000,
          operator,
        }),
      )
      return { outcomes, finalBalance: router.balanceOf('buyer_1'), finalCredit: book.get('cr_1')! }
    }
    expect(run()).toEqual(run())
  })
})
