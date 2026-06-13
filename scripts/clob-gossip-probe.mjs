// Free liveness probe for the upgraded live fleet: sign ONE far-from-market
// (never-crossing, unfunded) order, POST it to one node, and confirm it gossips
// to every peer's pool. Proves admission + EIP-712 verify + cross-DC HTTP
// transport on the new binary — no on-chain spend, no funding required. The
// order rests harmlessly and self-expires.
import { createWalletClient, http, keccak256, toHex, zeroHash } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'

const SETTLEMENT = process.env.SETTLEMENT ?? '0x64867eacf2e4581d182c2Be634cfD7fF3D3d9f83'
const INSTRUMENT = process.env.INSTRUMENT ?? 'claude-sonnet-4-6:output'
// op5 (Helsinki) is the entry point; the two Nuremberg venues are the peers.
const ENTRY = process.env.ENTRY ?? 'http://95.216.8.253:9500'
const PEERS = (process.env.PEERS ?? 'https://surplus2.178.104.232.124.sslip.io,https://surplus.178.104.232.124.sslip.io').split(',')

// Deterministic throwaway key — never funded; the order can never settle.
const trader = privateKeyToAccount(keccak256(toHex(`gossip-probe-${Date.now()}`)))
const domain = { name: 'SurplusSettlement', version: '1', chainId: baseSepolia.id, verifyingContract: SETTLEMENT }
const types = { Order: [
  { name: 'instrument', type: 'bytes32' }, { name: 'side', type: 'uint8' },
  { name: 'priceMicroPerM', type: 'uint64' }, { name: 'qtyTokens', type: 'uint64' },
  { name: 'lotId', type: 'bytes32' }, { name: 'trader', type: 'address' },
  { name: 'expiry', type: 'uint64' }, { name: 'salt', type: 'bytes32' },
]}

// A bid at price 1 (micro-tsUSD per 1M tokens) — orders of magnitude below any
// real ask, so it can never cross. On-tick (tick 1000 → 1 is NOT on-tick); use
// the tick so admission/match accept it but it still never crosses: 1000.
const PRICE = 1000n
const QTY = 100_000n
const order = {
  instrument: keccak256(toHex(INSTRUMENT)), side: 0, // buy
  priceMicroPerM: Number(PRICE), qtyTokens: Number(QTY), lotId: zeroHash,
  trader: trader.address, expiry: Math.floor(Date.now() / 1000) + 1800, salt: keccak256(toHex('probe')),
}
const signature = await createWalletClient({ account: trader, chain: baseSepolia, transport: http() })
  .signTypedData({ domain, types, primaryType: 'Order',
    message: { ...order, priceMicroPerM: PRICE, qtyTokens: QTY, expiry: BigInt(order.expiry) } })

const poolSize = async (url) => {
  try {
    const r = await fetch(`${url}/clob/status`, { signal: AbortSignal.timeout(6000) })
    return (await r.json()).poolSize
  } catch (e) { return `ERR(${e.message})` }
}

const before = {}
for (const p of [ENTRY, ...PEERS]) before[p] = await poolSize(p)
console.log('pools before:', before)

const r = await fetch(`${ENTRY}/clob/order`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instrumentId: INSTRUMENT, order, signature }),
})
console.log(`POST ${ENTRY}/clob/order -> ${r.status}: ${(await r.text()).slice(0, 160)}`)

await new Promise((s) => setTimeout(s, 2500)) // let gossip fan out
const after = {}
for (const p of [ENTRY, ...PEERS]) after[p] = await poolSize(p)
console.log('pools after: ', after)

const reached = [ENTRY, ...PEERS].filter((p) => Number(after[p]) > Number(before[p] ?? 0))
console.log(`\n=== gossip reached ${reached.length}/${1 + PEERS.length} nodes ===`)
if (reached.length === 1 + PEERS.length) console.log('LIVE FLEET GOSSIP OK: order admitted at op5 and fanned to both Nuremberg venues')
else console.log('PARTIAL: not every node saw the order — investigate transport')
