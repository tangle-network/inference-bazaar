import type { BookSnapshot, Fill, Instrument, QuoteSet, SimulatedMarket } from '@surplus/market-core'
import type { MarketVenue } from './types'

/** Adapt the deterministic simulator to the venue port the session trades. */
export class SimVenue implements MarketVenue {
  private readonly sim: SimulatedMarket
  private quoteSeq = 0

  constructor(sim: SimulatedMarket) {
    this.sim = sim
  }

  instrument(): Instrument {
    return this.sim.book.instrument
  }

  referenceMid(): number {
    return this.sim.referenceMid()
  }

  snapshot(ts: number): BookSnapshot {
    return this.sim.book.snapshot(10, ts)
  }

  replaceQuotes(owner: string, quotes: QuoteSet, ts: number): Fill[] {
    this.cancelAll(owner)
    const fills: Fill[] = []
    for (const [side, quote] of [
      ['buy', quotes.bid],
      ['sell', quotes.ask],
    ] as const) {
      if (!quote) continue
      this.quoteSeq += 1
      const result = this.sim.book.place({
        id: `${owner}-${side}-${this.quoteSeq}`,
        instrumentId: this.instrument().id,
        side,
        price: quote.price,
        qty: quote.qty,
        owner,
        ts,
      })
      fills.push(...result.fills)
    }
    return fills
  }

  cancelAll(owner: string): void {
    for (const order of this.sim.book.openOrders(owner)) {
      this.sim.book.cancel(order.id)
    }
  }

  step(): { refMid: number; fills: Fill[]; tick: number } {
    return this.sim.tick()
  }
}
