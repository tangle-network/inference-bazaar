// Multi-lot gateway driver (see gateway-multilot-e2e.sh): mint TWO credit lots,
// delegate a session key for each, run ONE inference-bazaar-gateway over both, then drive
// a vanilla OpenAI client at the gateway and prove it drains lot 1, fails over to
// lot 2 seamlessly, and both lots debit on-chain.
import { spawn } from 'node:child_process'
import { createPublicClient, createWalletClient, http, parseAbi, parseAbiItem, keccak256, toHex, zeroHash } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { anvil } from 'viem/chains'

const RPC = process.env.RPC ?? 'http://127.0.0.1:8545'
const SETTLEMENT = process.env.SETTLEMENT
const USD = process.env.USD
const VENUE = process.env.VENUE ?? 'http://127.0.0.1:9210'
const GW_PORT = Number(process.env.GW_PORT ?? 8088)
const GATEWAY_BIN = process.env.GATEWAY_BIN ?? './target/debug/inference-bazaar-gateway'
const GW = `http://127.0.0.1:${GW_PORT}`
const INSTRUMENT = 'claude-sonnet-4-6:output'

const operator = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const buyer = privateKeyToAccount('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6')

const settlementAbi = parseAbi([
  'function deposit(uint256 amount)',
  'function depositCollateral(uint256 amount)',
  'function lots(bytes32) view returns (address holder, address issuer, bytes32 instrument, uint64 qtyTokens, uint64 lockedTokens, uint64 expiry, uint128 notionalMicro)',
  'function spendSettled(bytes32 permitDigest) view returns (uint64)',
  'function spendPermitDigest((bytes32 lotId, address sessionKey, uint64 maxTokens, uint64 expiry) p) view returns (bytes32)',
])
const usdAbi = parseAbi([
  'function mint(address to, uint256 amount)',
  'function approve(address spender, uint256 amount) returns (bool)',
])

const pub = createPublicClient({ chain: anvil, transport: http(RPC) })
const wallet = (account) => createWalletClient({ account, chain: anvil, transport: http(RPC) })
const tx = (hash) => pub.waitForTransactionReceipt({ hash })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PRICE = 15_000_000n
const QTY = 1_000_000n
const COST = (PRICE * QTY) / 1_000_000n

const domain = { name: 'InferenceBazaarSettlement', version: '1', chainId: anvil.id, verifyingContract: SETTLEMENT }
const orderTypes = { Order: [
  { name: 'instrument', type: 'bytes32' }, { name: 'side', type: 'uint8' },
  { name: 'priceMicroPerM', type: 'uint64' }, { name: 'qtyTokens', type: 'uint64' },
  { name: 'lotId', type: 'bytes32' }, { name: 'trader', type: 'address' },
  { name: 'expiry', type: 'uint64' }, { name: 'salt', type: 'bytes32' },
]}
const permitTypes = { SpendPermit: [
  { name: 'lotId', type: 'bytes32' }, { name: 'sessionKey', type: 'address' },
  { name: 'maxTokens', type: 'uint64' }, { name: 'expiry', type: 'uint64' },
]}

async function post(url, body, headers = {}) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  const text = await r.text()
  if (!r.ok) throw new Error(`${url} -> ${r.status}: ${text}`)
  return JSON.parse(text)
}

async function signedOrder(account, side, salt) {
  const order = {
    instrument: keccak256(toHex(INSTRUMENT)), side,
    priceMicroPerM: Number(PRICE), qtyTokens: Number(QTY),
    lotId: zeroHash, trader: account.address,
    expiry: Math.floor(Date.now() / 1000) + 3600, salt: keccak256(toHex(salt)),
  }
  const signature = await wallet(account).signTypedData({
    domain, types: orderTypes, primaryType: 'Order',
    message: { ...order, priceMicroPerM: PRICE, qtyTokens: QTY, expiry: BigInt(order.expiry) },
  })
  return { instrumentId: INSTRUMENT, order, signature }
}

const FILL_EVENT = parseAbiItem('event FillSettled(bytes32 indexed buyOrderHash, bytes32 indexed sellOrderHash, bytes32 instrument, uint64 qtyTokens, uint64 execPriceMicroPerM, uint256 costMicro, bytes32 lotId)')

// Mint one lot to the buyer (operator issues), return its lotId from the event.
async function mintLot(salt) {
  const maker = await signedOrder(operator, 1, `sell-${salt}`)
  const taker = await signedOrder(buyer, 0, `buy-${salt}`)
  await post(`${VENUE}/rfq/fill`, { maker, taker })
  const flush = await post(`${VENUE}/settlement/flush`, {})
  if ((flush.submitted ?? 0) < 1) throw new Error(`fill did not settle: ${JSON.stringify(flush)}`)
  const logs = await pub.getLogs({ address: SETTLEMENT, event: FILL_EVENT, fromBlock: 0n })
  return logs[logs.length - 1].args.lotId // sequential mints → newest event is this lot
}

// ── Fund: buyer cash for 2 lots, operator collateral for 2 lots ──────────────
const ow = wallet(operator), bw = wallet(buyer)
await tx(await bw.writeContract({ address: USD, abi: usdAbi, functionName: 'mint', args: [buyer.address, COST * 2n] }))
await tx(await bw.writeContract({ address: USD, abi: usdAbi, functionName: 'approve', args: [SETTLEMENT, COST * 2n] }))
await tx(await bw.writeContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'deposit', args: [COST * 2n] }))
const COLLATERAL = (COST * 2n * 110n) / 100n
await tx(await ow.writeContract({ address: USD, abi: usdAbi, functionName: 'mint', args: [operator.address, COLLATERAL] }))
await tx(await ow.writeContract({ address: USD, abi: usdAbi, functionName: 'approve', args: [SETTLEMENT, COLLATERAL] }))
await tx(await ow.writeContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'depositCollateral', args: [COLLATERAL] }))

// ── Two lots; delegate a session key to each (lot1 cap small to force failover) ─
const lot1 = await mintLot('a')
const lot2 = await mintLot('b')
const expiry = BigInt(Math.floor(Date.now() / 1000) + 7 * 86400)
const CAP1 = 200n // small — drains after ~2 stub replies (137 each)
const CAP2 = 100_000n

async function delegate(lotId, cap) {
  const priv = generatePrivateKey()
  const session = privateKeyToAccount(priv)
  const holderSig = await bw.signTypedData({
    domain, types: permitTypes, primaryType: 'SpendPermit',
    message: { lotId, sessionKey: session.address, maxTokens: cap, expiry },
  })
  const reg = await post(`${VENUE}/v1/spend-keys`, {
    lotId, sessionKey: session.address, maxTokens: Number(cap), expiry: Number(expiry), holderSig,
  })
  return { priv, session, cap, lotId, model: reg.model }
}
const c1 = await delegate(lot1, CAP1)
const c2 = await delegate(lot2, CAP2)
console.log(`two lots delegated for ${c1.model}: lot1 cap ${CAP1}, lot2 cap ${CAP2}`)

// ── Write the multi-lot gateway config + start ONE gateway over both lots ─────
const cfg = [
  { lotId: c1.lotId, sessionKey: c1.priv, operatorUrl: VENUE, model: c1.model, maxTokens: Number(CAP1), expiry: Number(expiry) },
  { lotId: c2.lotId, sessionKey: c2.priv, operatorUrl: VENUE, model: c2.model, maxTokens: Number(CAP2), expiry: Number(expiry) },
]
const cfgPath = `/tmp/inference-bazaar-gw-${process.pid}.json`
const statePath = `/tmp/inference-bazaar-gw-state-${process.pid}.json`
const fs = await import('node:fs')
fs.writeFileSync(cfgPath, JSON.stringify(cfg))

// The gateway is restartable: it journals each channel's acked cumulative to
// INFERENCE_BAZAAR_GATEWAY_STATE so a restart resumes instead of re-signing cum=0.
function startGateway() {
  return spawn(GATEWAY_BIN, [], {
    env: {
      ...process.env,
      INFERENCE_BAZAAR_GATEWAY_CONFIG: cfgPath,
      INFERENCE_BAZAAR_GATEWAY_STATE: statePath,
      INFERENCE_BAZAAR_CHAIN_ID: '31337',
      INFERENCE_BAZAAR_SETTLEMENT_ADDR: SETTLEMENT,
      INFERENCE_BAZAAR_GATEWAY_LISTEN: `127.0.0.1:${GW_PORT}`,
      RUST_LOG: 'warn',
    },
    stdio: 'inherit',
  })
}
let gw = startGateway()
const shutdown = () => {
  try { gw.kill() } catch {}
  try { fs.unlinkSync(cfgPath) } catch {}
  try { fs.unlinkSync(statePath) } catch {}
}
process.on('exit', shutdown)

async function waitReady() {
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${GW}/v1/models`); return } catch { await sleep(100) }
  }
  throw new Error('gateway never came up')
}

// Stream a completion THROUGH the gateway and assert: the client gets real SSE
// content AND the private `inference-bazaar` event was stripped (never leaks downstream).
async function streamCall(model, content, maxTokens) {
  const r = await fetch(`${GW}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content }], max_tokens: maxTokens, stream: true }),
  })
  if (!r.ok) throw new Error(`stream call -> ${r.status}: ${await r.text()}`)
  const ct = r.headers.get('content-type') || ''
  if (!ct.includes('text/event-stream')) throw new Error(`expected SSE, got "${ct}"`)
  let buf = '', text = '', sawInferenceBazaar = false
  const dec = new TextDecoder()
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const ev = buf.slice(0, idx); buf = buf.slice(idx + 2)
      const line = ev.split('\n').find((l) => l.startsWith('data:'))
      if (!line) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') continue
      if (data.includes('"inference-bazaar"')) { sawInferenceBazaar = true; continue }
      try { const j = JSON.parse(data); const d = j.choices?.[0]?.delta?.content; if (d) text += d } catch {}
    }
  }
  return { text, sawInferenceBazaar }
}

try {
  await waitReady()

  // ── Drive a VANILLA OpenAI client at the gateway — no per-request crypto ─────
  // Five calls; lot1 (cap 200) drains after two 137-token replies, then the
  // gateway transparently fails over to lot2 — the client never notices.
  let ok = 0
  for (let i = 0; i < 5; i++) {
    const r = await post(`${GW}/v1/chat/completions`, {
      model: c1.model, messages: [{ role: 'user', content: `call ${i}` }], max_tokens: 256,
    })
    if (!r.choices?.[0]?.message?.content) throw new Error(`call ${i} returned no content`)
    ok++
  }
  console.log(`${ok}/5 buffered calls served seamlessly through one gateway over two lots`)

  // ── Flush + prove BOTH lots debited on-chain ────────────────────────────────
  await post(`${VENUE}/v1/spend/flush`, {})
  const digest = (lotId, cap) => pub.readContract({
    address: SETTLEMENT, abi: settlementAbi, functionName: 'spendPermitDigest',
    args: [{ lotId, sessionKey: lotId === c1.lotId ? c1.session.address : c2.session.address, maxTokens: cap, expiry }],
  })
  const settledOf = async (lotId, cap) => Number(await pub.readContract({
    address: SETTLEMENT, abi: settlementAbi, functionName: 'spendSettled', args: [await digest(lotId, cap)],
  }))
  const settled1 = await settledOf(c1.lotId, CAP1)
  const settled2a = await settledOf(c2.lotId, CAP2)
  if (settled1 !== Number(CAP1)) throw new Error(`lot1 should be fully drained to ${CAP1}, got ${settled1}`)
  if (settled2a <= 0) throw new Error(`lot2 should have served the failover calls, got ${settled2a}`)

  // ── STREAMING through the gateway: SSE content flows, inference-bazaar event stripped ─
  const s = await streamCall(c2.model, 'stream please', 256)
  if (!s.text) throw new Error('streamed call produced no content')
  if (s.sawInferenceBazaar) throw new Error('gateway leaked the private inference-bazaar event to the client')
  console.log(`streamed ${s.text.length} chars through the gateway (inference-bazaar event stripped)`)

  // ── RESTART: prove acked persistence (a reset-to-0 gateway would 409-brick) ──
  gw.kill(); await sleep(300)
  const stateRaw = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  const lot2Acked = Number(stateRaw[c2.lotId.toLowerCase()] ?? stateRaw[c2.lotId] ?? 0)
  if (lot2Acked <= 0) throw new Error(`expected persisted acked for lot2, got ${JSON.stringify(stateRaw)}`)
  gw = startGateway()
  await waitReady()
  const after = await post(`${GW}/v1/chat/completions`, {
    model: c2.model, messages: [{ role: 'user', content: 'post-restart' }], max_tokens: 256,
  })
  if (!after.choices?.[0]?.message?.content) throw new Error('post-restart call returned no content (channel bricked?)')

  // The streaming + post-restart calls must have billed lot2 further on-chain.
  await post(`${VENUE}/v1/spend/flush`, {})
  const settled2b = await settledOf(c2.lotId, CAP2)
  if (settled2b <= settled2a) throw new Error(`lot2 should bill further after stream+restart: ${settled2a} -> ${settled2b}`)

  console.log('')
  console.log('=== MULTI-LOT GATEWAY PROVEN ===')
  console.log(`one OpenAI base_url, two lots: lot1 drained to ${settled1}, then failed over to lot2 (${settled2a})`)
  console.log(`streaming served through the gateway; acked persisted (${lot2Acked}) so a restart resumed and billed on to ${settled2b}`)
  console.log(`a wallet of lots behind one API key — seamless across operators, restart-safe`)
} finally {
  shutdown()
}
