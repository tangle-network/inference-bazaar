/**
 * Runnable checks for the SOR (no test runner in this app yet):
 *   npx tsx src/lib/router.check.ts
 */
import { planRoute, nbboTouch } from './router'
import type { Address } from 'viem'

const op = (n: number) => ('0x' + n.toString().padStart(40, '0')) as Address
function book(asks: [number, number, number][], bids: [number, number, number][] = []) {
  return {
    instrumentId: 'm',
    refMid: 0,
    perVenue: [],
    asks: asks.map(([price, qty, o]) => ({ price, qty, orders: 1, operator: op(o) })),
    bids: bids.map(([price, qty, o]) => ({ price, qty, orders: 1, operator: op(o) })),
  } as unknown as Parameters<typeof planRoute>[0]
}
let pass = 0
let fail = 0
const eq = (a: unknown, b: unknown, m: string) => {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++
  else {
    fail++
    console.error(`FAIL ${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`)
  }
}

const b = book([
  [100, 6, 1],
  [100, 4, 2],
  [102, 10, 3],
])
const r = planRoute(b, 'buy', 12)
eq(r.legs.length, 3, 'three legs')
eq(
  r.legs.map((l) => [l.priceMicroPerM, l.qtyTokens]),
  [
    [100, 6],
    [100, 4],
    [102, 2],
  ],
  'split fills cheapest venues first',
)
eq(r.filledTokens, 12, 'filled all 12')
eq(r.partial, false, 'not partial')
eq(r.avgPriceMicroPerM, Math.floor((100 * 10 + 102 * 2) / 12), 'weighted avg price')

const r2 = planRoute(b, 'buy', 12, 100)
eq(r2.filledTokens, 10, 'limit 100 fills only the 100-priced levels')
eq(r2.partial, true, 'partial under tight limit')

const r3 = planRoute(
  book([
    [100, 5, 1],
    [100, 5, 1],
  ]),
  'buy',
  8,
)
eq(r3.legs.length, 1, 'same venue+price coalesces')
eq(r3.legs[0]?.qtyTokens, 8, 'coalesced qty')

const r4 = planRoute(book([[100, 3, 1]]), 'buy', 10)
eq(r4.filledTokens, 3, 'thin book fills 3')
eq(r4.partial, true, 'thin partial')

const sb = book(
  [],
  [
    [99, 5, 1],
    [98, 5, 2],
  ],
)
const r5 = planRoute(sb, 'sell', 7)
eq(
  r5.legs.map((l) => l.priceMicroPerM),
  [99, 98],
  'sell hits best bid first',
)
eq(nbboTouch(sb, 'sell'), 99, 'nbbo bid touch')
eq(nbboTouch(b, 'buy'), 100, 'nbbo ask touch')
eq(nbboTouch(book([]), 'buy'), null, 'empty side null')

console.log(`router: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
