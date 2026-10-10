// LIVE shared-CLOB proof on Tempo testnet (chainId 42431): a fresh buyer and
// seller enter a crossing pair at DIFFERENT loopback lite operators; the
// elected proposer matches the epoch, the peer co-signs, and the 2-of-2
// attested batch settles on the real pathUSD rail. Ported from
// clob-e2e-live.mjs (Base Sepolia) — differences: inline Tempo chain def,
// pathUSD has no public mint so funding is a deployer `transfer`, gas is paid
// in pathUSD by the sender, and BatchSettled may carry an extra
// `ordersCommitment` field (decoded defensively by topic0).
// Run: FUNDER_KEY=0x... node scripts/clob-e2e-tempo.mjs
import { createPublicClient, createWalletClient, http, defineChain, parseAbi, parseAbiItem, keccak256, toHex, zeroHash, toEventSelector } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ephemeralKey } from './_keys.mjs'

const tempo = defineChain({
  id: 42431,
  name: 'tempo-moderato',
  nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.moderato.tempo.xyz'] } },
})

const RPC = process.env.RPC ?? 'https://rpc.moderato.tempo.xyz'
const SETTLEMENT = process.env.SETTLEMENT ?? '0x83084C8cD2282F6126e25089f0FD26b145eCa597'
const USD = process.env.USD ?? '0x20C0000000000000000000000000000000000000'
const NODE_A = process.env.NODE_A ?? 'http://127.0.0.1:9210'
const NODE_B = process.env.NODE_B ?? 'http://127.0.0.1:9211'
const INSTRUMENT = process.env.INSTRUMENT ?? 'claude-sonnet-4-6:output'
const BOOK = process.env.BOOK ?? keccak256(toHex('inference-bazaar.tempo.proof.1'))
const FUNDER_KEY = process.env.FUNDER_KEY // optional: top up pathUSD if a trader is short

const seller = privateKeyToAccount(ephemeralKey('tempo-seller'))
const buyer = privateKeyToAccount(ephemeralKey('tempo-buyer'))

const settlementAbi = parseAbi([
  'function deposit(uint256 amount)',
  'function depositCollateral(uint256 amount)',
  'function balances(address) view returns (uint256)',
  'function collateral(address) view returns (uint256)',
  'function liability(address) view returns (uint256)',
  'function bookNonce(bytes32 bookId) view returns (uint64)',
  'function bookThreshold(bytes32 bookId) view returns (uint16)',
  'function lots(bytes32) view returns (address holder, address issuer, bytes32 instrument, uint64 qtyTokens, uint64 lockedTokens, uint64 expiry, uint128 notionalMicro)',
])
const usdAbi = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
])

const pub = createPublicClient({ chain: tempo, transport: http(RPC) })
const wallet = (account) => createWalletClient({ account, chain: tempo, transport: http(RPC) })
const tx = (hash) => pub.waitForTransactionReceipt({ hash })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function retry(fn, label) {
  for (let i = 0; ; i++) {
    try { return await fn() } catch (e) {
      if (i >= 5) throw e
      console.log(`${label}: retrying (${i + 1}/5): ${String(e).slice(0, 160)}`)
      await sleep(3000)
    }
  }
}

const PRICE = 15_000_000n // micro-pathUSD per 1M tokens, on-tick (tick 1000)
const QTY = 100_000n
const COST = (PRICE * QTY) / 1_000_000n // 1.5 pathUSD
console.log(`book ${BOOK}`)
console.log(`seller ${seller.address}  buyer ${buyer.address}  cost ${COST} micro`)

const threshold = await pub.readContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'bookThreshold', args: [BOOK] })
if (threshold < 2) throw new Error(`book threshold is ${threshold} — registerBook (2-of-2) first`)

// No public mint on pathUSD: any shortfall is topped up by the deployer's
// `transfer`. Gas on Tempo is also paid in pathUSD, so the top-up includes a
// gas buffer for the trader's own approve/deposit txs.
const funder = FUNDER_KEY ? wallet(privateKeyToAccount(FUNDER_KEY)) : null
async function topUp(to, need) {
  if (need <= 0n) return
  if (!funder) throw new Error(`trader ${to.address} short ${need} micro pathUSD and FUNDER_KEY unset`)
  const withGas = need + 500_000n
  console.log(`top up ${to.address}: ${withGas} micro via deployer transfer`)
  await retry(async () => tx(await funder.writeContract({ address: USD, abi: usdAbi, functionName: 'transfer', args: [to.address, withGas] })), 'funder transfer')
}

const bw = wallet(buyer), sw = wallet(seller)
const buyerCash = await pub.readContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'balances', args: [buyer.address] })
if (buyerCash < COST) {
  const need = COST - buyerCash
  await topUp(buyer, need)
  await retry(async () => tx(await bw.writeContract({ address: USD, abi: usdAbi, functionName: 'approve', args: [SETTLEMENT, need] })), 'buyer approve')
  await retry(async () => tx(await bw.writeContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'deposit', args: [need] })), 'buyer deposit')
}
// Collateral must cover EXISTING liability (prior unredeemed lots) plus this
// mint, with the penalty margin — re-runs accumulate liability.
const liability = await pub.readContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'liability', args: [seller.address] })
const required = ((liability + COST) * 110n) / 100n
const have = await pub.readContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'collateral', args: [seller.address] })
if (have < required) {
  const topup = required - have
  await topUp(seller, topup)
  await retry(async () => tx(await sw.writeContract({ address: USD, abi: usdAbi, functionName: 'approve', args: [SETTLEMENT, topup] })), 'seller approve')
  await retry(async () => tx(await sw.writeContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'depositCollateral', args: [topup] })), 'seller collateral')
}
const buyerBefore = await pub.readContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'balances', args: [buyer.address] })
const sellerBefore = await pub.readContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'balances', args: [seller.address] })
console.log(`funded on Tempo: buyer balance ${buyerBefore}, seller balance ${sellerBefore}`)

const domain = { name: 'InferenceBazaarSettlement', version: '1', chainId: tempo.id, verifyingContract: SETTLEMENT }
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
console.log('sell -> node A:', JSON.stringify(await post(`${NODE_A}/clob/order`, await signedOrder(seller, 1, 'tempo-sell'))))
console.log('buy  -> node B:', JSON.stringify(await post(`${NODE_B}/clob/order`, await signedOrder(buyer, 0, 'tempo-buy'))))

let nonce = nonce0
for (let i = 0; i < 90 && nonce === nonce0; i++) {
  await sleep(2000)
  nonce = await pub.readContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'bookNonce', args: [BOOK] })
}
if (nonce === nonce0) {
  for (const n of [NODE_A, NODE_B]) console.error(n, JSON.stringify(await (await fetch(`${n}/clob/status`)).json()))
  throw new Error('batch never settled on Tempo')
}

// BatchSettled may be the 5-field (Base-era) or 6-field (ordersCommitment)
// variant depending on which build is deployed — match on topic0, not a
// hardcoded ABI. The Tempo RPC ignores topics filters, so filter client-side.
const batch5 = parseAbiItem('event BatchSettled(bytes32 indexed bookId, uint64 indexed batchNonce, bytes32 fillsHash, uint256 fillCount, bool proven)')
const batch6 = parseAbiItem('event BatchSettled(bytes32 indexed bookId, uint64 indexed batchNonce, bytes32 fillsHash, uint256 fillCount, bool proven, bytes32 ordersCommitment)')
const fillEvent = parseAbiItem('event FillSettled(bytes32 indexed buyOrderHash, bytes32 indexed sellOrderHash, bytes32 instrument, uint64 qtyTokens, uint64 execPriceMicroPerM, uint256 costMicro, bytes32 lotId)')
const logs = await pub.getLogs({ address: SETTLEMENT, fromBlock: startBlock })
const sel5 = toEventSelector(batch5), sel6 = toEventSelector(batch6), selFill = toEventSelector(fillEvent)
const { decodeEventLog } = await import('viem')
const bookLogs = logs.filter((l) => l.topics[1]?.toLowerCase() === BOOK.toLowerCase())
let batchLog
for (const l of bookLogs) {
  const t0 = l.topics[0]
  const abi = t0 === sel5 ? batch5 : t0 === sel6 ? batch6 : null
  if (!abi) continue
  batchLog = { ...l, args: decodeEventLog({ abi: [abi], data: l.data, topics: l.topics }).args }
}
if (!batchLog) throw new Error('no BatchSettled log for this book since startBlock')
console.log(`BatchSettled variant: ${batchLog.topics[0] === sel6 ? '6-field (ordersCommitment)' : '5-field'}`)
const fillLog = logs
  .filter((l) => l.topics[0] === selFill && l.transactionHash === batchLog.transactionHash)
  .map((l) => ({ ...l, args: decodeEventLog({ abi: [fillEvent], data: l.data, topics: l.topics }).args }))[0]
if (!fillLog) throw new Error('no FillSettled log in the settle tx')
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
if (decoded.args[0].toLowerCase() !== BOOK.toLowerCase()) throw new Error('settle tx targets a different book')
const sigs = decoded.args[2]
const digest = hashTypedData({
  domain,
  types: { SettlementBatch: [{ name: 'bookId', type: 'bytes32' }, { name: 'batchNonce', type: 'uint64' }, { name: 'fillsHash', type: 'bytes32' }] },
  primaryType: 'SettlementBatch',
  message: { bookId: BOOK, batchNonce: nonce0, fillsHash: batchLog.args.fillsHash },
})
const signers = []
for (const sig of sigs) signers.push((await recoverAddress({ hash: digest, signature: sig })).toLowerCase())
if (sigs.length < 2) throw new Error(`only ${sigs.length} quorum signature(s) on the settle tx`)
if (new Set(signers).size !== signers.length) throw new Error(`duplicate quorum signers: ${signers}`)

const buyerAfter = await pub.readContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'balances', args: [buyer.address] })
const sellerAfter = await pub.readContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'balances', args: [seller.address] })

console.log('')
console.log('=== SHARED-CLOB LIVE ON TEMPO (42431) ===')
console.log(`batchNonce:  ${nonce0} -> ${nonce}`)
console.log(`fillsHash:   ${batchLog.args.fillsHash} (${batchLog.args.fillCount} fill)`)
console.log(`quorum:      ${signers.length}-of-threshold-${threshold}, distinct co-signers: ${signers.join(', ')}`)
console.log(`tx:          ${batchLog.transactionHash}`)
console.log(`buyer:       ${buyerBefore} -> ${buyerAfter} micro (paid ${buyerBefore - buyerAfter})`)
console.log(`seller:      ${sellerBefore} -> ${sellerAfter} micro (received ${sellerAfter - sellerBefore})`)
console.log(`lot:         ${fillLog.args.lotId} — holder ${lot[0]}, issuer ${lot[1]}, ${lot[3]} tokens`)
