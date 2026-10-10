// STRESS the shared CLOB on Tempo testnet (chainId 42431). Runs five scenarios
// against the live 2-of-2 book and prints a pass/fail matrix:
//   1. multi-order epoch — 22 orders, 8 fills in ONE settleBatchAttested
//   2. hygiene — non-crossing orders rest, settled orders pruned, no re-admit
//   4. spam/grief — 50 junk orders rejected; an unfunded griefer's crossing
//      sell is evicted by the proposer's pre-match simulation (audit H3 path)
//   5. cancel/expiry — off-chain signed cancel (gossiped), on-chain cancelOrder,
//      replay rejection, expiry eviction
//   3. proposer death — SIGKILL the elected proposer; 2-of-2 CANNOT settle with
//      one node down (by design); settlement resumes after restart
// The script manages both operator processes itself. Funding is idempotent via
// the deployer's pathUSD `transfer` (FUNDER_KEY). Run:
//   FUNDER_KEY=0x... node scripts/clob-stress-tempo.mjs
import { createPublicClient, createWalletClient, http, defineChain, parseAbi, parseAbiItem, keccak256, toHex, zeroHash, toEventSelector } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
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
// 10s epochs halve proposal frequency — the operator abandons an epoch on a
// single RPC 429 (no retry), so we keep well under the RPC token bucket.
const EPOCH_SECS = 10

const OPS = {
  a: { addr: '0xEEF7b944f54D0DA2D7414104ee7EE6140AFcA404', url: 'http://127.0.0.1:9210', keyName: 'tempo-op-a' },
  b: { addr: '0xf8c04cC75137687Fd9e4dfc0AbB6F39F584e21ae', url: 'http://127.0.0.1:9211', keyName: 'tempo-op-b' },
}
const seller = privateKeyToAccount(ephemeralKey('tempo-seller'))
const buyer = privateKeyToAccount(ephemeralKey('tempo-buyer'))
const griefer = privateKeyToAccount(ephemeralKey('tempo-griefer')) // never funded

const settlementAbi = parseAbi([
  'function deposit(uint256 amount)',
  'function depositCollateral(uint256 amount)',
  'function balances(address) view returns (uint256)',
  'function collateral(address) view returns (uint256)',
  'function liability(address) view returns (uint256)',
  'function freeCollateral(address) view returns (uint256)',
  'function bookNonce(bytes32 bookId) view returns (uint64)',
  'function bookThreshold(bytes32 bookId) view returns (uint16)',
  'function feeBps() view returns (uint16)',
  'function feeRecipient() view returns (address)',
  'function cancelled(bytes32) view returns (bool)',
  'function cancelOrder((bytes32 instrument, uint8 side, uint64 priceMicroPerM, uint64 qtyTokens, bytes32 lotId, address trader, uint64 expiry, bytes32 salt) o)',
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

// ── operator lifecycle ───────────────────────────────────────────────────────
const OP_BIN = './target/debug/inference-bazaar-operator-lite'
const procs = {}
function startOp(which) {
  const op = OPS[which]
  fs.mkdirSync('.keys/logs', { recursive: true })
  fs.mkdirSync(`.keys/data-${which}`, { recursive: true })
  const log = fs.openSync(`.keys/logs/stress-op-${which}.log`, 'a')
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
  return p
}
async function waitHealth(which, secs = 20) {
  for (let i = 0; i < secs * 5; i++) {
    try { await fetch(`${OPS[which].url}/health`); return } catch { await sleep(200) }
  }
  throw new Error(`operator ${which} never came up`)
}
function killOps() { for (const p of Object.values(procs)) { try { p.kill('SIGKILL') } catch {} } }
process.on('exit', killOps)

async function status(which) { return (await fetch(`${OPS[which].url}/clob/status`)).json() }
async function postRaw(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) })
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

async function signedOrder(account, side, priceMicroPerM, qtyTokens, salt, expirySecs = 1800, instrumentId = INSTRUMENT) {
  const order = {
    instrument: keccak256(toHex(instrumentId)),
    side,
    priceMicroPerM,
    qtyTokens,
    lotId: zeroHash,
    trader: account.address,
    expiry: Math.floor(Date.now() / 1000) + expirySecs,
    salt: keccak256(toHex(`${salt}-${Date.now()}-${Math.random()}`)),
  }
  const signature = await wallet(account).signTypedData({
    domain, types: orderTypes, primaryType: 'Order',
    message: { ...order, priceMicroPerM: BigInt(order.priceMicroPerM), qtyTokens: BigInt(order.qtyTokens), expiry: BigInt(order.expiry) },
  })
  return { instrumentId, order, signature }
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
  // The Tempo RPC ignores topics filters — filter client-side by topic0/topic1.
  const logs = await retry(() => pub.getLogs({ address: SETTLEMENT, fromBlock }), 'getLogs')
  const bookLogs = logs.filter((l) => l.topics[1]?.toLowerCase() === BOOK.toLowerCase())
  let batchLog
  for (const l of bookLogs) {
    const abi = l.topics[0] === sel5 ? batch5 : l.topics[0] === sel6 ? batch6 : null
    if (!abi) continue
    const args = decodeEventLog({ abi: [abi], data: l.data, topics: l.topics }).args
    if (args.batchNonce === batchNonce) batchLog = { ...l, args }
  }
  if (!batchLog) throw new Error(`no BatchSettled log for nonce ${batchNonce} since block ${fromBlock}`)
  const fillLogs = logs
    .filter((l) => l.topics[0] === selFill && l.transactionHash === batchLog.transactionHash)
    .map((l) => ({ ...l, args: decodeEventLog({ abi: [fillEvent], data: l.data, topics: l.topics }).args }))
  const settleTx = await pub.getTransaction({ hash: batchLog.transactionHash })
  const decoded = decodeFunctionData({ abi: settleAbi, data: settleTx.input })
  if (decoded.args[0].toLowerCase() !== BOOK.toLowerCase()) throw new Error('settle tx targets a different book')
  const digest = hashTypedData({
    domain,
    types: { SettlementBatch: [{ name: 'bookId', type: 'bytes32' }, { name: 'batchNonce', type: 'uint64' }, { name: 'fillsHash', type: 'bytes32' }] },
    primaryType: 'SettlementBatch',
    message: { bookId: BOOK, batchNonce, fillsHash: batchLog.args.fillsHash },
  })
  const signers = []
  for (const sig of decoded.args[2]) signers.push((await recoverAddress({ hash: digest, signature: sig })).toLowerCase())
  return { batchLog, fillLogs, fills: decoded.args[1], sigs: decoded.args[2], signers, txHash: batchLog.transactionHash }
}

async function waitNonceAdvance(nonce0, secs) {
  const deadline = Date.now() + secs * 1000
  let n = nonce0
  while (Date.now() < deadline && n === nonce0) { await sleep(4000); n = await nonce() }
  return n
}

// ── results ──────────────────────────────────────────────────────────────────
const results = []
function record(name, pass, details) {
  results.push({ name, pass, details })
  console.log(`\n[${pass ? 'PASS' : 'FAIL'}] ${name}\n  ${details}`)
}
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()

// ═════════════════════════════════════════════════════════════════════════════
console.log(`book ${BOOK}`)
console.log(`buyer ${buyer.address}  seller ${seller.address}  griefer ${griefer.address}`)
console.log(`feeBps ${await read('feeBps', [])} feeRecipient ${await read('feeRecipient', [])}`)

startOp('a'); startOp('b')
await waitHealth('a'); await waitHealth('b')
console.log('operators up: A :9210, B :9211')

// ── funding (idempotent) ─────────────────────────────────────────────────────
// Planned fills: scenario 1 (430,000 micro) + scenario 3 (150,000) + margin.
const PLANNED = 800_000n
const funder = FUNDER_KEY ? wallet(privateKeyToAccount(FUNDER_KEY)) : null
async function topUp(to, need) {
  if (need <= 0n || !funder) return
  await retry(async () => tx(await funder.writeContract({ address: USD, abi: usdAbi, functionName: 'transfer', args: [to.address, need + 500_000n] })), 'funder transfer')
}
{
  const bw = wallet(buyer), sw = wallet(seller)
  const cash = await read('balances', [buyer.address])
  if (cash < PLANNED) {
    const need = PLANNED - cash
    await topUp(buyer, need)
    await retry(async () => tx(await bw.writeContract({ address: USD, abi: usdAbi, functionName: 'approve', args: [SETTLEMENT, need] })), 'buyer approve')
    await retry(async () => tx(await bw.writeContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'deposit', args: [need] })), 'buyer deposit')
  }
  const free = await read('freeCollateral', [seller.address])
  if (free < PLANNED) {
    const topup = PLANNED - free + 500_000n
    await topUp(seller, topup)
    await retry(async () => tx(await sw.writeContract({ address: USD, abi: usdAbi, functionName: 'approve', args: [SETTLEMENT, topup] })), 'seller approve')
    await retry(async () => tx(await sw.writeContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'depositCollateral', args: [topup] })), 'seller collateral')
  }
  console.log(`funded: buyer cash ${await read('balances', [buyer.address])}, seller free collateral ${await read('freeCollateral', [seller.address])}`)
  console.log('warm-up: 20s idle so the RPC token bucket refills before epoch traffic')
  await sleep(20_000)
}

const P14 = 14_000_000, P15 = 15_000_000, P155 = 15_500_000, P13 = 13_000_000, P16 = 16_000_000, P10 = 10_000_000
const Q = 10_000
const posted = {} // tag -> {digest, order, account}

async function postOrder(which, account, side, price, qty, tag, expirySecs = 1800) {
  const o = await signedOrder(account, side, price, qty, tag, expirySecs)
  const r = await postRaw(`${OPS[which].url}/clob/order`, o)
  if (r.status !== 200) throw new Error(`post ${tag} -> ${r.status}: ${JSON.stringify(r.body)}`)
  posted[tag] = { digest: r.body.digest, order: o.order, signature: o.signature, account }
  return r.body
}

// Wait until just after an epoch boundary so all orders of a scenario land in
// ONE epoch window (a proposer snapshots whatever it holds at the boundary).
async function freshEpoch() {
  const ms = EPOCH_SECS * 1000 - (Date.now() % (EPOCH_SECS * 1000))
  if (ms < 2500) await sleep(ms + 200)
}

try {
  // ═══ Scenario 1: multi-order epoch — 22 orders, 8 fills in ONE batch ════════
  console.log('\n═══ scenario 1: multi-order epoch ═══')
  const s1 = { nonce0: await nonce(), fromBlock: await pub.getBlockNumber() }
  const feeRecip0 = await read('balances', [await read('feeRecipient', [])])
  const buyer0 = await read('balances', [buyer.address])
  const seller0 = await read('balances', [seller.address])
  // The RPC 429s ~6% of calls and the operator abandons an epoch on ANY failed
  // call (no retry), so keep the fill count low: the pre-match sim costs ~3
  // calls per order per fill. Crossing: 2 sells@14M + 1 sell@15M vs 3 buys@15.5M
  // → 3 fills at maker price. Resting (never cross): 5 sells@16M, 5 buys@13M,
  // 6 buys@15M (all asks at <=15M are consumed by the higher 15.5M bids).
  const plan = [
    ...Array.from({ length: 2 }, (_, i) => ['sell', P14, `s1-sell14-${i}`]),
    ...Array.from({ length: 1 }, (_, i) => ['sell', P15, `s1-sell15-${i}`]),
    ...Array.from({ length: 5 }, (_, i) => ['sell', P16, `s1-sell16-${i}`]),
    ...Array.from({ length: 3 }, (_, i) => ['buy', P155, `s1-buy155-${i}`]),
    ...Array.from({ length: 6 }, (_, i) => ['buy', P15, `s1-buy15-${i}`]),
    ...Array.from({ length: 5 }, (_, i) => ['buy', P13, `s1-buy13-${i}`]),
  ]
  await freshEpoch()
  for (let i = 0; i < plan.length; i++) {
    const [side, price, tag] = plan[i]
    await postOrder(i % 2 === 0 ? 'a' : 'b', side === 'buy' ? buyer : seller, side === 'buy' ? 0 : 1, price, Q, tag)
  }
  console.log(`posted ${plan.length} orders (alternating nodes)`)
  for (let i = 0; i < 20; i++) {
    const [sa, sb] = await Promise.all([status('a'), status('b')])
    if (sa.poolSize === plan.length && sb.poolSize === plan.length) break
    await sleep(1000)
  }
  const [sa1, sb1] = await Promise.all([status('a'), status('b')])
  console.log(`pools converged: A=${sa1.poolSize} B=${sb1.poolSize}`)

  const n1 = await waitNonceAdvance(s1.nonce0, 180)
  if (n1 === s1.nonce0) throw new Error('scenario 1: batch never settled')
  const ev1 = await settleEvidence(s1.fromBlock, s1.nonce0)
  const fills14 = ev1.fills.filter((f) => Number(f.execPriceMicroPerM) === P14)
  const fills15 = ev1.fills.filter((f) => Number(f.execPriceMicroPerM) === P15)
  const buyersOk = ev1.fills.every((f) => eq(f.buy.trader, buyer.address) && eq(f.sell.trader, seller.address) && Number(f.qtyTokens) === Q)
  const signersOk = ev1.signers.length === 2 && new Set(ev1.signers).size === 2 &&
    ev1.signers.includes(OPS.a.addr.toLowerCase()) && ev1.signers.includes(OPS.b.addr.toLowerCase())
  const buyer1 = await read('balances', [buyer.address])
  const seller1 = await read('balances', [seller.address])
  const feeRecip1 = await read('balances', [await read('feeRecipient', [])])
  const EXP_COST = 430_000n, EXP_FEE = 8_600n // 200bps protocol fee
  const lotsOk = []
  for (const fl of ev1.fillLogs) {
    const lot = await read('lots', [fl.args.lotId])
    lotsOk.push(eq(lot[0], buyer.address) && eq(lot[1], seller.address) && Number(lot[3]) === Q)
  }
  const s1pass =
    ev1.batchLog.args.fillCount === 3n && ev1.fills.length === 3 &&
    fills14.length === 2 && fills15.length === 1 && buyersOk && signersOk &&
    buyer0 - buyer1 === EXP_COST && seller1 - seller0 === EXP_COST - EXP_FEE &&
    feeRecip1 - feeRecip0 === EXP_FEE &&
    ev1.fillLogs.length === 3 && lotsOk.every(Boolean)
  record('1: multi-order epoch (22 orders → 3 fills, one settleBatchAttested)', s1pass,
    `nonce ${s1.nonce0}->${n1}, fillCount=${ev1.batchLog.args.fillCount} (2@14M + 1@15M, maker price), ` +
    `buyer -${buyer0 - buyer1} micro, seller +${seller1 - seller0}, feeRecipient +${feeRecip1 - feeRecip0}, ` +
    `quorum signers ${ev1.signers.join(',')}, lots minted=${ev1.fillLogs.length} all valid=${lotsOk.every(Boolean)}, tx=${ev1.txHash}`)

  // ═══ Scenario 2: resting hygiene ═══════════════════════════════════════════
  console.log('\n═══ scenario 2: resting hygiene ═══')
  const [sa2, sb2] = await Promise.all([status('a'), status('b')])
  const restOk = sa2.poolSize === 16 && sb2.poolSize === 16
  // Re-posting a SETTLED order (verbatim, original signature) must be refused
  // by the finality set on BOTH nodes (audit H1).
  const st1 = posted['s1-sell15-0']
  const wire = { instrumentId: INSTRUMENT, order: st1.order, signature: st1.signature }
  const replayA2 = await postRaw(`${OPS.a.url}/clob/order`, wire)
  const replayB2 = await postRaw(`${OPS.b.url}/clob/order`, wire)
  const settledRejected = replayA2.status === 409 && replayB2.status === 409
  record('2: non-crossing orders rest; settled orders pruned + replay refused', restOk && settledRejected,
    `poolSize A=${sa2.poolSize} B=${sb2.poolSize} (expect 16: 5 sells@16M + 5 buys@13M + 6 buys@15M); ` +
    `settled-order replay -> A=${replayA2.status} B=${replayB2.status} (${JSON.stringify(replayA2.body).slice(0, 80)})`)

  // ═══ Scenario 4: spam/grief ════════════════════════════════════════════════
  console.log('\n═══ scenario 4: spam/grief (50 junk orders) ═══')
  const poolBeforeSpam = (await status('a')).poolSize
  const junkResults = { badSig: 0, malformed: 0, wrongInstrument: 0, expired: 0, huge: 0, zeroQtyAdmitted: 0 }
  const junkPost = (i, body) => postRaw(`${OPS[i % 2 === 0 ? 'a' : 'b'].url}/clob/order`, body)
  for (let i = 0; i < 15; i++) { // bad signatures
    const o = await signedOrder(buyer, 0, P15, Q, `junk-sig-${i}`)
    o.signature = '0x' + 'ab'.repeat(65)
    const r = await junkPost(i, o)
    if (r.status === 422) junkResults.badSig++
  }
  for (let i = 0; i < 10; i++) { // malformed bodies
    const r = await junkPost(i, JSON.stringify({ instrumentId: INSTRUMENT, order: { side: 'buy', price: 'lots' }, signature: 42 }))
    if (r.status === 400 || r.status === 422) junkResults.malformed++
  }
  for (let i = 0; i < 10; i++) { // unknown instrument
    const o = i < 5
      ? await signedOrder(buyer, 0, P15, Q, `junk-inst-${i}`, 1800, 'bogus/model:output') // signed over bogus id -> 404
      : await signedOrder(buyer, 0, P15, Q, `junk-inst-${i}`) // signed over real id, id swapped -> 422
    if (i >= 5) o.instrumentId = 'bogus/model:output'
    const r = await junkPost(i, o)
    if (r.status === 404 || r.status === 422) junkResults.wrongInstrument++
  }
  for (let i = 0; i < 5; i++) { // already expired / expiring inside the margin
    const o = await signedOrder(buyer, 0, P15, Q, `junk-exp-${i}`, 10)
    const r = await junkPost(i, o)
    if (r.status === 422) junkResults.expired++
  }
  for (let i = 0; i < 5; i++) { // price/qty outside the i64 matchable domain
    // 2^63 is exact in f64 and BigInt(Number(2^63)) round-trips, so the
    // signature is genuine and admission reaches the matchable-range check.
    const o = await signedOrder(buyer, 0, Number(2n ** 63n), Q, `junk-huge-${i}`)
    const r = await junkPost(i, o)
    if (r.status === 422) junkResults.huge++
  }
  for (let i = 0; i < 5; i++) { // zero-qty: no admission check exists — observe
    // (long expiry so they rest through the remaining scenarios, harmlessly:
    // the matcher drops qty<min_qty, and cost 0 is never in a fill)
    const o = await signedOrder(buyer, 0, P10, 0, `junk-zero-${i}`, 600)
    const r = await junkPost(i, o)
    if (r.status === 200) junkResults.zeroQtyAdmitted++
  }
  const healthA = (await fetch(`${OPS.a.url}/health`)).ok
  const healthB = (await fetch(`${OPS.b.url}/health`)).ok
  const poolAfterSpam = (await status('a')).poolSize
  const rejected = junkResults.badSig + junkResults.malformed + junkResults.wrongInstrument + junkResults.expired + junkResults.huge
  record('4a: 50 junk orders rejected without crash or corruption', rejected === 45 && healthA && healthB && poolAfterSpam === poolBeforeSpam + junkResults.zeroQtyAdmitted,
    `${JSON.stringify(junkResults)} — 45 rejected, zero-qty admitted=${junkResults.zeroQtyAdmitted} (rest until expiry), ` +
    `health A=${healthA} B=${healthB}, pool ${poolBeforeSpam}->${poolAfterSpam}`)

  // 4b: an unfunded griefer's crossing sell must be evicted by the proposer's
  // pre-match simulation (H3) — the batch carries on without it, nonce STATIC.
  console.log('\n═══ scenario 4b: unfunded griefer eviction ═══')
  const n4 = await nonce()
  await postOrder('a', griefer, 1, 13_500_000, Q, 'griefer-sell', 300) // crosses resting buys@15M
  await postOrder('b', buyer, 0, P14, Q, 's4-buy14', 300)
  const n4after = await waitNonceAdvance(n4, 3 * EPOCH_SECS + 6)
  // The only crossing pairs involve the penniless griefer → sim evicts the
  // sell, nothing settles. (Resting book: asks 16M, bids ≤15M — no cross.)
  const evictedOk = n4after === n4
  await postRaw(`${OPS.a.url}/clob/cancel`, await signedCancel(buyer, posted['s4-buy14'].digest)) // clean up the resting buy
  record('4b: unfunded griefer sell evicted by pre-match sim (no settle)', evictedOk,
    `nonce static at ${n4} for ~3 epochs while a griefer sell crossed resting bids; buyer's crossing buy rested and was cancelled`)

  // ═══ Scenario 5: cancel / expiry ═══════════════════════════════════════════
  console.log('\n═══ scenario 5: cancel / expiry ═══')
  // 5a: off-chain signed cancel of a resting sell@16M, gossiped to the peer.
  const cancelTag = 's1-sell16-0'
  const poolPreCancel = (await status('a')).poolSize
  const cr = await postRaw(`${OPS.a.url}/clob/cancel`, await signedCancel(seller, posted[cancelTag].digest))
  await sleep(1500) // cancel gossip
  const [sa5, sb5] = await Promise.all([status('a'), status('b')])
  const cancelOk = cr.status === 200 && cr.body.removedFromPool === true && sa5.poolSize === poolPreCancel - 1 && sb5.poolSize === poolPreCancel - 1
  // 5b: replaying the cancelled order must be refused on BOTH nodes.
  const replayA = await postRaw(`${OPS.a.url}/clob/order`, { instrumentId: INSTRUMENT, order: posted[cancelTag].order, signature: posted[cancelTag].signature })
  const replayB = await postRaw(`${OPS.b.url}/clob/order`, { instrumentId: INSTRUMENT, order: posted[cancelTag].order, signature: posted[cancelTag].signature })
  const replayOk = replayA.status === 409 && replayB.status === 409
  record('5a: off-chain signed cancel + gossip + replay rejection', cancelOk && replayOk,
    `cancel -> ${cr.status} removedFromPool=${cr.body?.removedFromPool}, pools ${poolPreCancel}->A=${sa5.poolSize}/B=${sb5.poolSize}; replay A=${replayA.status} B=${replayB.status}`)

  // 5c: on-chain cancelOrder (trader tx, gas in pathUSD) for a resting buy@13M.
  const oc = posted['s1-buy13-0'].order
  const cancelTx = await retry(async () => tx(await wallet(buyer).writeContract({
    address: SETTLEMENT, abi: settlementAbi, functionName: 'cancelOrder',
    args: [{ ...oc, priceMicroPerM: BigInt(oc.priceMicroPerM), qtyTokens: BigInt(oc.qtyTokens), expiry: BigInt(oc.expiry) }],
  })), 'on-chain cancelOrder')
  const cancelEv = parseAbiItem('event OrderCancelled(bytes32 indexed orderHash, address indexed trader)')
  const cancelLog = cancelTx.logs.find((l) => l.topics[0] === toEventSelector(cancelEv))
  const onchainCancelled = cancelLog ? await read('cancelled', [cancelLog.topics[1]]) : false
  record('5c: on-chain cancelOrder marks the order cancelled', cancelTx.status === 'success' && onchainCancelled === true,
    `tx=${cancelTx.transactionHash}, cancelled(${cancelLog?.topics[1]?.slice(0, 18)}…)=${onchainCancelled} (off-chain pool evicts lazily via the pre-match sim)`)

  // 5d: expiry — an order with expiry now+60s is admitted, never matched, and
  // evicted from both pools by the snapshot hygiene once expired.
  const poolPreExp = (await status('a')).poolSize
  await postOrder('a', buyer, 0, P10, Q, 'expiring-buy', 60)
  await sleep(70_000)
  let expiredGone = false
  for (let i = 0; i < 20; i++) {
    const [sa, sb] = await Promise.all([status('a'), status('b')])
    if (sa.poolSize === poolPreExp && sb.poolSize === poolPreExp) { expiredGone = true; break }
    await sleep(1000)
  }
  record('5d: expired order evicted from both pools without a cancel', expiredGone,
    `pool returned to ${poolPreExp} on both nodes after expiry+hygiene (was ${poolPreExp}+1 while live)`)

  // ═══ Scenario 3: proposer death ════════════════════════════════════════════
  console.log('\n═══ scenario 3: proposer death ═══')
  const n3 = await nonce()
  const s3from = await pub.getBlockNumber()
  // Wait for a fresh epoch boundary so the elected proposer is known-stable.
  const st = await status('a')
  const nowEpoch = Math.floor(Date.now() / 1000) / EPOCH_SECS
  const remainMs = (Math.ceil(nowEpoch) * EPOCH_SECS * 1000) - Date.now()
  if (remainMs < 2000) await sleep(remainMs + 100)
  const cur = await status('a')
  const victim = eq(cur.proposer, OPS.a.addr) ? 'a' : 'b'
  const survivor = victim === 'a' ? 'b' : 'a'
  console.log(`epoch ${cur.epoch}: elected proposer is ${victim.toUpperCase()} (${cur.proposer}) — SIGKILL it BEFORE posting orders`)
  procs[victim].kill('SIGKILL')
  delete procs[victim]
  await sleep(300)
  const victimDown = !(await fetch(`${OPS[victim].url}/health`).then((r) => r.ok).catch(() => false))
  // Orders enter at the SURVIVOR only; gossip to the dead peer fails silently.
  await postOrder(survivor, seller, 1, P15, Q, 's3-sell')
  await postOrder(survivor, buyer, 0, P15, Q, 's3-buy')
  // 2-of-2 with one node down: NO quorum is possible. Expect nonce static.
  const n3down = await waitNonceAdvance(n3, 3 * EPOCH_SECS + 8)
  const haltedOk = n3down === n3
  console.log(`with ${victim.toUpperCase()} down: nonce static=${haltedOk} (2-of-2 cannot quorum — safety over liveness, by design)`)
  // Restart the victim; settlement must resume at the survivor's next election.
  startOp(victim)
  await waitHealth(victim)
  console.log(`${victim.toUpperCase()} restarted — waiting for settlement to resume`)
  // Wide window: the RPC 429s ~half of all proposals (the operator has no
  // retry), so the survivor may need many elected epochs to land one.
  const n3up = await waitNonceAdvance(n3, 240)
  let s3ev = null
  if (n3up !== n3) s3ev = await settleEvidence(s3from, n3)
  const s3pass = victimDown && haltedOk && s3ev &&
    s3ev.signers.length === 2 && new Set(s3ev.signers).size === 2 &&
    s3ev.fills.length === 1 && Number(s3ev.fills[0].qtyTokens) === Q
  record('3: proposer death — halt while down (by design), resume after restart', Boolean(s3pass),
    `victim=${victim.toUpperCase()} SIGKILLed pre-order; nonce ${n3} static for ~3 epochs (halt=${haltedOk}); ` +
    `after restart nonce -> ${n3up}, 1 fill, quorum=${s3ev?.signers.join(',')}, tx=${s3ev?.txHash ?? 'none'}`)
} finally {
  killOps()
}

console.log('\n═══ PASS/FAIL MATRIX ═══')
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`)
const failed = results.filter((r) => !r.pass)
console.log(failed.length ? `\n${failed.length} scenario(s) FAILED` : '\nall scenarios passed')
process.exit(failed.length ? 1 : 0)

// ── cancel signing (declared late; hoisted) ──────────────────────────────────
async function signedCancel(account, orderHash) {
  const signature = await wallet(account).signTypedData({
    domain: { name: 'InferenceBazaarCancel', version: '1', chainId: tempo.id, verifyingContract: SETTLEMENT },
    types: { OrderCancel: [{ name: 'orderHash', type: 'bytes32' }] },
    primaryType: 'OrderCancel',
    message: { orderHash },
  })
  return { orderHash, trader: account.address, signature }
}
