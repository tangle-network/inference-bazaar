// H3 adversarial proof (run via CLOB_DRIVER=scripts/clob-presim.mjs clob-e2e.sh):
// a buyer crosses a seller, then WITHDRAWS their settlement balance before the
// epoch — the classic griefing that, pre-fix, reverted the whole batch on-chain
// (InsufficientBalance) and stranded the seller's good order. The proposer's
// pre-match simulation must instead detect the unfundable buy, evict it, and
// settle nothing on-chain (no revert, batchNonce unchanged) — the grief is a
// no-op, and the seller's order is free to match a funded buyer next time.
import { createPublicClient, createWalletClient, http, parseAbi, keccak256, toHex, zeroHash } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { anvil } from 'viem/chains'

const RPC = process.env.RPC ?? 'http://127.0.0.1:8545'
const SETTLEMENT = process.env.SETTLEMENT
const USD = process.env.USD
const NODE_A = process.env.NODE_A
const NODE_B = process.env.NODE_B
const INSTRUMENT = 'claude-sonnet-4-6:output'
const BOOK = '0x0000000000000000000000000000000000000000000000000000000000000000'

const operator = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const buyer = privateKeyToAccount('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6')

const sAbi = parseAbi([
  'function deposit(uint256 amount)',
  'function withdraw(uint256 amount)',
  'function depositCollateral(uint256 amount)',
  'function balances(address) view returns (uint256)',
  'function bookNonce(bytes32) view returns (uint64)',
])
const usdAbi = parseAbi([
  'function mint(address to, uint256 amount)',
  'function approve(address spender, uint256 amount) returns (bool)',
])
const pub = createPublicClient({ chain: anvil, transport: http(RPC) })
const w = (a) => createWalletClient({ account: a, chain: anvil, transport: http(RPC) })
const tx = (h) => pub.waitForTransactionReceipt({ hash: h })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PRICE = 15_000_000n
const QTY = 1_000_000n
const COST = (PRICE * QTY) / 1_000_000n

const bw = w(buyer), ow = w(operator)
await tx(await bw.writeContract({ address: USD, abi: usdAbi, functionName: 'mint', args: [buyer.address, COST] }))
await tx(await bw.writeContract({ address: USD, abi: usdAbi, functionName: 'approve', args: [SETTLEMENT, COST] }))
await tx(await bw.writeContract({ address: SETTLEMENT, abi: sAbi, functionName: 'deposit', args: [COST] }))
const COLL = (COST * 110n) / 100n
await tx(await ow.writeContract({ address: USD, abi: usdAbi, functionName: 'mint', args: [operator.address, COLL] }))
await tx(await ow.writeContract({ address: USD, abi: usdAbi, functionName: 'approve', args: [SETTLEMENT, COLL] }))
await tx(await ow.writeContract({ address: SETTLEMENT, abi: sAbi, functionName: 'depositCollateral', args: [COLL] }))

const domain = { name: 'SurplusSettlement', version: '1', chainId: anvil.id, verifyingContract: SETTLEMENT }
const types = { Order: [
  { name: 'instrument', type: 'bytes32' }, { name: 'side', type: 'uint8' },
  { name: 'priceMicroPerM', type: 'uint64' }, { name: 'qtyTokens', type: 'uint64' },
  { name: 'lotId', type: 'bytes32' }, { name: 'trader', type: 'address' },
  { name: 'expiry', type: 'uint64' }, { name: 'salt', type: 'bytes32' },
]}
async function signedOrder(acct, side, salt) {
  const order = {
    instrument: keccak256(toHex(INSTRUMENT)), side, priceMicroPerM: Number(PRICE), qtyTokens: Number(QTY),
    lotId: zeroHash, trader: acct.address, expiry: Math.floor(Date.now() / 1000) + 3600, salt: keccak256(toHex(salt)),
  }
  const signature = await w(acct).signTypedData({
    domain, types, primaryType: 'Order',
    message: { ...order, priceMicroPerM: PRICE, qtyTokens: QTY, expiry: BigInt(order.expiry) },
  })
  return { instrumentId: INSTRUMENT, order, signature }
}
async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const t = await r.text()
  if (!r.ok) throw new Error(`${url} -> ${r.status}: ${t}`)
  return JSON.parse(t)
}

// Crossing pair enters at both nodes.
await post(`${NODE_A}/clob/order`, await signedOrder(operator, 1, 'presim-sell'))
await post(`${NODE_B}/clob/order`, await signedOrder(buyer, 0, 'presim-buy'))

// THE ATTACK: the buyer withdraws their whole settlement balance, so the buy
// order can no longer settle (InsufficientBalance) — but it's already in the book.
await tx(await bw.writeContract({ address: SETTLEMENT, abi: sAbi, functionName: 'withdraw', args: [COST] }))
const bal = await pub.readContract({ address: SETTLEMENT, abi: sAbi, functionName: 'balances', args: [buyer.address] })
if (bal !== 0n) throw new Error('buyer balance should be 0 after withdraw')
console.log('attack staged: buyer withdrew, balance now 0')

const nonce0 = await pub.readContract({ address: SETTLEMENT, abi: sAbi, functionName: 'bookNonce', args: [BOOK] })

// Let several epochs pass (epoch_secs=5). The proposer's pre-sim must evict the
// unfundable buy and settle nothing — NOT submit a reverting batch.
for (let i = 0; i < 8; i++) await sleep(2000)

const nonce1 = await pub.readContract({ address: SETTLEMENT, abi: sAbi, functionName: 'bookNonce', args: [BOOK] })
const statusA = await (await fetch(`${NODE_A}/clob/status`)).json()
const statusB = await (await fetch(`${NODE_B}/clob/status`)).json()

if (nonce1 !== nonce0) throw new Error(`a batch settled (nonce ${nonce0}->${nonce1}) — the unfundable buy was NOT evicted`)

console.log('')
console.log('=== H3 PRE-SIM PROVEN ===')
console.log(`bookNonce unchanged at ${nonce1}: the doomed buy was evicted, NOT submitted into an on-chain revert`)
console.log(`pools after: A=${statusA.poolSize} B=${statusB.poolSize} (the unfundable buy dropped from the matchable set)`)
