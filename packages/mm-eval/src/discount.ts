import {
  gaussian,
  mulberry32,
  OrderBook,
  type Instrument,
} from '@surplus/market-core'

/**
 * Discount-capture backtest — the strategy mm-eval's sweep said is the real
 * edge: buy distressed surplus listed below the router reference, re-offer it
 * near list, keep the gap. Spread PnL is isolated structurally: the operator
 * posts NO bids and quotes one side only, so every micro of PnL here comes
 * from the acquisition discount, not from two-sided spread capture (which the
 * existing param sweep measures separately).
 *
 * Deterministic per seed: one PRNG stream drives the reference walk, the
 * distressed dump arrivals, and the taker flow.
 */

export interface DiscountCaptureConfig {
  instrument: Instrument
  seeds: number[]
  horizonTicks: number
  ref: {
    /** Initial reference (router list) price, micro-tsUSD per 1M tokens. */
    initial: number
    driftPerTick: number
    volPerTick: number
  }
  /** Distressed surplus flow: sellers dumping below reference. */
  dump: {
    /** Probability a dump arrives on a tick [0,1]. */
    probPerTick: number
    /** Mean dump size, tokens (exponential). */
    sizeMean: number
    /** Mean discount below reference at which surplus is listed, bps. */
    discountBpsMean: number
  }
  /** Retail buy flow that lifts the operator's re-offer near list. */
  takers: {
    /** Mean buy arrivals per tick (Poisson). */
    intensity: number
    /** Mean taker size, tokens (exponential). */
    sizeMean: number
    /** How far above reference takers will chase, bps. */
    aggressionBps: number
  }
  /** Operator policy. `minEdgeBps` must exceed `resellDiscountBps` or there is no edge. */
  strategy: {
    /** Lift asks priced at least this far below reference, bps. */
    minEdgeBps: number
    /** Re-offer inventory this far below reference, bps. */
    resellDiscountBps: number
    /** Max tokens held. */
    maxInventory: number
  }
}

export interface DiscountSessionReport {
  seed: number
  tokensBought: number
  tokensResold: number
  /** Paid for distressed inventory, micro-tsUSD. */
  costMicro: number
  /** Resale proceeds, micro-tsUSD. */
  proceedsMicro: number
  /** Proceeds minus FIFO cost of the resold tokens, micro-tsUSD. */
  realizedCaptureMicro: number
  /** Sum of (refAtBuy − buyPx) × qty at acquisition — the edge bought, micro-tsUSD. */
  discountAtBuyMicro: number
  residualTokens: number
  /** Residual inventory marked at the final reference, micro-tsUSD. */
  residualMarkMicro: number
  /** Residual mark minus residual FIFO cost, micro-tsUSD. */
  unrealizedMicro: number
  /** realizedCaptureMicro + unrealizedMicro — the number that must be positive. */
  equityCaptureMicro: number
}

export interface DiscountCaptureResult {
  sessions: DiscountSessionReport[]
  captureMeanMicro: number
  /** Worst seed — the tail that decides whether the strategy is real. */
  captureMinMicro: number
  /** Tokens resold / tokens bought across all sessions (0 if nothing bought). */
  resoldFraction: number
}

const MM = 'mm-operator'

export function runDiscountCapture(cfg: DiscountCaptureConfig): DiscountCaptureResult {
  if (cfg.strategy.minEdgeBps <= cfg.strategy.resellDiscountBps) {
    throw new Error(
      `minEdgeBps (${cfg.strategy.minEdgeBps}) must exceed resellDiscountBps (${cfg.strategy.resellDiscountBps}) — otherwise resales undercut acquisitions`,
    )
  }
  const sessions = cfg.seeds.map((seed) => runSession(cfg, seed))
  const captures = sessions.map((s) => s.equityCaptureMicro)
  const bought = sessions.reduce((a, s) => a + s.tokensBought, 0)
  const resold = sessions.reduce((a, s) => a + s.tokensResold, 0)
  return {
    sessions,
    captureMeanMicro: Math.round(captures.reduce((a, c) => a + c, 0) / captures.length),
    captureMinMicro: Math.min(...captures),
    resoldFraction: bought === 0 ? 0 : resold / bought,
  }
}

function runSession(cfg: DiscountCaptureConfig, seed: number): DiscountSessionReport {
  const rand = mulberry32(seed)
  const book = new OrderBook(cfg.instrument)
  const tick = cfg.instrument.tickSize
  let ref = cfg.ref.initial
  let seq = 0

  // FIFO inventory lots. costRemainingMicro carries the lot's exact unspent
  // cost so partial consumption never re-rounds — conservation stays exact.
  const lots: { qty: number; priceMicroPerM: number; costRemainingMicro: number }[] = []
  let inventory = 0
  let resellOrderId: string | null = null

  const report: DiscountSessionReport = {
    seed,
    tokensBought: 0,
    tokensResold: 0,
    costMicro: 0,
    proceedsMicro: 0,
    realizedCaptureMicro: 0,
    discountAtBuyMicro: 0,
    residualTokens: 0,
    residualMarkMicro: 0,
    unrealizedMicro: 0,
    equityCaptureMicro: 0,
  }

  const notional = (priceMicroPerM: number, qty: number) => Math.round((priceMicroPerM * qty) / 1_000_000)
  const expSize = (mean: number) => Math.max(cfg.instrument.minQty, Math.round(-Math.log(1 - rand()) * mean))
  const toTick = (raw: number, dir: 'up' | 'down') =>
    Math.max(tick, (dir === 'up' ? Math.ceil : Math.floor)(raw / tick) * tick)

  for (let t = 1; t <= cfg.horizonTicks; t += 1) {
    // 1. Reference walk (router list price).
    ref = Math.max(tick, Math.round(ref * (1 + gaussian(rand) * cfg.ref.volPerTick + cfg.ref.driftPerTick)))

    // 2. Distressed surplus dump arrives below reference.
    if (rand() < cfg.dump.probPerTick) {
      const discountBps = Math.max(0, cfg.dump.discountBpsMean * (0.5 + rand()))
      seq += 1
      book.place({
        id: `dump-${seq}`,
        instrumentId: cfg.instrument.id,
        side: 'sell',
        price: toTick(ref * (1 - discountBps / 10_000), 'down'),
        qty: expSize(cfg.dump.sizeMean),
        owner: 'dumper',
        ts: t * 1000,
      })
    }

    // 3. Pull our re-offer before lifting, so the lift can never self-cross.
    if (resellOrderId) {
      book.cancel(resellOrderId)
      resellOrderId = null
    }

    // 4. Lift everything at or below the edge threshold, up to capacity.
    const liftBelow = toTick(ref * (1 - cfg.strategy.minEdgeBps / 10_000), 'down')
    while (cfg.strategy.maxInventory - inventory >= cfg.instrument.minQty) {
      const best = book.bestAsk()
      if (best === undefined || best > liftBelow) break
      seq += 1
      const result = book.place({
        id: `lift-${seq}`,
        instrumentId: cfg.instrument.id,
        side: 'buy',
        price: best,
        qty: cfg.strategy.maxInventory - inventory,
        owner: MM,
        ts: t * 1000 + 1,
      })
      if (result.resting) book.cancel(result.resting.id) // IOC
      for (const fill of result.fills) {
        inventory += fill.qty
        report.tokensBought += fill.qty
        const cost = notional(fill.price, fill.qty)
        report.costMicro += cost
        if (ref > fill.price) report.discountAtBuyMicro += notional(ref - fill.price, fill.qty)
        lots.push({ qty: fill.qty, priceMicroPerM: fill.price, costRemainingMicro: cost })
      }
      if (result.fills.length === 0) break
    }

    // 5. Re-offer the whole inventory just below reference.
    if (inventory >= cfg.instrument.minQty) {
      seq += 1
      resellOrderId = `resell-${seq}`
      book.place({
        id: resellOrderId,
        instrumentId: cfg.instrument.id,
        side: 'sell',
        price: toTick(ref * (1 - cfg.strategy.resellDiscountBps / 10_000), 'up'),
        qty: inventory,
        owner: MM,
        ts: t * 1000 + 2,
      })
    }

    // 6. Retail buy flow lifts re-offers near list.
    const arrivals = poisson(rand, cfg.takers.intensity)
    for (let i = 0; i < arrivals; i += 1) {
      seq += 1
      const result = book.place({
        id: `taker-${seq}`,
        instrumentId: cfg.instrument.id,
        side: 'buy',
        price: toTick(ref * (1 + (cfg.takers.aggressionBps / 10_000) * rand()), 'up'),
        qty: expSize(cfg.takers.sizeMean),
        owner: 'taker',
        ts: t * 1000 + 3 + i,
      })
      if (result.resting) book.cancel(result.resting.id) // IOC
      for (const fill of result.fills) {
        if (fill.makerOwner !== MM) continue // taker hit a dumper's ask, not ours
        inventory -= fill.qty
        report.tokensResold += fill.qty
        const proceeds = notional(fill.price, fill.qty)
        report.proceedsMicro += proceeds
        report.realizedCaptureMicro += proceeds - popFifoCost(lots, fill.qty, notional)
      }
    }
  }

  report.residualTokens = inventory
  const residualCost = lots.reduce((a, lot) => a + lot.costRemainingMicro, 0)
  report.residualMarkMicro = notional(ref, inventory)
  report.unrealizedMicro = report.residualMarkMicro - residualCost
  report.equityCaptureMicro = report.realizedCaptureMicro + report.unrealizedMicro
  return report
}

function popFifoCost(
  lots: { qty: number; priceMicroPerM: number; costRemainingMicro: number }[],
  qty: number,
  notional: (price: number, qty: number) => number,
): number {
  let remaining = qty
  let cost = 0
  while (remaining > 0) {
    const lot = lots[0]
    if (!lot) throw new Error('resold more than acquired — accounting bug')
    const take = Math.min(lot.qty, remaining)
    // Full-lot take closes out the exact remaining cost; partial takes round
    // once and deduct, so the lot's residual stays exact.
    const takeCost = take === lot.qty ? lot.costRemainingMicro : notional(lot.priceMicroPerM, take)
    cost += takeCost
    lot.qty -= take
    lot.costRemainingMicro -= takeCost
    remaining -= take
    if (lot.qty === 0) lots.shift()
  }
  return cost
}

function poisson(rand: () => number, lambda: number): number {
  const l = Math.exp(-lambda)
  let k = 0
  let p = 1
  do {
    k += 1
    p *= rand()
  } while (p > l)
  return k - 1
}
