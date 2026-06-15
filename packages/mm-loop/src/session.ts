import {
  type Fill,
  Ledger,
  type QuoteParams,
  type QuoteSet,
  type RiskContext,
  type RiskLimits,
  type RiskVerdict,
} from '@inference-bazaar/market-core'
import type { MarketTick, MarketVenue, SessionReport } from './types'

export interface SessionOptions {
  venue: MarketVenue
  owner: string
  params: QuoteParams
  limits: RiskLimits
}

/**
 * Mutable state of one market-making run: the ledger, the kill switch, and
 * the venue cursor. The loop driver is the ONLY writer — `applyQuotes` and
 * `advance` are called from `plan()`, `recordVerdict` from the validator —
 * so the session needs no locking and every transition is attributable to a
 * loop round.
 */
export class MarketMakingSession {
  private readonly venue: MarketVenue
  private readonly owner: string
  private readonly params: QuoteParams
  private readonly limits: RiskLimits
  private readonly ledger: Ledger
  private ticks = 0
  private fillCount = 0
  private rejected = 0
  private maxDrawdown = 0
  private kill = false
  private lastRefMid: number

  constructor(opts: SessionOptions) {
    this.venue = opts.venue
    this.owner = opts.owner
    this.params = opts.params
    this.limits = opts.limits
    this.ledger = new Ledger(opts.owner)
    this.lastRefMid = opts.venue.referenceMid()
  }

  currentTick(): MarketTick {
    return {
      tickIndex: this.ticks,
      instrument: this.venue.instrument(),
      refMid: this.lastRefMid,
      book: this.venue.snapshot(this.ticks),
      inventoryTokens: this.ledger.positionTokens(),
      equityMicro: this.ledger.equity(this.lastRefMid),
      drawdownMicro: this.maxDrawdown,
      params: { ...this.params, horizonTicks: this.params.horizonTicks },
      limits: this.limits,
    }
  }

  riskContext(): RiskContext {
    return {
      refMid: this.lastRefMid,
      inventoryTokens: this.ledger.positionTokens(),
      drawdown: this.maxDrawdown,
      limits: this.limits,
    }
  }

  /** Validator callback: remember the verdict; trip the kill switch if asked. */
  recordVerdict(verdict: RiskVerdict): void {
    if (verdict.killSwitch) this.kill = true
    if (!verdict.valid) this.rejected += 1
  }

  /** Cancel-replace our quotes on the venue. */
  applyQuotes(quotes: QuoteSet): void {
    const fills = this.venue.replaceQuotes(this.owner, quotes, this.ticks)
    for (const fill of fills) this.applyFill(fill)
  }

  pullQuotes(): void {
    this.venue.cancelAll(this.owner)
  }

  /** Advance market time one tick and absorb the consequences. */
  advance(): void {
    const result = this.venue.step()
    this.lastRefMid = result.refMid
    for (const fill of result.fills) this.applyFill(fill)
    const drawdown = this.ledger.drawdown(this.lastRefMid)
    if (drawdown > this.maxDrawdown) this.maxDrawdown = drawdown
    if (drawdown >= this.limits.killSwitchDrawdown) this.kill = true
    this.ticks += 1
  }

  private applyFill(fill: Fill): void {
    if (fill.makerOwner !== this.owner && fill.takerOwner !== this.owner) return
    this.ledger.apply(fill)
    this.fillCount += 1
  }

  killed(): boolean {
    return this.kill
  }

  ticksCompleted(): number {
    return this.ticks
  }

  report(): SessionReport {
    const stats = this.ledger.stats(this.lastRefMid)
    return {
      owner: this.owner,
      instrumentId: this.venue.instrument().id,
      ticksCompleted: this.ticks,
      fills: this.fillCount,
      positionTokens: stats.positionTokens,
      equityMicro: stats.equityMicro,
      realizedMicro: stats.realizedMicro,
      maxDrawdownMicro: this.maxDrawdown,
      killSwitch: this.kill,
      rejectedTicks: this.rejected,
      finalRefMid: this.lastRefMid,
    }
  }
}
