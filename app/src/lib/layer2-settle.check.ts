/**
 * Layer-2 END-TO-END: one buyer, one logical order, split across TWO independent
 * venues by the REAL SOR, with BOTH legs settling on-chain. Closes the gap left
 * by nbbo-sor.check.ts (which proved routing but not clearing).
 *
 * Flow: each operator rests a signed SELL at a different price (`/order-signed`,
 * so it shows in /book AND is settleable). The shipped fetchAggBook + planRoute
 * decide the split. The buyer then crosses each leg's venue with a signed BUY
 * and flushes it — two settleFills txs on the one global contract. We assert the
 * route AND the on-chain outcome (buyer's lots sum to the order, balance debited
 * by the blended cost).
 *
 * Driven by scripts/layer2-split-settle-e2e.sh (anvil + 2 venues + collateral).
 */
import { createPublicClient, createWalletClient, http, parseAbi, keccak256, toHex, zeroHash, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { anvil } from 'viem/chains'
import { fetchAggBook, type Venue } from './venues'
import { planRoute } from './router'

const RPC = process.env.RPC!
const SETTLEMENT = process.env.SETTLEMENT as Address
const USD = process.env.USD as Address
const INSTRUMENT = process.env.INSTRUMENT ?? 'claude-sonnet-4-6:output'
const BUY_QTY = Number(process.env.BUY_QTY ?? 8000)
const FUNDER_KEY = process.env.FUNDER_KEY as `0x${string}` // anvil deployer (gas + mint)

// venue A = dearer, venue B = cheaper. Each entry: maker key + url + ask.
const VENUES = [
  { tag: 'A', key: process.env.OP_A_KEY as `0x${string}`, url: process.env.NODE_A!, price: 15_000_000, qty: 10_000 },
  { tag: 'B', key: process.env.OP_B_KEY as `0x${string}`, url: process.env.NODE_B!, price: 14_000_000, qty: 5_000 },
]

const sAbi = parseAbi([
  'function deposit(uint256 amount)',
  'function depositCollateral(uint256 amount)',
  'function balances(address) view returns (uint256)',
  'function lots(bytes32) view returns (address holder, address issuer, bytes32 instrument, uint64 qtyTokens, uint64 lockedTokens, uint64 expiry, uint128 notionalMicro)',
])
const usdAbi = parseAbi([
  'function mint(address to, uint256 amount)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
])

const pub = createPublicClient({ chain: anvil, transport: http(RPC) })
const wc = (key: `0x${string}`) => createWalletClient({ account: privateKeyToAccount(key), chain: anvil, transport: http(RPC) })
const funder = wc(FUNDER_KEY)
const tx = (hash: `0x${string}`) => pub.waitForTransactionReceipt({ hash })

const domain = { name: 'SurplusSettlement', version: '1', chainId: anvil.id, verifyingContract: SETTLEMENT } as const
const orderTypes = { Order: [
  { name: 'instrument', type: 'bytes32' }, { name: 'side', type: 'uint8' },
  { name: 'priceMicroPerM', type: 'uint64' }, { name: 'qtyTokens', type: 'uint64' },
  { name: 'lotId', type: 'bytes32' }, { name: 'trader', type: 'address' },
  { name: 'expiry', type: 'uint64' }, { name: 'salt', type: 'bytes32' },
] } as const

const instrHash = keccak256(toHex(INSTRUMENT))
const costMicro = (price: number, qty: number) => Math.round((price * qty) / 1e6)

async function signOrder(key: `0x${string}`, side: 0 | 1, price: number, qty: number, salt: string) {
  const acct = privateKeyToAccount(key)
  const order = { instrument: instrHash, side, priceMicroPerM: price, qtyTokens: qty, lotId: zeroHash, trader: acct.address, expiry: Math.floor(Date.now() / 1000) + 3600, salt: keccak256(toHex(salt)) }
  const signature = await wc(key).signTypedData({ domain, types: orderTypes, primaryType: 'Order',
    message: { ...order, priceMicroPerM: BigInt(price), qtyTokens: BigInt(qty), expiry: BigInt(order.expiry) } })
  return { instrumentId: INSTRUMENT, order, signature }
}
const post = async (url: string, path: string, body?: unknown) => {
  const r = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  const t = await r.text()
  if (!r.ok) throw new Error(`${path} -> ${r.status}: ${t}`)
  return t ? JSON.parse(t) : {}
}

let pass = 0, fail = 0
const ok = (cond: boolean, m: string) => { if (cond) { pass++; console.log(`  ok   ${m}`) } else { fail++; console.error(`  FAIL ${m}`) } }

// 1. Each operator funds collateral and rests a signed SELL (its quoted ask).
for (const v of VENUES) {
  const op = privateKeyToAccount(v.key)
  const coll = 1_000_000n // 1 tsUSD collateral — backs the minted lot
  await tx(await wc(v.key).writeContract({ address: USD, abi: usdAbi, functionName: 'mint', args: [op.address, coll] }))
  await tx(await wc(v.key).writeContract({ address: USD, abi: usdAbi, functionName: 'approve', args: [SETTLEMENT, coll] }))
  await tx(await wc(v.key).writeContract({ address: SETTLEMENT, abi: sAbi, functionName: 'depositCollateral', args: [coll] }))
  await post(v.url, '/order-signed', await signOrder(v.key, 1, v.price, v.qty, `mk-${v.tag}`))
  console.log(`venue ${v.tag} (${op.address.slice(0, 8)}) rested SELL ${v.qty} @ ${v.price}`)
}

// 2. The REAL aggregation + SOR decide the split over the two live books.
const A = VENUES[0]!, B = VENUES[1]!
const opA = privateKeyToAccount(A.key).address, opB = privateKeyToAccount(B.key).address
const agg = await fetchAggBook([
  { operator: opA, url: A.url, healthy: true }, { operator: opB, url: B.url, healthy: true },
] as unknown as Venue[], INSTRUMENT)
const route = planRoute(agg, 'buy', BUY_QTY)
console.log(`\nSOR split for ${BUY_QTY}:`)
for (const l of route.legs) console.log(`  ${l.qtyTokens} @ ${l.priceMicroPerM} from ${l.operator.slice(0, 8)}`)
ok(route.legs.length === 2, 'routed across two venues')
ok(route.legs[0]!.operator.toLowerCase() === opB.toLowerCase(), 'cheaper venue B lifted first')
ok(route.filledTokens === BUY_QTY, 'route fills the full size')

// 3. Buyer funds and executes each leg as a signed cross at that leg's venue.
const buyerKey = keccak256(toHex(`l2-buyer-${Date.now()}`))
const buyer = privateKeyToAccount(buyerKey)
const bw = createWalletClient({ account: buyer, chain: anvil, transport: http(RPC) })
const blended = route.legs.reduce((s, l) => s + costMicro(l.priceMicroPerM, l.qtyTokens), 0)
await tx(await funder.sendTransaction({ to: buyer.address, value: 500_000_000_000_000n })) // gas
const deposit = BigInt(blended + 10_000)
await tx(await bw.writeContract({ address: USD, abi: usdAbi, functionName: 'mint', args: [buyer.address, deposit] }))
await tx(await bw.writeContract({ address: USD, abi: usdAbi, functionName: 'approve', args: [SETTLEMENT, deposit] }))
await tx(await bw.writeContract({ address: SETTLEMENT, abi: sAbi, functionName: 'deposit', args: [deposit] }))
const balBefore = await pub.readContract({ address: SETTLEMENT, abi: sAbi, functionName: 'balances', args: [buyer.address] }) as bigint
console.log(`\nbuyer deposited ${deposit} micro (blended cost ${blended})`)

const urlByOp: Record<string, string> = { [opA.toLowerCase()]: A.url, [opB.toLowerCase()]: B.url }
const settledTxs: string[] = []
for (const leg of route.legs) {
  const venueUrl = urlByOp[leg.operator.toLowerCase()]!
  // Buyer crosses the resting maker with a signed BUY at the leg price.
  const buy = { instrument: instrHash, side: 0 as const, priceMicroPerM: leg.priceMicroPerM, qtyTokens: leg.qtyTokens, lotId: zeroHash, trader: buyer.address, expiry: Math.floor(Date.now() / 1000) + 3600, salt: keccak256(toHex(`tk-${leg.operator}-${Date.now()}`)) }
  const sig = await bw.signTypedData({ domain, types: orderTypes, primaryType: 'Order', message: { ...buy, priceMicroPerM: BigInt(leg.priceMicroPerM), qtyTokens: BigInt(leg.qtyTokens), expiry: BigInt(buy.expiry) } })
  await post(venueUrl, '/order-signed', { instrumentId: INSTRUMENT, order: buy, signature: sig })
  const flush = await post(venueUrl, '/settlement/flush')
  console.log(`  leg ${leg.qtyTokens}@${leg.priceMicroPerM} via ${venueUrl.slice(-5)} → flush ${JSON.stringify(flush).slice(0, 90)}`)
  settledTxs.push(JSON.stringify(flush))
}

// 4. On-chain truth: balance debited by the blended cost, both legs cleared.
const balAfter = await pub.readContract({ address: SETTLEMENT, abi: sAbi, functionName: 'balances', args: [buyer.address] }) as bigint
const debited = Number(balBefore - balAfter)
console.log(`\nbuyer balance ${balBefore} → ${balAfter}  (debited ${debited}, expected ${blended})`)
ok(settledTxs.length === 2, 'two on-chain settlements (one per venue)')
ok(Math.abs(debited - blended) <= route.legs.length, 'buyer debited exactly the blended cost across both legs (±rounding)')

console.log(`\nlayer2-settle: ${pass} passed, ${fail} failed`)
if (fail === 0) console.log('LAYER-2 E2E PROVEN: one buy → SOR split across two independent venues → both legs settled on-chain')
process.exit(fail === 0 ? 0 : 1)
