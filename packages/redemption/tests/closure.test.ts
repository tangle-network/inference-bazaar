import { describe, expect, it } from 'vitest'
import {
  costMicro,
  CreditBook,
  DefaultRedemptionAdapter,
  MockOperator,
  SimulatedRouter,
  type Credit,
} from '../src/index'

const MODEL = 'anthropic/claude-opus-4-8'
const STRIKE = 14_900_000 // $14.90/M — bought below a $15.00/M list
const LIST = 15_000_000
const QTY = 100_000

function credit(overrides: Partial<Credit> = {}): Credit {
  const qty = overrides.qtyIssued ?? QTY
  const strike = overrides.strikeMicroPerM ?? STRIKE
  return {
    id: 'cr_1',
    owner: 'buyer_1',
    model: MODEL,
    tokenKind: 'output',
    qtyIssued: qty,
    qtyRemaining: qty,
    strikeMicroPerM: strike,
    backingMicro: costMicro(strike, qty),
    expiry: 2_000_000_000,
    ...overrides,
  }
}

// Odd-sized calls summing to exactly QTY, so per-call rounding gets exercised.
const CALLS = [33_333, 7, 12_345, 1, 999, 25_000, 8_641, 19_674]

describe('unit closure (§8.1)', () => {
  it('100k bought = 100k metered = 100k spent, invariants after every debit', () => {
    expect(CALLS.reduce((a, b) => a + b, 0)).toBe(QTY)
    const book = new CreditBook()
    const issued = credit()
    const backingIssued = issued.backingMicro
    expect(backingIssued).toBe(1_490_000) // $1.49 escrowed for 100k @ $14.90/M
    book.issue(issued)

    let debitedTotal = 0
    let payoutTotal = 0
    for (const tokens of CALLS) {
      const result = book.debit({
        creditId: 'cr_1',
        model: MODEL,
        tokenKind: 'output',
        tokens,
        ts: 1_000_000_000,
        operator: 'op_alpha',
      })
      if ('kind' in result) throw new Error(`unexpected debit error: ${result.kind}`)
      debitedTotal += result.tokensDebited
      payoutTotal += result.operatorPayoutMicro

      const state = book.get('cr_1')!
      // §5 invariant 1: backing tracks the quota exactly, every step
      expect(state.backingMicro).toBe(costMicro(STRIKE, state.qtyRemaining))
      // §5 invariant 2: quota conserved
      expect(state.qtyIssued).toBe(state.qtyRemaining + debitedTotal)
      // §5 invariant 3: money conserved
      expect(backingIssued).toBe(state.backingMicro + payoutTotal)
    }

    expect(debitedTotal).toBe(QTY)
    expect(payoutTotal).toBe(backingIssued)
    const final = book.get('cr_1')!
    expect(final.qtyRemaining).toBe(0)
    expect(final.backingMicro).toBe(0)
  })

  it('exhaustion close emits a zero refund (nothing left to return)', () => {
    const book = new CreditBook()
    book.issue(credit({ qtyIssued: 10, qtyRemaining: 10, backingMicro: costMicro(STRIKE, 10) }))
    const result = book.debit({
      creditId: 'cr_1',
      model: MODEL,
      tokenKind: 'output',
      tokens: 10,
      ts: 1_000_000_000,
      operator: 'op_alpha',
    })
    expect(result).toMatchObject({ exhausted: true, backingRemaining: 0 })
    expect(book.close('cr_1', 1_000_000_001)).toMatchObject({
      amountMicro: 0,
      reason: 'exhausted',
    })
  })

  it('rejects issuance whose backing does not match the quota', () => {
    const book = new CreditBook()
    expect(() => book.issue(credit({ backingMicro: costMicro(STRIKE, QTY) - 1 }))).toThrow(
      /backing does not match quota/,
    )
  })
})

describe('operator paid from backing, not buyer (§8.2)', () => {
  it('total payout == issued backing; buyer USD balance untouched', () => {
    const book = new CreditBook()
    const issued = credit()
    book.issue(issued)
    const router = new SimulatedRouter({
      adapter: new DefaultRedemptionAdapter(book),
      listPriceMicroPerM: LIST,
    })
    const operator = new MockOperator('op_alpha')
    router.deposit('buyer_1', 5_000_000)

    for (const tokens of CALLS) {
      const outcome = router.serve({
        owner: 'buyer_1',
        model: MODEL,
        tokenKind: 'output',
        tokens,
        ts: 1_000_000_000,
        operator,
      })
      expect(outcome.source).toBe('credit')
      expect(outcome.overflowTokens).toBe(0)
      expect(outcome.billedToBalanceMicro).toBe(0)
    }

    expect(operator.paidFromBackingMicro).toBe(issued.backingMicro)
    expect(operator.paidFromBalanceMicro).toBe(0)
    expect(operator.servedTokens).toBe(QTY)
    expect(router.balanceOf('buyer_1')).toBe(5_000_000)
    expect(book.get('cr_1')!.qtyRemaining).toBe(0)
  })
})
