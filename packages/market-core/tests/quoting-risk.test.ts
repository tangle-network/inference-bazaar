import { describe, expect, it } from 'vitest'
import { Ledger } from '../src/ledger'
import { computeQuotes, type QuoteParams } from '../src/quoting'
import { assessQuotes, type RiskContext, type RiskLimits } from '../src/risk'
import { SimulatedMarket } from '../src/sim'
import type { Fill, Instrument } from '../src/types'

const params: QuoteParams = {
  gamma: 0.0005,
  sigma: 200,
  horizonTicks: 50,
  k: 1.5,
  size: 100_000,
  maxInventory: 500_000,
  tickSize: 1000,
}

const limits: RiskLimits = {
  maxInventory: 500_000,
  maxQuoteNotional: 50_000_000,
  maxDeviationBps: 500,
  minSpreadBps: 1,
  killSwitchDrawdown: 10_000_000,
}

const ctx = (over: Partial<RiskContext> = {}): RiskContext => ({
  refMid: 3_000_000,
  inventoryTokens: 0,
  drawdown: 0,
  limits,
  ...over,
})

describe('computeQuotes', () => {
  it('quotes symmetric around mid when flat', () => {
    const q = computeQuotes(3_000_000, 0, params)
    expect(q.bid).toBeDefined()
    expect(q.ask).toBeDefined()
    expect(q.bid!.price).toBeLessThan(3_000_000)
    expect(q.ask!.price).toBeGreaterThan(3_000_000)
    const bidDist = 3_000_000 - q.bid!.price
    const askDist = q.ask!.price - 3_000_000
    expect(Math.abs(bidDist - askDist)).toBeLessThanOrEqual(2 * params.tickSize)
  })

  it('skews quotes down when long, up when short', () => {
    const flat = computeQuotes(3_000_000, 0, params)
    const long = computeQuotes(3_000_000, 300_000, params)
    const short = computeQuotes(3_000_000, -300_000, params)
    expect(long.bid!.price).toBeLessThan(flat.bid!.price)
    expect(long.ask!.price).toBeLessThan(flat.ask!.price)
    expect(short.bid!.price).toBeGreaterThan(flat.bid!.price)
    expect(short.ask!.price).toBeGreaterThan(flat.ask!.price)
  })

  it('pulls a side at the inventory cap', () => {
    expect(computeQuotes(3_000_000, params.maxInventory, params).bid).toBeUndefined()
    expect(computeQuotes(3_000_000, -params.maxInventory, params).ask).toBeUndefined()
    expect(computeQuotes(0, 0, params)).toEqual({ rationale: 'no reference mid — not quoting' })
  })
})

describe('assessQuotes', () => {
  it('passes sane two-sided quotes', () => {
    const v = assessQuotes(computeQuotes(3_000_000, 0, params), ctx())
    expect(v.valid).toBe(true)
    expect(v.killSwitch).toBe(false)
    expect(v.score).toBeGreaterThan(0.5)
  })

  it('rejects crossed quotes, deviation breaches, and oversize notional', () => {
    const crossed = assessQuotes(
      { bid: { price: 3_010_000, qty: 1000 }, ask: { price: 3_000_000, qty: 1000 }, rationale: '' },
      ctx(),
    )
    expect(crossed.valid).toBe(false)
    expect(crossed.reasons.join()).toMatch(/crossed/)

    const deviant = assessQuotes(
      { bid: { price: 2_000_000, qty: 1000 }, rationale: '' },
      ctx(),
    )
    expect(deviant.valid).toBe(false)
    expect(deviant.reasons.join()).toMatch(/deviates/)

    const oversize = assessQuotes(
      { ask: { price: 3_000_000, qty: 100_000_000 }, rationale: '' },
      ctx(),
    )
    expect(oversize.valid).toBe(false)
    expect(oversize.reasons.join()).toMatch(/notional|inventory/)
  })

  it('rejects quotes whose fill would breach the inventory cap', () => {
    const v = assessQuotes(
      { bid: { price: 3_000_000, qty: 200_000 }, rationale: '' },
      ctx({ inventoryTokens: 400_000 }),
    )
    expect(v.valid).toBe(false)
    expect(v.reasons.join()).toMatch(/inventory/)
  })

  it('trips the kill switch on drawdown', () => {
    const v = assessQuotes(computeQuotes(3_000_000, 0, params), ctx({ drawdown: 20_000_000 }))
    expect(v.killSwitch).toBe(true)
    expect(v.valid).toBe(false)
  })
})

describe('Ledger', () => {
  const inst = 'anthropic/claude-opus-4-8:output'
  const fill = (side: 'buy' | 'sell', price: number, qty: number): Fill => ({
    instrumentId: inst,
    makerOrderId: 'm',
    takerOrderId: 't',
    makerOwner: 'mm',
    takerOwner: 'taker',
    price,
    qty,
    takerSide: side === 'buy' ? 'sell' : 'buy', // mm is maker on the opposite side
    ts: 0,
  })

  it('tracks position, cash, and realized pnl round trip', () => {
    const ledger = new Ledger('mm')
    ledger.apply(fill('buy', 2_990_000, 100_000)) // mm buys 100k @ 2.99/M
    expect(ledger.positionTokens()).toBe(100_000)
    ledger.apply(fill('sell', 3_010_000, 100_000)) // mm sells 100k @ 3.01/M
    expect(ledger.positionTokens()).toBe(0)
    const stats = ledger.stats(3_000_000)
    // bought 299_000 micro, sold 301_000 micro → +2_000 micro = $0.002 per round trip
    expect(stats.cashMicro).toBe(2000)
    expect(stats.realizedMicro).toBe(2000)
    expect(stats.equityMicro).toBe(2000)
    expect(stats.fills).toBe(2)
  })

  it('marks open inventory to reference and measures drawdown', () => {
    const ledger = new Ledger('mm')
    ledger.apply(fill('buy', 3_000_000, 200_000))
    expect(ledger.equity(3_000_000)).toBe(0)
    expect(ledger.drawdown(3_000_000)).toBe(0)
    // ref drops 1% → long 200k tokens loses 6_000 micro
    expect(ledger.drawdown(2_970_000)).toBe(6000)
  })
})

describe('SimulatedMarket determinism', () => {
  const inst: Instrument = {
    id: 'anthropic/claude-opus-4-8:output',
    modelId: 'anthropic/claude-opus-4-8',
    tokenKind: 'output',
    tickSize: 1000,
    minQty: 1000,
  }
  const cfg = {
    seed: 7,
    initialRef: 3_000_000,
    driftPerTick: 0,
    volPerTick: 0.002,
    takerIntensity: 2,
    takerSizeMean: 50_000,
    takerAggressionBps: 30,
  }

  it('produces identical runs for identical seeds', () => {
    const run = () => {
      const sim = new SimulatedMarket(inst, cfg)
      const refs: number[] = []
      for (let i = 0; i < 20; i += 1) refs.push(sim.tick().refMid)
      return refs
    }
    expect(run()).toEqual(run())
  })

  it('fills resting quotes near the reference', () => {
    const sim = new SimulatedMarket(inst, cfg)
    sim.book.place({
      id: 'mm-bid',
      instrumentId: inst.id,
      side: 'buy',
      price: 2_999_000,
      qty: 1_000_000,
      owner: 'mm',
      ts: 0,
    })
    sim.book.place({
      id: 'mm-ask',
      instrumentId: inst.id,
      side: 'sell',
      price: 3_001_000,
      qty: 1_000_000,
      owner: 'mm',
      ts: 0,
    })
    let fills = 0
    for (let i = 0; i < 50; i += 1) fills += sim.tick().fills.length
    expect(fills).toBeGreaterThan(0)
  })
})
