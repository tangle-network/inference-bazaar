import type { BookLevel, BookSnapshot, Fill, Instrument, Order, Side } from './types'

export interface PlaceResult {
  fills: Fill[]
  /** The remainder resting on the book, if any. */
  resting?: Order
}

/**
 * Price-time priority limit orderbook for a single instrument.
 *
 * Arrays kept sorted (bids descending, asks ascending; FIFO within a level).
 * Depth in this market is operator quotes, not HFT flow — linear inserts are
 * deliberate; correctness and auditability over micro-optimization.
 */
export class OrderBook {
  readonly instrument: Instrument
  private bids: Order[] = []
  private asks: Order[] = []
  private byId = new Map<string, Order>()
  private lastTradePrice: number | undefined

  constructor(instrument: Instrument) {
    this.instrument = instrument
  }

  place(incoming: Order): PlaceResult {
    this.assertValid(incoming)
    if (this.byId.has(incoming.id)) {
      throw new Error(`duplicate order id: ${incoming.id}`)
    }
    const taker: Order = { ...incoming }
    const fills: Fill[] = []
    const book = taker.side === 'buy' ? this.asks : this.bids
    const crosses = (maker: Order): boolean =>
      taker.side === 'buy' ? maker.price <= taker.price : maker.price >= taker.price

    while (taker.qty > 0 && book.length > 0 && crosses(book[0]!)) {
      const maker = book[0]!
      if (maker.owner === taker.owner) {
        // Self-match prevention: cancel the resting maker rather than print a
        // wash trade the leaderboard would count as volume.
        this.remove(maker)
        continue
      }
      const qty = Math.min(taker.qty, maker.qty)
      fills.push({
        instrumentId: this.instrument.id,
        makerOrderId: maker.id,
        takerOrderId: taker.id,
        makerOwner: maker.owner,
        takerOwner: taker.owner,
        price: maker.price,
        qty,
        takerSide: taker.side,
        ts: taker.ts,
      })
      maker.qty -= qty
      taker.qty -= qty
      this.lastTradePrice = maker.price
      if (maker.qty === 0) this.remove(maker)
    }

    if (taker.qty > 0) {
      this.insert(taker)
      return { fills, resting: taker }
    }
    return { fills }
  }

  cancel(orderId: string): boolean {
    const order = this.byId.get(orderId)
    if (!order) return false
    this.remove(order)
    return true
  }

  order(orderId: string): Order | undefined {
    const o = this.byId.get(orderId)
    return o ? { ...o } : undefined
  }

  openOrders(owner?: string): Order[] {
    const all = [...this.bids, ...this.asks]
    const filtered = owner ? all.filter((o) => o.owner === owner) : all
    return filtered.map((o) => ({ ...o }))
  }

  bestBid(): number | undefined {
    return this.bids[0]?.price
  }

  bestAsk(): number | undefined {
    return this.asks[0]?.price
  }

  mid(): number | undefined {
    const bid = this.bestBid()
    const ask = this.bestAsk()
    if (bid === undefined || ask === undefined) return this.lastTradePrice
    return Math.round((bid + ask) / 2)
  }

  snapshot(depth = 10, ts = 0): BookSnapshot {
    const levels = (orders: Order[]): BookLevel[] => {
      const out: BookLevel[] = []
      for (const o of orders) {
        const top = out[out.length - 1]
        if (top && top.price === o.price) {
          top.qty += o.qty
          top.orders += 1
        } else {
          if (out.length === depth) break
          out.push({ price: o.price, qty: o.qty, orders: 1 })
        }
      }
      return out
    }
    const snap: BookSnapshot = {
      instrumentId: this.instrument.id,
      bids: levels(this.bids),
      asks: levels(this.asks),
      ts,
    }
    if (this.lastTradePrice !== undefined) snap.lastTradePrice = this.lastTradePrice
    return snap
  }

  private assertValid(o: Order): void {
    if (o.instrumentId !== this.instrument.id) {
      throw new Error(`order for ${o.instrumentId} sent to book ${this.instrument.id}`)
    }
    if (!Number.isInteger(o.price) || o.price <= 0) throw new Error(`invalid price: ${o.price}`)
    if (o.price % this.instrument.tickSize !== 0) {
      throw new Error(`price ${o.price} off tick ${this.instrument.tickSize}`)
    }
    if (!Number.isInteger(o.qty) || o.qty < this.instrument.minQty) {
      throw new Error(`qty ${o.qty} below minQty ${this.instrument.minQty}`)
    }
  }

  private insert(order: Order): void {
    const book = order.side === 'buy' ? this.bids : this.asks
    const before = (a: Order, b: Order): boolean =>
      order.side === 'buy'
        ? a.price > b.price || (a.price === b.price && a.ts < b.ts)
        : a.price < b.price || (a.price === b.price && a.ts < b.ts)
    let i = 0
    while (i < book.length && before(book[i]!, order)) i += 1
    // Equal price+ts: the earlier insert keeps priority (stable FIFO).
    while (i < book.length && book[i]!.price === order.price && book[i]!.ts === order.ts) i += 1
    book.splice(i, 0, order)
    this.byId.set(order.id, order)
  }

  private remove(order: Order): void {
    const book = order.side === 'buy' ? this.bids : this.asks
    const i = book.indexOf(order)
    if (i >= 0) book.splice(i, 1)
    this.byId.delete(order.id)
  }
}
