import { OrderBook } from './orderbook'
import { gaussian, mulberry32 } from './prng'
import type { Fill, Instrument } from './types'

/**
 * Seeded simulated venue: a reference price following a geometric random walk
 * (the upstream router list price the market trades around) plus Poisson
 * taker flow that crosses against resting quotes. Deterministic given a seed,
 * so loop tests assert exact behavior.
 */

export interface SimConfig {
  seed: number
  /** Initial reference mid, micro-tsUSD per 1M tokens. */
  initialRef: number
  /** Per-tick drift, fraction (e.g. 0 = none). */
  driftPerTick: number
  /** Per-tick volatility, fraction (e.g. 0.002 = 20bps). */
  volPerTick: number
  /** Mean taker arrivals per tick. */
  takerIntensity: number
  /** Mean taker order size, tokens. */
  takerSizeMean: number
  /** How far takers will chase past the reference, bps. */
  takerAggressionBps: number
}

export interface TickReport {
  tick: number
  refMid: number
  fills: Fill[]
}

export class SimulatedMarket {
  readonly book: OrderBook
  private refMid: number
  private readonly rand: () => number
  private readonly cfg: SimConfig
  private tickIndex = 0
  private orderSeq = 0

  constructor(instrument: Instrument, cfg: SimConfig) {
    this.book = new OrderBook(instrument)
    this.cfg = cfg
    this.refMid = cfg.initialRef
    this.rand = mulberry32(cfg.seed)
  }

  referenceMid(): number {
    return this.refMid
  }

  currentTick(): number {
    return this.tickIndex
  }

  /** Advance one tick: move the reference, then send taker flow at the book. */
  tick(): TickReport {
    this.tickIndex += 1
    const shock = gaussian(this.rand) * this.cfg.volPerTick + this.cfg.driftPerTick
    this.refMid = Math.max(
      this.book.instrument.tickSize,
      Math.round(this.refMid * (1 + shock)),
    )

    const fills: Fill[] = []
    const arrivals = this.poisson(this.cfg.takerIntensity)
    for (let i = 0; i < arrivals; i += 1) {
      const side = this.rand() < 0.5 ? 'buy' : 'sell'
      const qty = Math.max(
        this.book.instrument.minQty,
        Math.round(-Math.log(1 - this.rand()) * this.cfg.takerSizeMean),
      )
      const aggression = 1 + (this.cfg.takerAggressionBps / 10_000) * this.rand()
      const rawPrice = side === 'buy' ? this.refMid * aggression : this.refMid / aggression
      const price = this.roundToTick(rawPrice, side)
      this.orderSeq += 1
      const result = this.book.place({
        id: `sim-taker-${this.orderSeq}`,
        instrumentId: this.book.instrument.id,
        side,
        price,
        qty,
        owner: `sim-taker`,
        ts: this.tickIndex * 1000 + i,
      })
      fills.push(...result.fills)
      // Takers are immediate-or-cancel: unfilled remainder leaves the book.
      if (result.resting) this.book.cancel(result.resting.id)
    }
    return { tick: this.tickIndex, refMid: this.refMid, fills }
  }

  private roundToTick(raw: number, side: 'buy' | 'sell'): number {
    const tick = this.book.instrument.tickSize
    const fn = side === 'buy' ? Math.ceil : Math.floor
    return Math.max(tick, fn(raw / tick) * tick)
  }

  private poisson(lambda: number): number {
    const l = Math.exp(-lambda)
    let k = 0
    let p = 1
    do {
      k += 1
      p *= this.rand()
    } while (p > l)
    return k - 1
  }
}
