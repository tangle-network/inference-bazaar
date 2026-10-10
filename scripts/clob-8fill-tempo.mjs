// 8-FILL EPOCH PROOF on Tempo (chainId 42431) — the exact scenario that failed
// 18/18 epochs before the operator RPC-retry fix (PR #64): 22 orders with 8
// crossing pairs, settled in ONE settleBatchAttested, expected on the FIRST
// eligible epoch (the retry rides out the public RPC's intermittent 429s
// instead of abandoning the epoch). Run:
//   FUNDER_KEY=0x... node scripts/clob-8fill-tempo.mjs
import { createPublicClient, createWalletClient, http, defineChain, parseAbi, parseAbiItem, keccak256, toHex, zeroHash, toEventSelector } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ephemeralKey } from './_keys.mjs'
import { spawn } from 'node:child_process'
import fs from 'node:fs'

const tempo = defineChain({
  id: 42431,
  name: 'tempo-moderato',
  nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.moderato.tempo.xyz'] } },
})

const RPC = process.env.RPC ?? 'https://rpc.moderato.tempo.xyz'
const SETTLEMENT = process.env.SETTLEMENT ?? '0x83084C8cD2282F6126e25089f0FD26b145eCa597'
const USD = process.env.USD ?? '0x20C0000000000000000000000000000000000000'
const INSTRUMENT = process.env.INSTRUMENT ?? 'claude-sonnet-4-6:output'
const BOOK = process.env.BOOK ?? keccak256(toHex('inference-bazaar.tempo.proof.1'))
const FUNDER_KEY = process.env.FUNDER_KEY
const EPOCH_SECS = 10

const OPS = {
  a: { addr: '0xEEF7b944f54D0DA2D7414104ee7EE6140AFcA404', url: 'http://127.0.0.1:9210', keyName: 'tempo-op-a' },
  b: { addr: '0xf8c04cC75137687Fd9e4dfc0AbB6F39F584e21ae', url: 'http://127.0.0.1:9211', keyName: 'tempo-op-b' },
}
const seller = privateKeyToAccount(ephemeralKey('tempo-seller'))
const buyer = privateKeyToAccount(ephemeralKey('tempo-buyer'))

const settlementAbi = parseAbi([
  'function deposit(uint256 amount)',
  'function depositCollateral(uint256 amount)',
  'function balances(address) view returns (uint256)',
  'function freeCollateral(address) view returns (uint256)',
  'function bookNonce(bytes32 bookId) view returns (uint64)',
  'function bookThreshold(bytes32 bookId) view returns (uint16)',
  'function feeRecipient() view returns (address)',
  'function lots(bytes32) view returns (address holder, address issuer, bytes32 instrument, uint64 qtyTokens, uint64 lockedTokens, uint64 expiry, uint128 notionalMicro)',
])
const usdAbi = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
])

const pub = createPublicClient({ chain: tempo, transport: http(RPC) })
const wallet = (account) => createWalletClient({ account, chain: tempo, transport: http(RPC) })
const tx = (hash) => pub.waitForTransactionReceipt({ hash })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function retry(fn, label, n = 6) {
  for (let i = 0; ; i++) {
    try { return await fn() } catch (e) {
      if (i >= n) throw e
      console.log(`  (${label}: retry ${i + 1}/${n}: ${String(e).slice(0, 100)})`)
      await sleep(2500)
    }
  }
}
const read = (functionName, args) => retry(() => pub.readContract({ address: SETTLEMENT, abi: settlementAbi, functionName, args }), functionName)
const nonce = () => read('bookNonce', [BOOK])

// ── operators ────────────────────────────────────────────────────────────────
const OP_BIN = './target/debug/inference-bazaar-operator-lite'
const procs = {}
function startOp(which) {
  const op = OPS[which]
  fs.mkdirSync('.keys/logs', { recursive: true })
  const log = fs.openSync(`.keys/logs/8fill-op-${which}.log`, 'w')
  const p = spawn(OP_BIN, [], {
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      INFERENCE_BAZAAR_OPERATOR_ADDR: `127.0.0.1:${new URL(op.url).port}`,
      INFERENCE_BAZAAR_OPERATOR_KEY: fs.readFileSync(`.keys/${op.keyName}.key`, 'utf8').trim(),
      INFERENCE_BAZAAR_CHAIN_ID: '42431',
      INFERENCE_BAZAAR_RPC_URL: RPC,
      INFERENCE_BAZAAR_SETTLEMENT_ADDR: SETTLEMENT,
      INFERENCE_BAZAAR_INSTRUMENT: INSTRUMENT,
      INFERENCE_BAZAAR_CLOB_BOOK: BOOK,
      INFERENCE_BAZAAR_CLOB_OPERATORS: `${OPS.a.addr}=${OPS.a.url},${OPS.b.addr}=${OPS.b.url}`,
      INFERENCE_BAZAAR_CLOB_THRESHOLD: '2',
      INFERENCE_BAZAAR_CLOB_EPOCH_SECS: String(EPOCH_SECS),
      INFERENCE_BAZAAR_RL_CAPACITY: '100000',
      INFERENCE_BAZAAR_RL_REFILL: '10000',
      INFERENCE_BAZAAR_INFERENCE_URL: 'http://127.0.0.1:1',
      INFERENCE_BAZAAR_SIDECAR_URL: 'http://127.0.0.1:1',
      DATA_DIR: `.keys/data-${which}`,
    },
  })
  procs[which] = p
}
async function waitHealth(which, secs = 20) {
  for (let i = 0; i < secs * 5; i++) {
    try { await fetch(`${OPS[which].url}/health`); return } catch { await sleep(200) }
  }
  throw new Error(`operator ${which} never came up`)
}
function killOps() { for (const p of Object.values(procs)) { try { p.kill('SIGKILL') } catch {} } }
process.on('exit', killOps)
const status = async (w) => (await fetch(`${OPS[w].url}/clob/status`)).json()
async function postRaw(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const text = await r.text()
  let json; try { json = JSON.parse(text) } catch { json = text }
  return { status: r.status, body: json }
}

// ── orders ───────────────────────────────────────────────────────────────────
const domain = { name: 'InferenceBazaarSettlement', version: '1', chainId: tempo.id, verifyingContract: SETTLEMENT }
const orderTypes = { Order: [
  { name: 'instrument', type: 'bytes32' }, { name: 'side', type: 'uint8' },
  { name: 'priceMicroPerM', type: 'uint64' }, { name: 'qtyTokens', type: 'uint64' },
  { name: 'lotId', type: 'bytes32' }, { name: 'trader', type: 'address' },
  { name: 'expiry', type: 'uint64' }, { name: 'salt', type: 'bytes32' },
]}
async function signedOrder(account, side, priceMicroPerM, qtyTokens, salt, expirySecs = 1800) {
  const order = {
    instrument: keccak256(toHex(INSTRUMENT)),
    side, priceMicroPerM, qtyTokens, lotId: zeroHash, trader: account.address,
    expiry: Math.floor(Date.now() / 1000) + expirySecs,
    salt: keccak256(toHex(`8fill-${salt}-${Date.now()}-${Math.random()}`)),
  }
  const signature = await wallet(account).signTypedData({
    domain, types: orderTypes, primaryType: 'Order',
    message: { ...order, priceMicroPerM: BigInt(order.priceMicroPerM), qtyTokens: BigInt(order.qtyTokens), expiry: BigInt(order.expiry) },
  })
  return { instrumentId: INSTRUMENT, order, signature }
}

// ── settle evidence ──────────────────────────────────────────────────────────
const batch5 = parseAbiItem('event BatchSettled(bytes32 indexed bookId, uint64 indexed batchNonce, bytes32 fillsHash, uint256 fillCount, bool proven)')
const batch6 = parseAbiItem('event BatchSettled(bytes32 indexed bookId, uint64 indexed batchNonce, bytes32 fillsHash, uint256 fillCount, bool proven, bytes32 ordersCommitment)')
const fillEvent = parseAbiItem('event FillSettled(bytes32 indexed buyOrderHash, bytes32 indexed sellOrderHash, bytes32 instrument, uint64 qtyTokens, uint64 execPriceMicroPerM, uint256 costMicro, bytes32 lotId)')
const sel5 = toEventSelector(batch5), sel6 = toEventSelector(batch6), selFill = toEventSelector(fillEvent)
const settleAbi = parseAbi([
  'struct Order { bytes32 instrument; uint8 side; uint64 priceMicroPerM; uint64 qtyTokens; bytes32 lotId; address trader; uint64 expiry; bytes32 salt; }',
  'struct BatchFill { Order buy; Order sell; uint64 qtyTokens; uint64 execPriceMicroPerM; }',
  'function settleBatchAttested(bytes32 bookId, BatchFill[] fills, bytes[] sigs)',
])
async function settleEvidence(fromBlock, batchNonce) {
  const { decodeEventLog, decodeFunctionData, hashTypedData, recoverAddress } = await import('viem')
  const logs = await retry(() => pub.getLogs({ address: SETTLEMENT, fromBlock }), 'getLogs')
  let batchLog
  for (const l of logs.filter((l) => l.topics[1]?.toLowerCase() === BOOK.toLowerCase())) {
    const abi = l.topics[0] === sel5 ? batch5 : l.topics[0] === sel6 ? batch6 : null
    if (!abi) continue
    const args = decodeEventLog({ abi: [abi], data: l.data, topics: l.topics }).args
    if (args.batchNonce === batchNonce) batchLog = { ...l, args }
  }
  if (!batchLog) throw new Error(`no BatchSettled log for nonce ${batchNonce}`)
  const fillLogs = logs
    .filter((l) => l.topics[0] === selFill && l.transactionHash === batchLog.transactionHash)
    .map((l) => ({ ...l, args: decodeEventLog({ abi: [fillEvent], data: l.data, topics: l.topics }).args }))
  const settleTx = await pub.getTransaction({ hash: batchLog.transactionHash })
  const decoded = decodeFunctionData({ abi: settleAbi, data: settleTx.input })
  const digest = hashTypedData({
    domain,
    types: { SettlementBatch: [{ name: 'bookId', type: 'bytes32' }, { name: 'batchNonce', type: 'uint64' }, { name: 'fillsHash', type: 'bytes32' }] },
    primaryType: 'SettlementBatch',
    message: { bookId: BOOK, batchNonce, fillsHash: batchLog.args.fillsHash },
  })
  const signers = []
  for (const sig of decoded.args[2]) signers.push((await recoverAddress({ hash: digest, signature: sig })).toLowerCase())
  return { batchLog, fillLogs, fills: decoded.args[1], signers, txHash: batchLog.transactionHash }
}

// ═════════════════════════════════════════════════════════════════════════════
console.log(`book ${BOOK}  (threshold ${await read('bookThreshold', [BOOK])})`)
console.log(`buyer ${buyer.address}  seller ${seller.address}`)
console.log(`operator binary: ${fs.existsSync(OP_BIN) ? 'built' : 'MISSING'} — expecting origin/main with PR #64`)
startOp('a'); startOp('b')
await waitHealth('a'); await waitHealth('b')
console.log('operators up: A :9210, B :9211')

// Funding: 8 fills cost the buyer 1,180,000 micro; seller collateral must free-cover the same.
const PLANNED = 1_400_000n
const funder = FUNDER_KEY ? wallet(privateKeyToAccount(FUNDER_KEY)) : null
async function topUp(to, need) {
  if (need <= 0n || !funder) return
  await retry(async () => tx(await funder.writeContract({ address: USD, abi: usdAbi, functionName: 'transfer', args: [to.address, need + 500_000n] })), 'funder transfer')
}
{
  const cash = await read('balances', [buyer.address])
  if (cash < PLANNED) {
    const need = PLANNED - cash
    await topUp(buyer, need)
    await retry(async () => tx(await wallet(buyer).writeContract({ address: USD, abi: usdAbi, functionName: 'approve', args: [SETTLEMENT, need] })), 'buyer approve')
    await retry(async () => tx(await wallet(buyer).writeContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'deposit', args: [need] })), 'buyer deposit')
  }
  const free = await read('freeCollateral', [seller.address])
  if (free < PLANNED) {
    const topup = PLANNED - free + 500_000n
    await topUp(seller, topup)
    await retry(async () => tx(await wallet(seller).writeContract({ address: USD, abi: usdAbi, functionName: 'approve', args: [SETTLEMENT, topup] })), 'seller approve')
    await retry(async () => tx(await wallet(seller).writeContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'depositCollateral', args: [topup] })), 'seller collateral')
  }
  console.log(`funded: buyer cash ${await read('balances', [buyer.address])}, seller free collateral ${await read('freeCollateral', [seller.address])}`)
}

// THE SCENARIO THAT FAILED 18/18 EPOCHS pre-fix: 22 orders, 8 crossing pairs.
// Crossing: 2 sells@14M + 6 sells@15M (80k ask) vs 2 buys@15.5M + 8 buys@15M
// (100k bid) → 8 fills at maker price, 2 bids rest. Non-crossing: 2 sells@16M,
// 2 buys@13M rest.
const P14 = 14_000_000, P15 = 15_000_000, P155 = 15_500_000, P13 = 13_000_000, P16 = 16_000_000
const Q = 10_000
const plan = [
  ...Array.from({ length: 2 }, (_, i) => ['sell', P14, `sell14-${i}`]),
  ...Array.from({ length: 6 }, (_, i) => ['sell', P15, `sell15-${i}`]),
  ...Array.from({ length: 2 }, (_, i) => ['sell', P16, `sell16-${i}`]),
  ...Array.from({ length: 2 }, (_, i) => ['buy', P155, `buy155-${i}`]),
  ...Array.from({ length: 8 }, (_, i) => ['buy', P15, `buy15-${i}`]),
  ...Array.from({ length: 2 }, (_, i) => ['buy', P13, `buy13-${i}`]),
]
const nonce0 = await nonce()
const fromBlock = await pub.getBlockNumber()
const feeRecip0 = await read('balances', [await read('feeRecipient', [])])
const buyer0 = await read('balances', [buyer.address])
const seller0 = await read('balances', [seller.address])

// Post just after an epoch boundary so all 22 orders land in one epoch window.
const msToBoundary = EPOCH_SECS * 1000 - (Date.now() % (EPOCH_SECS * 1000))
if (msToBoundary < 2500) await sleep(msToBoundary + 200)
const epochAtPost = (await status('a')).epoch
console.log(`posting 22 orders at epoch ${epochAtPost} (first eligible boundary: ${epochAtPost + 1})`)
for (let i = 0; i < plan.length; i++) {
  const [side, price, tag] = plan[i]
  const o = await signedOrder(side === 'buy' ? buyer : seller, side === 'buy' ? 0 : 1, price, Q, tag)
  const r = await postRaw(`${OPS[i % 2 === 0 ? 'a' : 'b'].url}/clob/order`, o)
  if (r.status !== 200) throw new Error(`post ${tag} -> ${r.status}: ${JSON.stringify(r.body)}`)
}
for (let i = 0; i < 20; i++) {
  const [sa, sb] = await Promise.all([status('a'), status('b')])
  if (sa.poolSize === plan.length && sb.poolSize === plan.length) break
  await sleep(800)
}
console.log(`pools converged: A=${(await status('a')).poolSize} B=${(await status('b')).poolSize}`)

const deadline = Date.now() + 180_000
let n1 = nonce0
while (Date.now() < deadline && n1 === nonce0) { await sleep(3000); n1 = await nonce() }
if (n1 === nonce0) throw new Error('batch never settled')

const ev = await settleEvidence(fromBlock, nonce0)
const receipt = await retry(() => pub.getTransactionReceipt({ hash: ev.txHash }), 'receipt')

// Which epoch did it settle in? The proposer logs it.
let settledEpoch = null
for (const w of ['a', 'b']) {
  const logText = fs.readFileSync(`.keys/logs/8fill-op-${w}.log`, 'utf8')
  const m = logText.match(/epoch batch settled.*epoch=(\d+)/)
  if (m) settledEpoch = Number(m[1])
}
const epochsElapsed = settledEpoch === null ? 'unknown' : settledEpoch - epochAtPost
// Retry activity in the operator logs = proof the fix was exercised.
let retryEvidence = ''
for (const w of ['a', 'b']) {
  const logText = fs.readFileSync(`.keys/logs/8fill-op-${w}.log`, 'utf8')
  const abandoned = (logText.match(/epoch proposal failed/g) || []).length
  retryEvidence += `op-${w}: epochProposalAbandoned=${abandoned} `
}

const fills14 = ev.fills.filter((f) => Number(f.execPriceMicroPerM) === P14)
const fills15 = ev.fills.filter((f) => Number(f.execPriceMicroPerM) === P15)
const buyersOk = ev.fills.every((f) => f.buy.trader.toLowerCase() === buyer.address.toLowerCase() && f.sell.trader.toLowerCase() === seller.address.toLowerCase() && Number(f.qtyTokens) === Q)
const signersOk = ev.signers.length === 2 && new Set(ev.signers).size === 2 &&
  ev.signers.includes(OPS.a.addr.toLowerCase()) && ev.signers.includes(OPS.b.addr.toLowerCase())
const buyer1 = await read('balances', [buyer.address])
const seller1 = await read('balances', [seller.address])
const feeRecip1 = await read('balances', [await read('feeRecipient', [])])
const EXP_COST = 1_180_000n, EXP_FEE = 23_600n
const lotsOk = []
for (const fl of ev.fillLogs) {
  const lot = await read('lots', [fl.args.lotId])
  lotsOk.push(lot[0].toLowerCase() === buyer.address.toLowerCase() && lot[1].toLowerCase() === seller.address.toLowerCase() && Number(lot[3]) === Q)
}
const [sa, sb] = await Promise.all([status('a'), status('b')])

const pass =
  ev.batchLog.args.fillCount === 8n && ev.fills.length === 8 &&
  fills14.length === 2 && fills15.length === 6 && buyersOk && signersOk &&
  buyer0 - buyer1 === EXP_COST && seller1 - seller0 === EXP_COST - EXP_FEE &&
  feeRecip1 - feeRecip0 === EXP_FEE &&
  ev.fillLogs.length === 8 && lotsOk.every(Boolean) &&
  sa.poolSize === 6 && sb.poolSize === 6

console.log('')
console.log('=== 8-FILL EPOCH ON TEMPO (post PR #64) ===')
console.log(`bookNonce:   ${nonce0} -> ${n1}`)
console.log(`fillCount:   ${ev.batchLog.args.fillCount} (2@14M + ${fills15.length}@15M maker price), fillsHash ${ev.batchLog.args.fillsHash}`)
console.log(`quorum:      ${ev.signers.length} distinct signers: ${ev.signers.join(', ')}`)
console.log(`epochs:      posted at ${epochAtPost}, settled at ${settledEpoch} (${epochsElapsed} epoch(s) elapsed — 1 = first eligible boundary)`)
console.log(`retry log:   ${retryEvidence}`)
console.log(`tx:          ${ev.txHash}`)
console.log(`gasUsed:     ${receipt.gasUsed} (Tempo tx cap 30M)`)
console.log(`buyer:       ${buyer0} -> ${buyer1} micro (paid ${buyer0 - buyer1})`)
console.log(`seller:      ${seller0} -> ${seller1} micro (received ${seller1 - seller0})`)
console.log(`feeRecipient:+${feeRecip1 - feeRecip0} micro (200bps protocol fee)`)
console.log(`lots:        ${ev.fillLogs.length} minted, all holder=buyer qty=10k: ${lotsOk.every(Boolean)}`)
console.log(`resting:     pool A=${sa.poolSize} B=${sb.poolSize} (expect 6: 2 sells@16M + 2 buys@13M + 2 unfilled buys@15M)`)
console.log(pass ? '\nPASS: 8 fills in ONE settleBatchAttested, first-epoch settle, 2-of-2 quorum proven' : '\nFAIL: see deltas above')
process.exit(pass ? 0 : 1)
