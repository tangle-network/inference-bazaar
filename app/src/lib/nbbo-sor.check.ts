/**
 * Cross-instance (Layer-2) integration check: proves the "one market" thesis
 * end-to-end over REAL, independent venue processes — not fixtures.
 *
 * router.check.ts already proves planRoute's math on hand-built ladders. What is
 * NOT proven anywhere is that the REAL aggregation composes: two independent
 * venues, each with its own book at a different price, merge through the REAL
 * `fetchAggBook` into one NBBO ladder, and the REAL `planRoute` splits one order
 * across both — with correct per-operator attribution. That is the load-bearing
 * Layer-2 claim, and it only ever ran at N=1.
 *
 * Driven by scripts/nbbo-sor-e2e.sh, which boots two operator-lite venues, posts
 * a cheap ask at venue B and a dearer one at venue A, then runs this against
 * their live /book endpoints. Uses the SAME fetchAggBook + planRoute the app
 * ships — no reimplementation.
 *
 *   NODE_A / NODE_B   live venue base URLs
 *   OP_A   / OP_B     their operator addresses
 *   INSTRUMENT        instrument id (default claude-sonnet-4-6:output)
 *   BUY_QTY           size to route (default 8000)
 */
import type { Address } from 'viem'
import { fetchAggBook, type Venue } from './venues'
import { nbboTouch, planRoute } from './router'

const NODE_A = process.env.NODE_A ?? 'http://127.0.0.1:9210'
const NODE_B = process.env.NODE_B ?? 'http://127.0.0.1:9211'
const OP_A = (process.env.OP_A ?? '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266') as Address
const OP_B = (process.env.OP_B ?? '0x70997970C51812dc3A010C7d01b50e0d17dc79C8') as Address
const INSTRUMENT = process.env.INSTRUMENT ?? 'claude-sonnet-4-6:output'
const BUY_QTY = Number(process.env.BUY_QTY ?? 8000)

// Minimal Venue records — fetchAggBook reads only { url, operator, healthy }.
const venues = [
  { operator: OP_A, url: NODE_A, healthy: true },
  { operator: OP_B, url: NODE_B, healthy: true },
] as unknown as Venue[]

let pass = 0
let fail = 0
const eq = (a: unknown, b: unknown, m: string) => {
  if (JSON.stringify(a) === JSON.stringify(b)) {
    pass++
    console.log(`  ok   ${m}`)
  } else {
    fail++
    console.error(`  FAIL ${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`)
  }
}

const agg = await fetchAggBook(venues, INSTRUMENT)

console.log(`\nmerged NBBO ladder (asks, best-first) — instrument ${INSTRUMENT}:`)
for (const l of agg.asks) console.log(`  ${String(l.price).padStart(10)}  x${String(l.qty).padEnd(7)} ⟵ ${l.operator}`)

// 1. The merge consolidated BOTH independent venues into one ladder.
eq(agg.perVenue.length, 2, 'both venues contributed to the aggregate book')
const askOps = new Set(agg.asks.map((l) => l.operator))
eq(askOps.has(OP_A) && askOps.has(OP_B), true, 'both operators appear on the ask side')

// 2. NBBO touch is the genuinely cheapest venue (B), not A's local best.
const touch = nbboTouch(agg, 'buy')
const bestLevel = agg.asks[0]
eq(bestLevel?.operator, OP_B, 'best ask is venue B (the cheaper instance)')
eq(touch, bestLevel?.price, 'nbboTouch returns the top-of-merged-book price')

// 3. The ladder is strictly price-sorted ascending (the merge, not one venue).
const sorted = agg.asks.every((l, i) => i === 0 || agg.asks[i - 1]!.price <= l.price)
eq(sorted, true, 'merged asks are price-sorted ascending across venues')

// 4. SOR splits ONE order across BOTH venues, cheapest-first, attributed.
const route = planRoute(agg, 'buy', BUY_QTY)
console.log(`\nSOR plan for a ${BUY_QTY}-token buy:`)
for (const leg of route.legs) console.log(`  lift ${String(leg.qtyTokens).padEnd(7)} @ ${leg.priceMicroPerM}  from ${leg.operator}`)
console.log(`  filled ${route.filledTokens}/${route.requestedTokens}  avg ${route.avgPriceMicroPerM}  partial=${route.partial}`)

eq(route.legs.length >= 2, true, 'the buy splits across at least two venues')
eq(route.legs[0]?.operator, OP_B, 'first leg lifts the cheaper venue B')
eq(route.legs[1]?.operator, OP_A, 'second leg rolls onto venue A')
eq(route.filledTokens, BUY_QTY, 'route fills the full requested size')
eq(route.partial, false, 'not partial when depth suffices')
// Blended price is strictly between the two venue prices — proof it really
// straddled both, not just took one.
const pB = agg.asks.find((l) => l.operator === OP_B)!.price
const pA = agg.asks.find((l) => l.operator === OP_A)!.price
eq(route.avgPriceMicroPerM > pB && route.avgPriceMicroPerM < pA, true, 'blended avg lies between the two venues')

// 5. A limit tighter than venue A stops the walk at venue B (partial) — the
// router never crosses the trader's limit even when more (dearer) depth exists.
const capped = planRoute(agg, 'buy', BUY_QTY, pB)
eq(capped.legs.every((l) => l.operator === OP_B), true, 'a limit at venue B price routes only to venue B')
eq(capped.partial, true, 'limited route is partial (dearer venue-A depth left untouched)')

console.log(`\nnbbo-sor: ${pass} passed, ${fail} failed`)
if (fail === 0) console.log('LAYER-2 PROVEN: two independent venues → one merged NBBO → one order split across both, attributed per operator')
process.exit(fail === 0 ? 0 : 1)
