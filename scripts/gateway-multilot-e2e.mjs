// Multi-lot gateway driver (see gateway-multilot-e2e.sh): mint TWO credit lots,
// delegate a session key for each, run ONE surplus-gateway over both, then drive
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
const GATEWAY_BIN = process.env.GATEWAY_BIN ?? './target/debug/surplus-gateway'
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

const domain = { name: 'SurplusSettlement', version: '1', chainId: anvil.id, verifyingContract: SETTLEMENT }
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
const cfgPath = `/tmp/surplus-gw-${process.pid}.json`
const fs = await import('node:fs')
fs.writeFileSync(cfgPath, JSON.stringify(cfg))

const gw = spawn(GATEWAY_BIN, [], {
  env: {
    ...process.env,
    SURPLUS_GATEWAY_CONFIG: cfgPath,
    SURPLUS_CHAIN_ID: '31337',
    SURPLUS_SETTLEMENT_ADDR: SETTLEMENT,
    SURPLUS_GATEWAY_LISTEN: `127.0.0.1:${GW_PORT}`,
    RUST_LOG: 'warn',
  },
  stdio: 'inherit',
})
const shutdown = () => { try { gw.kill() } catch {} ; try { fs.unlinkSync(cfgPath) } catch {} }
process.on('exit', shutdown)

try {
  // Wait for the gateway to accept connections.
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${GW}/v1/models`); break } catch { await sleep(100) }
  }

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
  console.log(`${ok}/5 calls served seamlessly through one gateway over two lots`)

  // ── Flush + prove BOTH lots debited on-chain ────────────────────────────────
  await post(`${VENUE}/v1/spend/flush`, {})
  const digest = (lotId, cap) => pub.readContract({
    address: SETTLEMENT, abi: settlementAbi, functionName: 'spendPermitDigest',
    args: [{ lotId, sessionKey: lotId === c1.lotId ? c1.session.address : c2.session.address, maxTokens: cap, expiry }],
  })
  const settled1 = Number(await pub.readContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'spendSettled', args: [await digest(c1.lotId, CAP1)] }))
  const settled2 = Number(await pub.readContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'spendSettled', args: [await digest(c2.lotId, CAP2)] }))

  if (settled1 !== Number(CAP1)) throw new Error(`lot1 should be fully drained to ${CAP1}, got ${settled1}`)
  if (settled2 <= 0) throw new Error(`lot2 should have served the failover calls, got ${settled2}`)

  console.log('')
  console.log('=== MULTI-LOT GATEWAY PROVEN ===')
  console.log(`one OpenAI base_url, two lots: lot1 drained to ${settled1}, then failed over to lot2 (${settled2})`)
  console.log(`a wallet of lots behind one API key — seamless across operators`)
} finally {
  shutdown()
}
