import { describe, expect, it } from 'vitest'
import { OrderBook } from '../src/orderbook'
import type { Instrument, Order } from '../src/types'

const inst: Instrument = {
  id: 'anthropic/claude-opus-4-8:output',
  modelId: 'anthropic/claude-opus-4-8',
  tokenKind: 'output',
  tickSize: 1000,
  minQty: 1000,
}

let seq = 0
const order = (partial: Partial<Order> & Pick<Order, 'side' | 'price' | 'qty'>): Order => {
  seq += 1
  return {
    id: partial.id ?? `o${seq}`,
    instrumentId: inst.id,
    owner: partial.owner ?? `owner${seq}`,
    ts: partial.ts ?? seq,
    ...partial,
  } as Order
}

describe('OrderBook', () => {
  it('rests non-crossing orders and reports best bid/ask/mid', () => {
    const book = new OrderBook(inst)
    book.place(order({ side: 'buy', price: 99_000, qty: 5000 }))
    book.place(order({ side: 'sell', price: 101_000, qty: 5000 }))
    expect(book.bestBid()).toBe(99_000)
    expect(book.bestAsk()).toBe(101_000)
    expect(book.mid()).toBe(100_000)
  })

  it('matches at maker price with price-time priority and partial fills', () => {
    const book = new OrderBook(inst)
    book.place(order({ id: 'a', side: 'sell', price: 100_000, qty: 3000, ts: 1 }))
    book.place(order({ id: 'b', side: 'sell', price: 100_000, qty: 3000, ts: 2 }))
    book.place(order({ id: 'c', side: 'sell', price: 99_000, qty: 1000, ts: 3 }))

    const result = book.place(order({ side: 'buy', price: 100_000, qty: 5000 }))
    expect(result.fills.map((f) => [f.makerOrderId, f.qty, f.price])).toEqual([
      ['c', 1000, 99_000], // best price first despite later ts
      ['a', 3000, 100_000], // then time priority at the level
      ['b', 1000, 100_000],
    ])
    expect(result.resting).toBeUndefined()
    expect(book.order('b')?.qty).toBe(2000)
  })

  it('rests the unfilled remainder', () => {
    const book = new OrderBook(inst)
    book.place(order({ side: 'sell', price: 100_000, qty: 2000 }))
    const result = book.place(order({ side: 'buy', price: 100_000, qty: 5000 }))
    expect(result.fills).toHaveLength(1)
    expect(result.resting?.qty).toBe(3000)
    expect(book.bestBid()).toBe(100_000)
  })

  it('prevents self-matching by cancelling the resting maker', () => {
    const book = new OrderBook(inst)
    book.place(order({ id: 'mine', side: 'sell', price: 100_000, qty: 2000, owner: 'mm' }))
    const result = book.place(order({ side: 'buy', price: 100_000, qty: 2000, owner: 'mm' }))
    expect(result.fills).toHaveLength(0)
    expect(book.order('mine')).toBeUndefined()
    expect(book.bestBid()).toBe(100_000) // taker remainder rests
  })

  it('cancels orders and validates tick/min-qty', () => {
    const book = new OrderBook(inst)
    const r = book.place(order({ id: 'x', side: 'buy', price: 99_000, qty: 2000 }))
    expect(r.resting?.id).toBe('x')
    expect(book.cancel('x')).toBe(true)
    expect(book.cancel('x')).toBe(false)
    expect(() => book.place(order({ side: 'buy', price: 99_500, qty: 2000 }))).toThrow(/tick/)
    expect(() => book.place(order({ side: 'buy', price: 99_000, qty: 10 }))).toThrow(/minQty/)
  })

  it('aggregates depth levels in snapshots', () => {
    const book = new OrderBook(inst)
    book.place(order({ side: 'buy', price: 99_000, qty: 2000 }))
    book.place(order({ side: 'buy', price: 99_000, qty: 3000 }))
    book.place(order({ side: 'buy', price: 98_000, qty: 1000 }))
    const snap = book.snapshot(10, 42)
    expect(snap.bids).toEqual([
      { price: 99_000, qty: 5000, orders: 2 },
      { price: 98_000, qty: 1000, orders: 1 },
    ])
    expect(snap.ts).toBe(42)
  })
})
