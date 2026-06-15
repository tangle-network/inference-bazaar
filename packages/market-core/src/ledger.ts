import type { Fill } from './types'
import { notionalMicro } from './types'

/**
 * Position + PnL accounting for one owner on one instrument.
 * Average-cost basis; marks against a caller-supplied reference price.
 */
export class Ledger {
  readonly owner: string
  /** Signed position, tokens. Positive = long inference-bazaar tokens. */
  private position = 0
  /** Cash delta from trading, micro-tsUSD. Selling adds, buying subtracts. */
  private cash = 0
  /** Average entry price of the open position, micro-tsUSD per 1M tokens. */
  private avgPrice = 0
  private realized = 0
  private peakEquity = 0
  private fillCount = 0

  constructor(owner: string) {
    this.owner = owner
  }

  /** Apply a fill where this owner was maker or taker. No-op otherwise. */
  apply(fill: Fill): void {
    const isMaker = fill.makerOwner === this.owner
    const isTaker = fill.takerOwner === this.owner
    if (!isMaker && !isTaker) return
    if (isMaker && isTaker) throw new Error('wash fill reached ledger')
    const side = isTaker ? fill.takerSide : fill.takerSide === 'buy' ? 'sell' : 'buy'
    const signedQty = side === 'buy' ? fill.qty : -fill.qty
    const notional = notionalMicro(fill.price, fill.qty)
    this.cash += side === 'buy' ? -notional : notional
    this.fillCount += 1

    const prev = this.position
    const next = prev + signedQty
    if (prev !== 0 && Math.sign(prev) !== Math.sign(signedQty)) {
      // Closing (some of) the position realizes PnL against average cost.
      const closed = Math.min(Math.abs(prev), Math.abs(signedQty))
      const direction = Math.sign(prev)
      this.realized += direction * (fill.price - this.avgPrice) * (closed / 1_000_000)
      if (next !== 0 && Math.sign(next) !== Math.sign(prev)) this.avgPrice = fill.price
    } else if (prev === 0) {
      this.avgPrice = fill.price
    } else {
      // Same-direction add: weighted average entry.
      this.avgPrice =
        (this.avgPrice * Math.abs(prev) + fill.price * Math.abs(signedQty)) / Math.abs(next)
    }
    this.position = next
    if (this.position === 0) this.avgPrice = 0
  }

  positionTokens(): number {
    return this.position
  }

  /** Mark-to-reference equity, micro-tsUSD. */
  equity(refMid: number): number {
    return this.cash + notionalMicro(refMid, this.position)
  }

  /** Drawdown from peak equity, micro-tsUSD (>= 0). Updates the peak. */
  drawdown(refMid: number): number {
    const eq = this.equity(refMid)
    if (eq > this.peakEquity) this.peakEquity = eq
    return this.peakEquity - eq
  }

  stats(refMid: number): LedgerStats {
    return {
      owner: this.owner,
      positionTokens: this.position,
      cashMicro: this.cash,
      equityMicro: this.equity(refMid),
      realizedMicro: Math.round(this.realized),
      fills: this.fillCount,
    }
  }
}

export interface LedgerStats {
  owner: string
  positionTokens: number
  cashMicro: number
  equityMicro: number
  realizedMicro: number
  fills: number
}
