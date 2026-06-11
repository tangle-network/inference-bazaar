import { describe, expect, it } from 'vitest'
import {
  costMicro,
  CreditBook,
  DefaultRedemptionAdapter,
  GuardedRedemptionAdapter,
  isRedemptionRefusal,
  type Credit,
} from '../src/index'

const MODEL = 'anthropic/claude-opus-4-8'
const STRIKE = 14_900_000

function credit(overrides: Partial<Credit> = {}): Credit {
  const qty = overrides.qtyIssued ?? 1_000_000
  return {
    id: 'cr_1',
    owner: 'buyer_1',
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

function setup(limits: ConstructorParameters<typeof GuardedRedemptionAdapter>[2], credits = [credit()]) {
  const book = new CreditBook()
  for (const c of credits) book.issue(c)
  const guarded = new GuardedRedemptionAdapter(new DefaultRedemptionAdapter(book), book, limits)
  return { book, guarded }
}

const call = (tokens: number, ts: number, creditId = 'cr_1') => ({
  creditId,
  model: MODEL,
  tokenKind: 'output' as const,
  tokens,
  ts,
  operator: 'op_alpha',
})

describe('rate limit (calls per window)', () => {
  it('refuses the call over the limit and recovers when the window slides', () => {
    const { guarded } = setup({ windowSec: 60, maxCallsPerWindow: 2 })
    expect(isRedemptionRefusal(guarded.redeem(call(10, 100)))).toBe(false)
    expect(isRedemptionRefusal(guarded.redeem(call(10, 110)))).toBe(false)

    const refused = guarded.redeem(call(10, 120))
    expect(refused).toEqual({
      kind: 'rate-limited',
      owner: 'buyer_1',
      windowSec: 60,
      limit: 2,
      used: 2,
      retryAtTs: 160, // oldest entry (ts=100) + window
    })

    // At ts=161 the ts=100 entry has aged out — capacity is back.
    expect(isRedemptionRefusal(guarded.redeem(call(10, 161)))).toBe(false)
  })

  it('selectCredit returns null for a capped owner (router falls back to balance)', () => {
    const { guarded } = setup({ windowSec: 60, maxCallsPerWindow: 1 })
    expect(guarded.selectCredit('buyer_1', MODEL, 'output', 100)).not.toBeNull()
    guarded.redeem(call(10, 100))
    expect(guarded.selectCredit('buyer_1', MODEL, 'output', 110)).toBeNull()
    expect(guarded.selectCredit('buyer_1', MODEL, 'output', 161)).not.toBeNull()
  })
})

describe('token + spend caps', () => {
  it('caps tokens per window using actual debited amounts', () => {
    const { guarded } = setup({ windowSec: 60, maxTokensPerWindow: 1_000 })
    guarded.redeem(call(600, 100))
    guarded.redeem(call(400, 110)) // exactly at cap now
    const refused = guarded.redeem(call(1, 120))
    expect(refused).toMatchObject({ kind: 'tokens-capped', limit: 1_000, used: 1_000 })
    expect(guarded.usage('buyer_1', 120)).toMatchObject({ tokens: 1_000, calls: 2 })
  })

  it('caps operator payout per window', () => {
    // 100k tokens at $14.90/M => 1_490_000 micro per call.
    const { guarded } = setup({ windowSec: 600, maxSpendMicroPerWindow: 2_000_000 })
    guarded.redeem(call(100_000, 100))
    guarded.redeem(call(100_000, 200)) // spend now 2_980_000 > cap — recorded, next refused
    const refused = guarded.redeem(call(1, 300))
    expect(refused).toMatchObject({ kind: 'spend-capped', limit: 2_000_000 })
  })

  it('caps are per-owner — one owner cannot exhaust another', () => {
    const { guarded } = setup({ windowSec: 60, maxCallsPerWindow: 1 }, [
      credit(),
      credit({ id: 'cr_2', owner: 'buyer_2' }),
    ])
    guarded.redeem(call(10, 100))
    expect(isRedemptionRefusal(guarded.redeem(call(10, 110)))).toBe(true)
    expect(isRedemptionRefusal(guarded.redeem(call(10, 110, 'cr_2')))).toBe(false)
  })
})

describe('guard composition', () => {
  it('debit errors pass through untouched and consume no window capacity', () => {
    const { guarded } = setup({ windowSec: 60, maxCallsPerWindow: 1 })
    const unknown = guarded.redeem(call(10, 100, 'cr_ghost'))
    expect(unknown).toEqual({ kind: 'unknown-credit', creditId: 'cr_ghost' })
    expect(guarded.usage('buyer_1', 100).calls).toBe(0)
    // The failed call did not eat the single slot.
    expect(isRedemptionRefusal(guarded.redeem(call(10, 101)))).toBe(false)
  })

  it('refused calls never touch the book — no quota or backing leaks', () => {
    const { book, guarded } = setup({ windowSec: 60, maxCallsPerWindow: 1 })
    guarded.redeem(call(10, 100))
    const before = book.get('cr_1')!
    guarded.redeem(call(500, 110))
    expect(book.get('cr_1')).toEqual(before)
  })

  it('determinism: same sequence → same refusals', () => {
    const seq = [
      [100, 100],
      [200, 130],
      [300, 150],
      [50, 170],
      [50, 200],
    ] as const
    const run = () => {
      const { guarded } = setup({ windowSec: 60, maxCallsPerWindow: 2, maxTokensPerWindow: 450 })
      return seq.map(([tokens, ts]) => guarded.redeem(call(tokens, ts)))
    }
    expect(run()).toEqual(run())
  })
})
