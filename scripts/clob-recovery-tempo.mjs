// POST-QUORUM RECOVERY PROOF on Tempo (chainId 42431): reproduce the observed
// "settle tx accepted by the RPC, evicted from the mempool, never mined"
// failure with a local JSON-RPC proxy that DROPS the first
// eth_sendRawTransaction (answering with a well-formed fake hash) and forwards
// everything else. Pre-fix, the batch's orders were pruned at quorum and lost
// forever; post-fix the settlement watcher releases them at the pending
// deadline and a later elected proposer re-drives the batch to a REAL settle.
// Run: FUNDER_KEY=0x... node scripts/clob-recovery-tempo.mjs
import { createPublicClient, createWalletClient, http, defineChain, parseAbi, parseAbiItem, keccak256, toHex, zeroHash, toEventSelector } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ephemeralKey } from './_keys.mjs'
import { spawn } from 'node:child_process'
import http2 from 'node:http'
import fs from 'node:fs'

const tempo = defineChain({
  id: 42431, name: 'tempo-moderato',
  nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.moderato.tempo.xyz'] } },
})

const UPSTREAM = process.env.RPC ?? 'https://rpc.moderato.tempo.xyz'
const PROXY_PORT = 8546
const PROXY = `http://127.0.0.1:${PROXY_PORT}`
const SETTLEMENT = '0x83084C8cD2282F6126e25089f0FD26b145eCa597'
const USD = '0x20C0000000000000000000000000000000000000'
const INSTRUMENT = 'claude-sonnet-4-6:output'
const BOOK = keccak256(toHex('inference-bazaar.tempo.proof.1'))
const FUNDER_KEY = process.env.FUNDER_KEY
const EPOCH_SECS = 10

const OPS = {
  a: { addr: '0xEEF7b944f54D0DA2D7414104ee7EE6140AFcA404', url: 'http://127.0.0.1:9210', keyName: 'tempo-op-a' },
  b: { addr: '0xf8c04cC75137687Fd9e4dfc0AbB6F39F584e21ae', url: 'http://127.0.0.1:9211', keyName: 'tempo-op-b' },
}
const seller = privateKeyToAccount(ephemeralKey('tempo-seller'))
const buyer = privateKeyToAccount(ephemeralKey('tempo-buyer'))

// ── the drop-first-send proxy ────────────────────────────────────────────────
let dropped = null
const FAKE_HASH = '0xdead00000000000000000000000000000000000000000000000000000000beef'
async function startProxy() {
  const server = http2.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      let parsed
      try { parsed = JSON.parse(body) } catch { parsed = null }
      const calls = Array.isArray(parsed) ? parsed : [parsed]
      const isSend = parsed && !Array.isArray(parsed) && parsed.method === 'eth_sendRawTransaction'
      if (isSend && !dropped) {
        dropped = { id: parsed.id, at: new Date().toISOString() }
        console.log(`[proxy] DROPPING first eth_sendRawTransaction -> fake hash ${FAKE_HASH}`)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: FAKE_HASH }))
        return
      }
      if (isSend) console.log('[proxy] forwarding eth_sendRawTransaction (recovery submit)')
      const r = await fetch(UPSTREAM, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      res.writeHead(r.status, { 'content-type': 'application/json' })
      res.end(await r.text())
      void calls
    })
  })
  await new Promise((r) => server.listen(PROXY_PORT, r))
  return server
}

// ── chain helpers (direct RPC for the driver's own txs/reads) ────────────────
const settlementAbi = parseAbi([
  'function deposit(uint256 amount)',
  'function depositCollateral(uint256 amount)',
  'function balances(address) view returns (uint256)',
  'function freeCollateral(address) view returns (uint256)',
  'function bookNonce(bytes32 bookId) view returns (uint64)',
  'function bookThreshold(bytes32 bookId) view returns (uint16)',
])
const usdAbi = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
])
const pub = createPublicClient({ chain: tempo, transport: http(UPSTREAM) })
const wallet = (account) => createWalletClient({ account, chain: tempo, transport: http(UPSTREAM) })
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
const read = (fn, args) => retry(() => pub.readContract({ address: SETTLEMENT, abi: settlementAbi, functionName: fn, args }), fn)
const nonce = () => read('bookNonce', [BOOK])

// ── operators ────────────────────────────────────────────────────────────────
const OP_BIN = './target/debug/inference-bazaar-operator-lite'
const procs = {}
function startOp(which) {
  const op = OPS[which]
  fs.mkdirSync('.keys/logs', { recursive: true })
  const log = fs.openSync(`.keys/logs/recovery-op-${which}.log`, 'w')
  const p = spawn(OP_BIN, [], {
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      RUST_LOG: 'info,inference_bazaar_operator::clob=debug',
      INFERENCE_BAZAAR_OPERATOR_ADDR: `127.0.0.1:${new URL(op.url).port}`,
      INFERENCE_BAZAAR_OPERATOR_KEY: fs.readFileSync(`.keys/${op.keyName}.key`, 'utf8').trim(),
      INFERENCE_BAZAAR_CHAIN_ID: '42431',
      INFERENCE_BAZAAR_RPC_URL: PROXY, // <-- through the drop-first-send proxy
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

// ── orders ───────────────────────────────────────────────────────────────────
const domain = { name: 'InferenceBazaarSettlement', version: '1', chainId: tempo.id, verifyingContract: SETTLEMENT }
const orderTypes = { Order: [
  { name: 'instrument', type: 'bytes32' }, { name: 'side', type: 'uint8' },
  { name: 'priceMicroPerM', type: 'uint64' }, { name: 'qtyTokens', type: 'uint64' },
  { name: 'lotId', type: 'bytes32' }, { name: 'trader', type: 'address' },
  { name: 'expiry', type: 'uint64' }, { name: 'salt', type: 'bytes32' },
]}
async function signedOrder(account, side, price, qty, salt) {
  const order = {
    instrument: keccak256(toHex(INSTRUMENT)), side, priceMicroPerM: price, qtyTokens: qty,
    lotId: zeroHash, trader: account.address,
    expiry: Math.floor(Date.now() / 1000) + 1800,
    salt: keccak256(toHex(`recovery-${salt}-${Date.now()}`)),
  }
  const signature = await wallet(account).signTypedData({
    domain, types: orderTypes, primaryType: 'Order',
    message: { ...order, priceMicroPerM: BigInt(price), qtyTokens: BigInt(qty), expiry: BigInt(order.expiry) },
  })
  return { instrumentId: INSTRUMENT, order, signature }
}
async function postOrder(which, body) {
  const r = await fetch(`${OPS[which].url}/clob/order`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const t = await r.text()
  if (r.status !== 200) throw new Error(`post -> ${r.status}: ${t}`)
  return JSON.parse(t)
}

// ═════════════════════════════════════════════════════════════════════════════
const proxy = await startProxy()
console.log(`proxy :${PROXY_PORT} -> ${UPSTREAM} (drops FIRST eth_sendRawTransaction)`)
console.log(`book ${BOOK} (threshold ${await read('bookThreshold', [BOOK])})`)
startOp('a'); startOp('b')
await waitHealth('a'); await waitHealth('b')
console.log('operators up via the dropping proxy')

// Funding: one fill = 150,000 micro.
const NEED = 400_000n
const funder = FUNDER_KEY ? wallet(privateKeyToAccount(FUNDER_KEY)) : null
const cash = await read('balances', [buyer.address])
if (cash < NEED) {
  const need = NEED - cash
  await retry(async () => tx(await funder.writeContract({ address: USD, abi: usdAbi, functionName: 'transfer', args: [buyer.address, need + 300_000n] })), 'funder transfer')
  await retry(async () => tx(await wallet(buyer).writeContract({ address: USD, abi: usdAbi, functionName: 'approve', args: [SETTLEMENT, need] })), 'buyer approve')
  await retry(async () => tx(await wallet(buyer).writeContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'deposit', args: [need] })), 'buyer deposit')
}
const free = await read('freeCollateral', [seller.address])
if (free < NEED) {
  const topup = NEED - free + 300_000n
  await retry(async () => tx(await funder.writeContract({ address: USD, abi: usdAbi, functionName: 'transfer', args: [seller.address, topup] })), 'funder transfer')
  await retry(async () => tx(await wallet(seller).writeContract({ address: USD, abi: usdAbi, functionName: 'approve', args: [SETTLEMENT, topup] })), 'seller approve')
  await retry(async () => tx(await wallet(seller).writeContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'depositCollateral', args: [topup] })), 'seller collateral')
}
console.log(`funded: buyer cash ${await read('balances', [buyer.address])}, seller free collateral ${await read('freeCollateral', [seller.address])}`)

const nonce0 = await nonce()
const fromBlock = await pub.getBlockNumber()
const buyer0 = await read('balances', [buyer.address])
const seller0 = await read('balances', [seller.address])
const t0 = Date.now()

console.log('posting crossing pair (sell -> A, buy -> B)')
await postOrder('a', await signedOrder(seller, 1, 15_000_000, 10_000, 'sell'))
await postOrder('b', await signedOrder(buyer, 0, 15_000_000, 10_000, 'buy'))

// Watch: nonce must NOT advance while the dropped tx is outstanding, then MUST
// advance exactly once when the watcher releases and a later epoch re-drives.
let nonce1 = nonce0, firstAdvanceAt = null
const deadline = t0 + 300_000
while (Date.now() < deadline) {
  await sleep(3000)
  const n = await nonce()
  if (n !== nonce0) { nonce1 = n; firstAdvanceAt = Date.now(); break }
}
if (!firstAdvanceAt) throw new Error('recovery never happened: nonce static for 300s')

// Exactly ONE batch landed for this pair (no double-settle): nonce moved by 1.
const nonceAfter = await nonce()
// The fake hash has no receipt; the real settle tx does. The public RPC is
// load-balanced — the log index can lag the nonce read by seconds, so poll.
const batch6 = parseAbiItem('event BatchSettled(bytes32 indexed bookId, uint64 indexed batchNonce, bytes32 fillsHash, uint256 fillCount, bool proven, bytes32 ordersCommitment)')
const sel6 = toEventSelector(batch6)
const { decodeEventLog, decodeFunctionData, hashTypedData, recoverAddress } = await import('viem')
let batchLog = null
for (let i = 0; i < 20 && !batchLog; i++) {
  const logs = await retry(() => pub.getLogs({ address: SETTLEMENT, fromBlock }), 'getLogs')
  const raw = logs.find((l) => l.topics[0] === sel6 && l.topics[1]?.toLowerCase() === BOOK.toLowerCase())
  if (raw) batchLog = { ...raw, args: decodeEventLog({ abi: [batch6], data: raw.data, topics: raw.topics }).args }
  else await sleep(3000)
}
if (!batchLog) throw new Error('BatchSettled log never appeared despite nonce advance')
const fakeReceipt = await pub.getTransactionReceipt({ hash: FAKE_HASH }).catch(() => null)

// Quorum proof on the landed tx.
const settleAbi2 = parseAbi([
  'struct Order { bytes32 instrument; uint8 side; uint64 priceMicroPerM; uint64 qtyTokens; bytes32 lotId; address trader; uint64 expiry; bytes32 salt; }',
  'struct BatchFill { Order buy; Order sell; uint64 qtyTokens; uint64 execPriceMicroPerM; }',
  'function settleBatchAttested(bytes32 bookId, BatchFill[] fills, bytes[] sigs)',
])
const settleTx = await pub.getTransaction({ hash: batchLog.transactionHash })
const decoded = decodeFunctionData({ abi: settleAbi2, data: settleTx.input })
const digest = hashTypedData({
  domain,
  types: { SettlementBatch: [{ name: 'bookId', type: 'bytes32' }, { name: 'batchNonce', type: 'uint64' }, { name: 'fillsHash', type: 'bytes32' }] },
  primaryType: 'SettlementBatch',
  message: { bookId: BOOK, batchNonce: nonce0, fillsHash: batchLog.args.fillsHash },
})
const signers = []
for (const sig of decoded.args[2]) signers.push((await recoverAddress({ hash: digest, signature: sig })).toLowerCase())

const buyer1 = await read('balances', [buyer.address])
const seller1 = await read('balances', [seller.address])
const opA = fs.readFileSync('.keys/logs/recovery-op-a.log', 'utf8')
const opB = fs.readFileSync('.keys/logs/recovery-op-b.log', 'utf8')
const ev = (re) => (opA.match(re) || opB.match(re) || [null])[0]
const droppedLog = ev(/receipt never landed for (0x[0-9a-f]+)/)
const releaseLog = ev(/never observed on-chain — orders released/)
const confirmLog = ev(/co-signed batch observed on-chain|epoch batch settled/)

const pass =
  dropped !== null &&
  nonce1 === nonce0 + 1n && nonceAfter === nonce1 && // exactly one batch
  batchLog?.args.fillCount === 1n &&
  fakeReceipt === null && // the dropped tx truly never landed
  signers.length === 2 && new Set(signers).size === 2 &&
  signers.includes(OPS.a.addr.toLowerCase()) && signers.includes(OPS.b.addr.toLowerCase()) &&
  buyer0 - buyer1 === 150_000n && seller1 - seller0 === 147_000n && // settled exactly once
  releaseLog !== null

console.log('')
console.log('=== POST-QUORUM RECOVERY ON TEMPO ===')
console.log(`dropped tx:  ${FAKE_HASH} (proxy-swallowed at ${dropped?.at}); on-chain receipt: ${fakeReceipt}`)
console.log(`lost submit: ${droppedLog ?? 'NOT SEEN'}`)
console.log(`released:    ${releaseLog ?? 'NOT SEEN'}`)
console.log(`confirmed:   ${confirmLog ?? 'NOT SEEN'}`)
console.log(`bookNonce:   ${nonce0} -> ${nonce1} (advanced exactly once, ${Math.round((firstAdvanceAt - t0) / 1000)}s after posting)`)
console.log(`settle tx:   ${batchLog?.transactionHash} fillCount=${batchLog?.args.fillCount}`)
console.log(`quorum:      ${signers.join(', ')}`)
console.log(`buyer paid once: ${buyer0 - buyer1} micro; seller received once: ${seller1 - seller0} micro`)
console.log(pass ? '\nPASS: lost submission recovered — orders survived, re-driven, settled exactly once' : '\nFAIL')
await new Promise((r) => proxy.close(r))
process.exit(pass ? 0 : 1)
