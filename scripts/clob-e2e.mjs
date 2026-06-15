// Shared-CLOB e2e driver (see clob-e2e.sh): fund a buyer and a seller, sign a
// crossing EIP-712 pair, enter each side at a DIFFERENT operator, and prove the
// gossip -> epoch match -> co-sign -> settleBatchAttested loop on-chain.
import { createPublicClient, createWalletClient, http, parseAbi, parseAbiItem, keccak256, toHex, zeroHash } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { anvil } from 'viem/chains'

const RPC = process.env.RPC ?? 'http://127.0.0.1:8545'
const SETTLEMENT = process.env.SETTLEMENT
const USD = process.env.USD
const NODE_A = process.env.NODE_A ?? 'http://127.0.0.1:9210'
const NODE_B = process.env.NODE_B ?? 'http://127.0.0.1:9211'
const INSTRUMENT = 'claude-sonnet-4-6:output'

// anvil keys #2 (seller/issuer) and #3 (buyer) — test material only.
const seller = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a')
const buyer = privateKeyToAccount('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6')

const settlementAbi = parseAbi([
  'function deposit(uint256 amount)',
  'function depositCollateral(uint256 amount)',
  'function balances(address) view returns (uint256)',
  'function bookNonce(bytes32 bookId) view returns (uint64)',
  'function lots(bytes32) view returns (address holder, address issuer, bytes32 instrument, uint64 qtyTokens, uint64 lockedTokens, uint64 expiry, uint128 notionalMicro)',
])
const usdAbi = parseAbi([
  'function mint(address to, uint256 amount)',
  'function approve(address spender, uint256 amount) returns (bool)',
])

const pub = createPublicClient({ chain: anvil, transport: http(RPC) })
const wallet = (account) => createWalletClient({ account, chain: anvil, transport: http(RPC) })

const PRICE = 15_000_000n // micro-USD per 1M tokens
const QTY = 1_000_000n
const COST = (PRICE * QTY) / 1_000_000n // 15 USD

async function tx(hash) { return pub.waitForTransactionReceipt({ hash }) }

// Fund: buyer deposits cash for the buy; seller posts collateral to mint.
const sw = wallet(seller), bw = wallet(buyer)
await tx(await bw.writeContract({ address: USD, abi: usdAbi, functionName: 'mint', args: [buyer.address, COST] }))
await tx(await bw.writeContract({ address: USD, abi: usdAbi, functionName: 'approve', args: [SETTLEMENT, COST] }))
await tx(await bw.writeContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'deposit', args: [COST] }))
const COLLATERAL = (COST * 110n) / 100n // covers liability + 500bps penalty
await tx(await sw.writeContract({ address: USD, abi: usdAbi, functionName: 'mint', args: [seller.address, COLLATERAL] }))
await tx(await sw.writeContract({ address: USD, abi: usdAbi, functionName: 'approve', args: [SETTLEMENT, COLLATERAL] }))
await tx(await sw.writeContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'depositCollateral', args: [COLLATERAL] }))
console.log(`funded: buyer deposit ${COST} micro, seller collateral ${COLLATERAL} micro`)

const domain = { name: 'InferenceBazaarSettlement', version: '1', chainId: anvil.id, verifyingContract: SETTLEMENT }
const types = { Order: [
  { name: 'instrument', type: 'bytes32' }, { name: 'side', type: 'uint8' },
  { name: 'priceMicroPerM', type: 'uint64' }, { name: 'qtyTokens', type: 'uint64' },
  { name: 'lotId', type: 'bytes32' }, { name: 'trader', type: 'address' },
  { name: 'expiry', type: 'uint64' }, { name: 'salt', type: 'bytes32' },
]}

async function signedOrder(account, side, salt) {
  const order = {
    instrument: keccak256(toHex(INSTRUMENT)),
    side,
    priceMicroPerM: Number(PRICE),
    qtyTokens: Number(QTY),
    lotId: zeroHash,
    trader: account.address,
    expiry: Math.floor(Date.now() / 1000) + 3600,
    salt: keccak256(toHex(salt)),
  }
  const signature = await wallet(account).signTypedData({
    domain, types, primaryType: 'Order',
    message: { ...order, priceMicroPerM: PRICE, qtyTokens: QTY, expiry: BigInt(order.expiry) },
  })
  return { instrumentId: INSTRUMENT, order, signature }
}

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const text = await r.text()
  if (!r.ok) throw new Error(`${url} -> ${r.status}: ${text}`)
  return JSON.parse(text)
}
const status = async (node) => (await fetch(`${node}/clob/status`)).json()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The crossing pair enters the market at DIFFERENT operators.
const nonce0 = await pub.readContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'bookNonce', args: ['0x0000000000000000000000000000000000000000000000000000000000000000'] })
console.log('sell -> node A:', JSON.stringify(await post(`${NODE_A}/clob/order`, await signedOrder(seller, 1, 'clob-e2e-sell'))))
console.log('buy  -> node B:', JSON.stringify(await post(`${NODE_B}/clob/order`, await signedOrder(buyer, 0, 'clob-e2e-buy'))))

// Gossip converges, the elected proposer's epoch loop fires, quorum settles.
let nonce = nonce0
for (let i = 0; i < 60 && nonce === nonce0; i++) {
  await sleep(1000)
  nonce = await pub.readContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'bookNonce', args: ['0x0000000000000000000000000000000000000000000000000000000000000000'] })
}
if (nonce === nonce0) {
  console.error('A:', JSON.stringify(await status(NODE_A)))
  console.error('B:', JSON.stringify(await status(NODE_B)))
  throw new Error('batch never settled: batchNonce unchanged after 60s')
}

// On-chain proof: the batch event, the moved balances, the minted lot.
const [batchLog] = await pub.getLogs({
  address: SETTLEMENT,
  event: parseAbiItem('event BatchSettled(bytes32 indexed bookId, uint64 indexed batchNonce, bytes32 fillsHash, uint256 fillCount, bool proven, bytes32 ordersCommitment)'),
  fromBlock: 0n,
})
const [fillLog] = await pub.getLogs({
  address: SETTLEMENT,
  event: parseAbiItem('event FillSettled(bytes32 indexed buyOrderHash, bytes32 indexed sellOrderHash, bytes32 instrument, uint64 qtyTokens, uint64 execPriceMicroPerM, uint256 costMicro, bytes32 lotId)'),
  fromBlock: 0n,
})
const buyerBal = await pub.readContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'balances', args: [buyer.address] })
const sellerBal = await pub.readContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'balances', args: [seller.address] })
const lot = await pub.readContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'lots', args: [fillLog.args.lotId] })

if (buyerBal !== 0n) throw new Error(`buyer balance ${buyerBal}, expected 0 (fully spent)`)
const expectedSeller = COST - (COST * 200n) / 10_000n // minus 200bps fee
if (sellerBal !== expectedSeller) throw new Error(`seller balance ${sellerBal}, expected ${expectedSeller}`)
if (lot[0].toLowerCase() !== buyer.address.toLowerCase()) throw new Error(`lot holder ${lot[0]}, expected buyer`)
if (lot[1].toLowerCase() !== seller.address.toLowerCase()) throw new Error(`lot issuer ${lot[1]}, expected seller`)

// Both pools pruned: the settled orders can never re-match.
for (const [name, node] of [['A', NODE_A], ['B', NODE_B]]) {
  const s = await status(node)
  if (s.poolSize !== 0) throw new Error(`node ${name} pool not pruned: ${JSON.stringify(s)}`)
}

console.log('')
console.log('=== SHARED-CLOB E2E PROVEN ===')
console.log(`batchNonce:   ${nonce0} -> ${nonce}`)
console.log(`fillsHash:    ${batchLog.args.fillsHash} (${batchLog.args.fillCount} fill, attested 2-of-2)`)
console.log(`settled tx:   ${batchLog.transactionHash}`)
console.log(`buyer:        paid ${COST} micro, holds lot ${fillLog.args.lotId} (${lot[3]} tokens)`)
console.log(`seller:       received ${sellerBal} micro (after 200bps fee)`)
