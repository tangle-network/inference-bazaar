// LIVE shared-CLOB proof on Base Sepolia: a fresh buyer and seller enter a
// crossing pair at DIFFERENT live operators; the elected proposer matches the
// epoch, the peer co-signs, and the 2-of-2 attested batch settles on the real
// tsUSD rail. Run: FUNDER_KEY=0x... node scripts/clob-e2e-live.mjs
import { createPublicClient, createWalletClient, http, parseAbi, parseAbiItem, keccak256, toHex, zeroHash } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import fs from 'node:fs'

const RPC = process.env.RPC ?? 'https://base-sepolia-rpc.publicnode.com'
const SETTLEMENT = process.env.SETTLEMENT ?? '0x1cD49739e9CF48C4906aDb44021dd8cE0d8aBa64'
const USD = process.env.USD ?? '0x14Ff9231D03Fd9AD75e553004585f13Ff51db630'
const NODE_A = process.env.NODE_A ?? 'https://surplus2.178.104.232.124.sslip.io' // service 3 :9500
const NODE_B = process.env.NODE_B ?? 'https://surplus.178.104.232.124.sslip.io'  // service 4 :9400
const INSTRUMENT = process.env.INSTRUMENT ?? 'claude-sonnet-4-6:output'
const BOOK = process.env.BOOK ?? '0x0000000000000000000000000000000000000000000000000000000000000000'
const FUNDER_KEY = process.env.FUNDER_KEY
if (!FUNDER_KEY) throw new Error('FUNDER_KEY required (gas for the fresh traders)')

const keyOf = (path) => {
  if (fs.existsSync(path)) return fs.readFileSync(path, 'utf8').trim()
  const k = generatePrivateKey()
  fs.writeFileSync(path, k, { mode: 0o600 })
  return k
}
const seller = privateKeyToAccount(keyOf('/tmp/surplus-clob-seller.key'))
const buyer = privateKeyToAccount(keyOf('/tmp/surplus-clob-buyer.key'))
const funder = createWalletClient({ account: privateKeyToAccount(FUNDER_KEY), chain: baseSepolia, transport: http(RPC) })

const settlementAbi = parseAbi([
  'function deposit(uint256 amount)',
  'function depositCollateral(uint256 amount)',
  'function balances(address) view returns (uint256)',
  'function collateral(address) view returns (uint256)',
  'function liability(address) view returns (uint256)',
  'function bookNonce(bytes32 bookId) view returns (uint64)',
  'function lots(bytes32) view returns (address holder, address issuer, bytes32 instrument, uint64 qtyTokens, uint64 lockedTokens, uint64 expiry, uint128 notionalMicro)',
])
const usdAbi = parseAbi([
  'function mint(address to, uint256 amount)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
])

const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) })
const wallet = (account) => createWalletClient({ account, chain: baseSepolia, transport: http(RPC) })
const tx = (hash) => pub.waitForTransactionReceipt({ hash })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Public RPCs are load-balanced; a write can simulate against a node that has
// not yet seen the previous receipt. Retry through the lag.
async function retry(fn, label) {
  for (let i = 0; ; i++) {
    try { return await fn() } catch (e) {
      if (i >= 5) throw e
      console.log(`${label}: retrying after RPC lag (${i + 1}/5)`)
      await sleep(3000)
    }
  }
}

const PRICE = 15_000_000n // micro-tsUSD per 1M tokens, on-tick (tick 1000)
const QTY = 100_000n
const COST = (PRICE * QTY) / 1_000_000n // 1.5 tsUSD
console.log(`seller ${seller.address}  buyer ${buyer.address}  cost ${COST} micro`)

// Gas for the traders' funding txs — Base Sepolia gas is sub-gwei, a few
// microether covers everything.
for (const who of [seller, buyer]) {
  if ((await pub.getBalance({ address: who.address })) < 3_000_000_000_000n) {
    await tx(await funder.sendTransaction({ to: who.address, value: 8_000_000_000_000n }))
  }
}

// Buyer: cash for the buy. Seller: collateral to mint (liability + 500bps).
const bw = wallet(buyer), sw = wallet(seller)
if ((await pub.readContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'balances', args: [buyer.address] })) < COST) {
  await retry(async () => tx(await bw.writeContract({ address: USD, abi: usdAbi, functionName: 'mint', args: [buyer.address, COST] })), 'buyer mint')
  await retry(async () => tx(await bw.writeContract({ address: USD, abi: usdAbi, functionName: 'approve', args: [SETTLEMENT, COST] })), 'buyer approve')
  await retry(async () => tx(await bw.writeContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'deposit', args: [COST] })), 'buyer deposit')
}
// Collateral must cover EXISTING liability (prior unredeemed lots) plus this
// mint, with the 500bps penalty margin — re-runs accumulate liability.
const liability = await pub.readContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'liability', args: [seller.address] })
const required = ((liability + COST) * 110n) / 100n
const have = await pub.readContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'collateral', args: [seller.address] })
if (have < required) {
  const topup = required - have
  await retry(async () => tx(await sw.writeContract({ address: USD, abi: usdAbi, functionName: 'mint', args: [seller.address, topup] })), 'seller mint')
  await retry(async () => tx(await sw.writeContract({ address: USD, abi: usdAbi, functionName: 'approve', args: [SETTLEMENT, topup] })), 'seller approve')
  await retry(async () => tx(await sw.writeContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'depositCollateral', args: [topup] })), 'seller collateral')
}
console.log('funded on Base Sepolia')

const domain = { name: 'SurplusSettlement', version: '1', chainId: baseSepolia.id, verifyingContract: SETTLEMENT }
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
    expiry: Math.floor(Date.now() / 1000) + 1800,
    salt: keccak256(toHex(`${salt}-${Date.now()}`)),
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

const nonce0 = await pub.readContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'bookNonce', args: [BOOK] })
const startBlock = await pub.getBlockNumber()
console.log('sell -> node A:', JSON.stringify(await post(`${NODE_A}/clob/order`, await signedOrder(seller, 1, 'live-sell'))))
console.log('buy  -> node B:', JSON.stringify(await post(`${NODE_B}/clob/order`, await signedOrder(buyer, 0, 'live-buy'))))

let nonce = nonce0
for (let i = 0; i < 90 && nonce === nonce0; i++) {
  await sleep(2000)
  nonce = await pub.readContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'bookNonce', args: [BOOK] })
}
if (nonce === nonce0) {
  for (const n of [NODE_A, NODE_B]) console.error(n, JSON.stringify(await (await fetch(`${n}/clob/status`)).json()))
  throw new Error('batch never settled on Base Sepolia')
}

const [batchLog] = await pub.getLogs({
  address: SETTLEMENT,
  event: parseAbiItem('event BatchSettled(bytes32 indexed bookId, uint64 indexed batchNonce, bytes32 fillsHash, uint256 fillCount, bool proven)'),
  fromBlock: startBlock,
})
const [fillLog] = await pub.getLogs({
  address: SETTLEMENT,
  event: parseAbiItem('event FillSettled(bytes32 indexed buyOrderHash, bytes32 indexed sellOrderHash, bytes32 instrument, uint64 qtyTokens, uint64 execPriceMicroPerM, uint256 costMicro, bytes32 lotId)'),
  fromBlock: startBlock,
})
const lot = await pub.readContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'lots', args: [fillLog.args.lotId] })

// "Attested 2-of-2" must be PROVEN, not asserted: decode the settle tx's
// calldata and recover every quorum signature over the batch digest. Under a
// misconfigured threshold (e.g. 1) the proposer self-submits and batchNonce
// still advances — this is the check that catches it.
const { decodeFunctionData, hashTypedData, recoverAddress } = await import('viem')
const settleAbi = parseAbi([
  'struct Order { bytes32 instrument; uint8 side; uint64 priceMicroPerM; uint64 qtyTokens; bytes32 lotId; address trader; uint64 expiry; bytes32 salt; }',
  'struct BatchFill { Order buy; Order sell; uint64 qtyTokens; uint64 execPriceMicroPerM; }',
  'function settleBatchAttested(bytes32 bookId, BatchFill[] fills, bytes[] sigs)',
])
const settleTx = await pub.getTransaction({ hash: batchLog.transactionHash })
const decoded = decodeFunctionData({ abi: settleAbi, data: settleTx.input })
const sigs = decoded.args[2]
const digest = hashTypedData({
  domain: { name: 'SurplusSettlement', version: '1', chainId: baseSepolia.id, verifyingContract: SETTLEMENT },
  types: { SettlementBatch: [{ name: 'bookId', type: 'bytes32' }, { name: 'batchNonce', type: 'uint64' }, { name: 'fillsHash', type: 'bytes32' }] },
  primaryType: 'SettlementBatch',
  message: { bookId: BOOK, batchNonce: nonce0, fillsHash: batchLog.args.fillsHash },
})
const signers = []
for (const sig of sigs) signers.push((await recoverAddress({ hash: digest, signature: sig })).toLowerCase())
const threshold = await pub.readContract({
  address: SETTLEMENT,
  abi: parseAbi(['function bookThreshold(bytes32 bookId) view returns (uint16)']),
  functionName: 'bookThreshold',
  args: [BOOK],
})
if (threshold < 2) throw new Error(`attesterThreshold is ${threshold} — quorum is not a quorum`)
if (signers.length < 2) throw new Error(`only ${signers.length} quorum signature(s) on the settle tx`)
if (new Set(signers).size !== signers.length) throw new Error(`duplicate quorum signers: ${signers}`)

console.log('')
console.log('=== SHARED-CLOB LIVE ON BASE SEPOLIA ===')
console.log(`batchNonce:  ${nonce0} -> ${nonce}`)
console.log(`fillsHash:   ${batchLog.args.fillsHash} (${batchLog.args.fillCount} fill)`)
console.log(`quorum:      ${signers.length}-of-threshold-${threshold}, distinct co-signers: ${signers.join(', ')}`)
console.log(`tx:          https://sepolia.basescan.org/tx/${batchLog.transactionHash}`)
console.log(`lot:         ${fillLog.args.lotId} — holder ${lot[0]}, issuer ${lot[1]}, ${lot[3]} tokens`)
