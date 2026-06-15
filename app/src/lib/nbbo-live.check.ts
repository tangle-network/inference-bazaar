/**
 * Read-only Layer-2 demonstration against the LIVE fleet: point the REAL
 * fetchAggBook + planRoute at the production venues and print the consolidated
 * NBBO ladder + a route over it. No spend, no mutation — proves the aggregation
 * assembles one market view from the real, independent fleet venues.
 *
 *   npx tsx src/lib/nbbo-live.check.ts
 */
import type { Address } from 'viem'
import { fetchAggBook, type Venue } from './venues'
import { nbboTouch, planRoute } from './router'

const INSTRUMENT = process.env.INSTRUMENT ?? 'claude-sonnet-4-6:output'
const venues = [
  { operator: '0x2420FFf17c4213A4075cf5f7B6dc33429Aaf22Bb' as Address, url: 'https://inference-bazaar2.178.104.232.124.sslip.io', healthy: true },
  { operator: '0x483fA87BE29E007bc21349A1fE9380CAf1f4Bb48' as Address, url: 'https://inference-bazaar.178.104.232.124.sslip.io', healthy: true },
  { operator: '0x72831d25c8B385E98B22a7abF59331251E060D5a' as Address, url: 'http://95.216.8.253:9500', healthy: true },
] as unknown as Venue[]

const agg = await fetchAggBook(venues, INSTRUMENT)

console.log(`\nLIVE consolidated NBBO — ${INSTRUMENT}  (${agg.perVenue.length} venue(s) responded)`)
console.log('asks (best-first):')
for (const l of agg.asks) console.log(`  ${String(l.price).padStart(10)}  x${String(l.qty).padEnd(8)} ⟵ ${l.operator}`)
if (!agg.asks.length) console.log('  (no resting asks right now)')

const sorted = agg.asks.every((l, i) => i === 0 || agg.asks[i - 1]!.price <= l.price)
const opsOnBook = new Set(agg.asks.map((l) => l.operator))
console.log(`\nNBBO touch (best ask): ${nbboTouch(agg, 'buy') ?? '—'}`)
console.log(`ladder price-sorted ascending: ${sorted}`)
console.log(`distinct operators on the ask side: ${opsOnBook.size}`)

// Route a size that crosses the first operator boundary, so the SOR is forced
// to roll from the cheapest venue onto the next one — a real cross-venue split
// over live liquidity (when ≥2 operators rest asks).
if (agg.asks.length >= 2) {
  const firstOp = agg.asks[0]!.operator
  let span = 0
  for (const l of agg.asks) {
    span += l.qty
    if (l.operator !== firstOp) break // include the first level of the 2nd venue
  }
  const route = planRoute(agg, 'buy', span)
  console.log(`\nSOR plan for a ${span}-token buy over the LIVE ladder:`)
  for (const leg of route.legs) console.log(`  lift ${String(leg.qtyTokens).padEnd(8)} @ ${leg.priceMicroPerM}  from ${leg.operator}`)
  console.log(`  filled ${route.filledTokens}/${route.requestedTokens}  avg ${route.avgPriceMicroPerM}  legs=${route.legs.length}  partial=${route.partial}`)
  const distinctRouteOps = new Set(route.legs.map((l) => l.operator)).size
  console.log(distinctRouteOps >= 2
    ? `\nLIVE LAYER-2: the buy split across ${distinctRouteOps} independent fleet venues from one merged book`
    : `\nLIVE LAYER-2: aggregation + routing ran over the live fleet (top depth sat on one venue, so this size took one leg)`)
} else {
  console.log('\n(need ≥2 resting levels to demonstrate a split route)')
}
