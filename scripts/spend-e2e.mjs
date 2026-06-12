// Spend-rail e2e driver (see spend-e2e.sh): buy a lot, mint a bearer API key
// with ONE wallet signature, consume it with a VANILLA OpenAI-style request
// (no wallet, no shim), and prove the served tokens debit the lot on-chain.
import { createPublicClient, createWalletClient, http, parseAbi, parseAbiItem, keccak256, toBytes, toHex, zeroHash } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { anvil } from 'viem/chains'

const RPC = process.env.RPC ?? 'http://127.0.0.1:8545'
const SETTLEMENT = process.env.SETTLEMENT
const USD = process.env.USD
const VENUE = process.env.VENUE ?? 'http://127.0.0.1:9210'
const INSTRUMENT = 'claude-sonnet-4-6:output'

// anvil #0 = the operator/issuer (the venue signs quotes with it), #3 = buyer.
const operator = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const buyer = privateKeyToAccount('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6')

const settlementAbi = parseAbi([
  'function deposit(uint256 amount)',
  'function depositCollateral(uint256 amount)',
  'function lots(bytes32) view returns (address holder, address issuer, bytes32 instrument, uint64 qtyTokens, uint64 lockedTokens, uint64 expiry, uint128 notionalMicro)',
  'function spendSettled(bytes32 authDigest) view returns (uint64)',
  'function spendAuthDigest((bytes32 lotId, bytes32 keyHash, uint64 maxTokens, uint64 expiry) a) view returns (bytes32)',
])
const usdAbi = parseAbi([
  'function mint(address to, uint256 amount)',
  'function approve(address spender, uint256 amount) returns (bool)',
])

const pub = createPublicClient({ chain: anvil, transport: http(RPC) })
const wallet = (account) => createWalletClient({ account, chain: anvil, transport: http(RPC) })
const tx = (hash) => pub.waitForTransactionReceipt({ hash })

const PRICE = 15_000_000n
const QTY = 1_000_000n
const COST = (PRICE * QTY) / 1_000_000n

async function post(url, body, headers = {}) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`${url} -> ${r.status}: ${text}`)
  return JSON.parse(text)
}

// ── 1. Fund and mint a lot: operator (issuer) sells, buyer buys, settleFills ──
const ow = wallet(operator), bw = wallet(buyer)
await tx(await bw.writeContract({ address: USD, abi: usdAbi, functionName: 'mint', args: [buyer.address, COST] }))
await tx(await bw.writeContract({ address: USD, abi: usdAbi, functionName: 'approve', args: [SETTLEMENT, COST] }))
await tx(await bw.writeContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'deposit', args: [COST] }))
const COLLATERAL = (COST * 110n) / 100n
await tx(await ow.writeContract({ address: USD, abi: usdAbi, functionName: 'mint', args: [operator.address, COLLATERAL] }))
await tx(await ow.writeContract({ address: USD, abi: usdAbi, functionName: 'approve', args: [SETTLEMENT, COLLATERAL] }))
await tx(await ow.writeContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'depositCollateral', args: [COLLATERAL] }))

const domain = { name: 'SurplusSettlement', version: '1', chainId: anvil.id, verifyingContract: SETTLEMENT }
const orderTypes = { Order: [
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
    domain, types: orderTypes, primaryType: 'Order',
    message: { ...order, priceMicroPerM: PRICE, qtyTokens: QTY, expiry: BigInt(order.expiry) },
  })
  return { instrumentId: INSTRUMENT, order, signature }
}

// Pair maker (operator sell) + taker (buyer) on the venue, then flush on-chain.
const maker = await signedOrder(operator, 1, 'spend-e2e-sell')
const taker = await signedOrder(buyer, 0, 'spend-e2e-buy')
await post(`${VENUE}/rfq/fill`, { maker, taker })
const flush = await post(`${VENUE}/settlement/flush`, {})
if (flush.submitted < 1) throw new Error(`fill did not settle: ${JSON.stringify(flush)}`)

const [fillLog] = await pub.getLogs({
  address: SETTLEMENT,
  event: parseAbiItem('event FillSettled(bytes32 indexed buyOrderHash, bytes32 indexed sellOrderHash, bytes32 instrument, uint64 qtyTokens, uint64 execPriceMicroPerM, uint256 costMicro, bytes32 lotId)'),
  fromBlock: 0n,
})
const lotId = fillLog.args.lotId
const lot0 = await pub.readContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'lots', args: [lotId] })
console.log(`lot minted: ${lotId} — ${lot0[3]} tokens, holder ${lot0[0]}`)

// ── 2. Mint the bearer key: ONE wallet signature, then it's just an API key ──
const secret = crypto.getRandomValues(new Uint8Array(16))
const payload = new Uint8Array([...toBytes(lotId), ...toBytes(operator.address), ...secret])
const apiKey = 'sk-surplus-' + Buffer.from(payload).toString('base64url')
const keyHash = keccak256(toBytes(apiKey))
const maxTokens = 500_000n
const expiry = BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 3600)

const spendTypes = { SpendKeyAuth: [
  { name: 'lotId', type: 'bytes32' },
  { name: 'keyHash', type: 'bytes32' },
  { name: 'maxTokens', type: 'uint64' },
  { name: 'expiry', type: 'uint64' },
]}
const authSig = await bw.signTypedData({
  domain, types: spendTypes, primaryType: 'SpendKeyAuth',
  message: { lotId, keyHash, maxTokens, expiry },
})
const reg = await post(`${VENUE}/v1/spend-keys`, {
  lotId, keyHash, maxTokens: Number(maxTokens), expiry: Number(expiry), signature: authSig,
})
console.log(`key registered for ${reg.model} (cap ${reg.maxTokens} tokens)`)

// ── 3. Consume with a VANILLA OpenAI-style call — no wallet, no shim ─────────
const completion = await post(
  `${VENUE}/v1/chat/completions`,
  { model: reg.model, messages: [{ role: 'user', content: 'hello from the spend rail' }], max_tokens: 256 },
  { authorization: `Bearer ${apiKey}` },
)
const served1 = completion.usage.completion_tokens
if (!completion.choices?.[0]?.message?.content) throw new Error('no completion content')
console.log(`served ${served1} tokens: "${completion.choices[0].message.content}"`)

// A wrong key must be a clean 401, not a served request.
const bad = await fetch(`${VENUE}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer sk-surplus-bogus' },
  body: JSON.stringify({ model: reg.model, messages: [] }),
})
if (bad.status !== 401) throw new Error(`bad key returned ${bad.status}, want 401`)

// ── 4. Flush and prove the on-chain debit ────────────────────────────────────
const spendFlush = await post(`${VENUE}/v1/spend/flush`, {})
if (spendFlush.settled !== 1) throw new Error(`spend flush: ${JSON.stringify(spendFlush)}`)

const digest = await pub.readContract({
  address: SETTLEMENT, abi: settlementAbi, functionName: 'spendAuthDigest',
  args: [{ lotId, keyHash, maxTokens, expiry }],
})
const settled = await pub.readContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'spendSettled', args: [digest] })
const lot1 = await pub.readContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'lots', args: [lotId] })
if (Number(settled) !== served1) throw new Error(`on-chain settled ${settled}, served ${served1}`)
if (Number(lot0[3]) - Number(lot1[3]) !== served1) throw new Error('lot quantity did not debit by served tokens')

// ── 5. Second call proves cumulative settlement ──────────────────────────────
const completion2 = await post(
  `${VENUE}/v1/chat/completions`,
  { model: reg.model, messages: [{ role: 'user', content: 'again' }] },
  { authorization: `Bearer ${apiKey}` },
)
const served2 = completion2.usage.completion_tokens
await post(`${VENUE}/v1/spend/flush`, {})
const settledCum = await pub.readContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'spendSettled', args: [digest] })
const lot2 = await pub.readContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'lots', args: [lotId] })
if (Number(settledCum) !== served1 + served2) throw new Error(`cumulative settled ${settledCum} != ${served1 + served2}`)

console.log('')
console.log('=== SPEND RAIL PROVEN ===')
console.log(`one wallet signature -> bearer key ${apiKey.slice(0, 24)}…`)
console.log(`vanilla OpenAI calls served: ${served1} + ${served2} tokens, zero per-request crypto`)
console.log(`on-chain: lot ${Number(lot0[3])} -> ${Number(lot2[3])} tokens, spendSettled = ${settledCum}`)
