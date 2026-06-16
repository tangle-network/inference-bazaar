// Spend-rail e2e driver (see spend-e2e.sh): buy a lot, delegate a session key
// with ONE wallet signature, then consume it as a VANILLA OpenAI-style request
// where a session-signed voucher (the thing the gateway signs invisibly) rides
// in headers — and prove the served tokens debit the lot on-chain. The core
// property under test: the operator can settle no more than the SESSION KEY
// signed, so over-billing is impossible by construction.
import { createPublicClient, createWalletClient, http, parseAbi, parseAbiItem, keccak256, toHex, zeroHash } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
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
  'function spendSettled(bytes32 permitDigest) view returns (uint64)',
  'function spendPermitDigest((bytes32 lotId, address sessionKey, uint64 maxTokens, uint64 expiry) p) view returns (bytes32)',
  'function revokeSpendKey((bytes32 lotId, address sessionKey, uint64 maxTokens, uint64 expiry) permit)',
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

const domain = { name: 'InferenceBazaarSettlement', version: '1', chainId: anvil.id, verifyingContract: SETTLEMENT }
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

// ── 2. Delegate a session key: ONE wallet signature opens the spend channel ──
const session = privateKeyToAccount(generatePrivateKey())
const maxTokens = 500_000n
const expiry = BigInt(Math.min(Number(lot0[5]) - 300, Math.floor(Date.now() / 1000) + 7 * 24 * 3600))

const permitTypes = { SpendPermit: [
  { name: 'lotId', type: 'bytes32' },
  { name: 'sessionKey', type: 'address' },
  { name: 'maxTokens', type: 'uint64' },
  { name: 'expiry', type: 'uint64' },
]}
const voucherTypes = { SpendVoucher: [
  { name: 'lotId', type: 'bytes32' },
  { name: 'sessionKey', type: 'address' },
  { name: 'servedCumulative', type: 'uint64' },
]}
const holderSig = await bw.signTypedData({
  domain, types: permitTypes, primaryType: 'SpendPermit',
  message: { lotId, sessionKey: session.address, maxTokens, expiry },
})
const reg = await post(`${VENUE}/v1/spend-keys`, {
  lotId, sessionKey: session.address, maxTokens: Number(maxTokens), expiry: Number(expiry), holderSig,
})
console.log(`session key delegated for ${reg.model} (cap ${reg.maxTokens} tokens)`)

// The gateway's job, inlined: sign a voucher acknowledging cumulative served.
// `signer` is the session key in the happy path; the negative test passes a
// different account to prove a non-session voucher is refused.
async function voucherSig(signer, servedCumulative) {
  return wallet(signer).signTypedData({
    domain, types: voucherTypes, primaryType: 'SpendVoucher',
    message: { lotId, sessionKey: session.address, servedCumulative },
  })
}
async function chat(content, cumulative) {
  return post(
    `${VENUE}/v1/chat/completions`,
    { model: reg.model, messages: [{ role: 'user', content }], max_tokens: 256 },
    {
      'x-inference-bazaar-session': session.address,
      'x-inference-bazaar-voucher-cum': String(cumulative),
      'x-inference-bazaar-voucher-sig': await voucherSig(session, cumulative),
    },
  )
}
async function ack(cumulative) {
  return post(`${VENUE}/v1/spend/ack`, {}, {
    'x-inference-bazaar-session': session.address,
    'x-inference-bazaar-voucher-cum': String(cumulative),
    'x-inference-bazaar-voucher-sig': await voucherSig(session, cumulative),
  })
}

// ── 3. Consume: vanilla request body, voucher carried by the (gateway) headers ─
let acked = 0
const c1 = await chat('hello from the spend rail', acked)
const served1 = c1.usage.completion_tokens
if (!c1.choices?.[0]?.message?.content) throw new Error('no completion content')
acked = c1['inference-bazaar'].nextCumulative
await ack(acked) // trailing ack makes THIS request settleable
console.log(`served ${served1} tokens: "${c1.choices[0].message.content}"`)

// Over-bill is impossible without the session key: a voucher signed by the
// HOLDER (or anyone else) for the same cumulative must be refused.
const forged = await fetch(`${VENUE}/v1/chat/completions`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-inference-bazaar-session': session.address,
    'x-inference-bazaar-voucher-cum': String(acked),
    'x-inference-bazaar-voucher-sig': await voucherSig(buyer, acked),
  },
  body: JSON.stringify({ model: reg.model, messages: [{ role: 'user', content: 'forged' }] }),
})
if (forged.status !== 401) throw new Error(`forged voucher returned ${forged.status}, want 401`)

// A raw client with no voucher at all is a clean 401, never a served request.
const bare = await fetch(`${VENUE}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: reg.model, messages: [] }),
})
if (bare.status !== 401) throw new Error(`bare request returned ${bare.status}, want 401`)

// ── 4. Flush and prove the on-chain debit ────────────────────────────────────
const spendFlush = await post(`${VENUE}/v1/spend/flush`, {})
if (spendFlush.settled !== 1) throw new Error(`spend flush: ${JSON.stringify(spendFlush)}`)

const digest = await pub.readContract({
  address: SETTLEMENT, abi: settlementAbi, functionName: 'spendPermitDigest',
  args: [{ lotId, sessionKey: session.address, maxTokens, expiry }],
})
const settled = await pub.readContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'spendSettled', args: [digest] })
const lot1 = await pub.readContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'lots', args: [lotId] })
if (Number(settled) !== served1) throw new Error(`on-chain settled ${settled}, served ${served1}`)
if (Number(lot0[3]) - Number(lot1[3]) !== served1) throw new Error('lot quantity did not debit by served tokens')

// ── 5. Second call proves cumulative settlement ──────────────────────────────
const c2 = await chat('again', acked)
const served2 = c2.usage.completion_tokens
acked = c2['inference-bazaar'].nextCumulative
await ack(acked)
await post(`${VENUE}/v1/spend/flush`, {})
const settledCum = await pub.readContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'spendSettled', args: [digest] })
const lot2 = await pub.readContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'lots', args: [lotId] })
if (Number(settledCum) !== served1 + served2) throw new Error(`cumulative settled ${settledCum} != ${served1 + served2}`)

// ── 6. Streaming: token-by-token SSE, billed identically on-chain ────────────
const streamRes = await fetch(`${VENUE}/v1/chat/completions`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-inference-bazaar-session': session.address,
    'x-inference-bazaar-voucher-cum': String(acked),
    'x-inference-bazaar-voucher-sig': await voucherSig(session, acked),
  },
  body: JSON.stringify({
    model: reg.model,
    messages: [{ role: 'user', content: 'stream please' }],
    max_tokens: 256,
    stream: true,
  }),
})
if (!streamRes.ok) throw new Error(`stream -> ${streamRes.status}: ${await streamRes.text()}`)
if (!(streamRes.headers.get('content-type') || '').includes('text/event-stream'))
  throw new Error('stream response is not SSE')
const events = (await streamRes.text())
  .split('\n\n')
  .map((e) => e.replace(/^data:\s?/, '').trim())
  .filter(Boolean)
if (events[events.length - 1] !== '[DONE]') throw new Error('stream did not terminate with [DONE]')
const parsed = events.filter((e) => e !== '[DONE]').map((e) => JSON.parse(e))
const streamedText = parsed.map((c) => c.choices?.[0]?.delta?.content ?? '').join('')
if (!streamedText.includes('stub reply')) throw new Error(`streamed content wrong: "${streamedText}"`)
const ibEv = parsed.find((c) => c['inference-bazaar'])
if (!ibEv) throw new Error('operator did not emit an inference-bazaar event in the stream')
const served3 = ibEv['inference-bazaar'].servedTokens
acked = ibEv['inference-bazaar'].nextCumulative
if (acked !== served1 + served2 + served3)
  throw new Error(`stream nextCumulative ${acked} != ${served1 + served2 + served3}`)
await ack(acked)
await post(`${VENUE}/v1/spend/flush`, {})
const settledStream = await pub.readContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'spendSettled', args: [digest] })
const lot3 = await pub.readContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'lots', args: [lotId] })
if (Number(settledStream) !== served1 + served2 + served3)
  throw new Error(`stream settled ${settledStream} != ${served1 + served2 + served3}`)

// ── 7. Revocation: holder kills the channel on-chain; the operator stops ──────
// serving it. revokeSpendKey makes settleSpend revert, so continued service is
// unbillable — the flush reconciler must drop the channel and refuse it.
await tx(await bw.writeContract({
  address: SETTLEMENT, abi: settlementAbi, functionName: 'revokeSpendKey',
  args: [{ lotId, sessionKey: session.address, maxTokens, expiry }],
}))
const reconciled = await post(`${VENUE}/v1/spend/flush`, {})
if ((reconciled.dropped ?? 0) < 1) throw new Error(`flush did not drop the revoked channel: ${JSON.stringify(reconciled)}`)
const afterRevoke = await fetch(`${VENUE}/v1/chat/completions`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-inference-bazaar-session': session.address,
    'x-inference-bazaar-voucher-cum': String(acked),
    'x-inference-bazaar-voucher-sig': await voucherSig(session, acked),
  },
  body: JSON.stringify({ model: reg.model, messages: [{ role: 'user', content: 'after revoke' }], max_tokens: 256 }),
})
if (afterRevoke.status !== 401) throw new Error(`post-revocation serve returned ${afterRevoke.status}, want 401 (channel dropped)`)
const settledAfterRevoke = await pub.readContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'spendSettled', args: [digest] })
if (Number(settledAfterRevoke) !== Number(settledStream)) throw new Error('revoked channel must not bill further')

console.log('')
console.log('=== SPEND RAIL PROVEN ===')
console.log(`one wallet signature -> session key ${session.address.slice(0, 10)}…`)
console.log(`vanilla OpenAI calls served: ${served1} + ${served2} tokens, zero per-request user crypto`)
console.log(`forged voucher (not the session key) refused; over-billing impossible by construction`)
console.log(`streamed ${served3} tokens token-by-token (SSE: "${streamedText.trim()}"), billed identically`)
console.log(`holder revoked on-chain -> operator dropped the channel and refused further service (401)`)
console.log(`on-chain: lot ${Number(lot0[3])} -> ${Number(lot3[3])} tokens, spendSettled = ${settledStream}`)
