// LIVE spend-key proof on Base Sepolia: take the freshest op-issued lot owned
// by the e2e buyer, mint a bearer key with ONE signature, run a REAL inference
// call through the vanilla OpenAI surface, and verify the on-chain debit.
import { createPublicClient, createWalletClient, http, parseAbi, parseAbiItem, keccak256, toBytes } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import fs from 'node:fs'

const RPC = process.env.RPC ?? 'https://base-sepolia-rpc.publicnode.com'
const SETTLEMENT = process.env.SETTLEMENT ?? '0x64867eacf2e4581d182c2Be634cfD7fF3D3d9f83'
const VENUE = process.env.VENUE ?? 'https://surplus.178.104.232.124.sslip.io' // op4 — the issuer
const FROM_BLOCK = BigInt(process.env.FROM_BLOCK ?? 42755608)

const buyer = privateKeyToAccount(fs.readFileSync('/tmp/surplus-e2e-buyer.key', 'utf8').trim())
const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) })
const wallet = createWalletClient({ account: buyer, chain: baseSepolia, transport: http(RPC) })

const abi = parseAbi([
  'function lots(bytes32) view returns (address holder, address issuer, bytes32 instrument, uint64 qtyTokens, uint64 lockedTokens, uint64 expiry, uint128 notionalMicro)',
  'function spendSettled(bytes32) view returns (uint64)',
  'function spendAuthDigest((bytes32 lotId, bytes32 keyHash, uint64 maxTokens, uint64 expiry) a) view returns (bytes32)',
])

// Freshest lot held by the buyer.
const fills = await pub.getLogs({
  address: SETTLEMENT,
  event: parseAbiItem('event FillSettled(bytes32 indexed buyOrderHash, bytes32 indexed sellOrderHash, bytes32 instrument, uint64 qtyTokens, uint64 execPriceMicroPerM, uint256 costMicro, bytes32 lotId)'),
  fromBlock: FROM_BLOCK,
})
let lotId = null, lot = null
for (const f of fills.reverse()) {
  const l = await pub.readContract({ address: SETTLEMENT, abi, functionName: 'lots', args: [f.args.lotId] })
  if (l[0].toLowerCase() === buyer.address.toLowerCase()) { lotId = f.args.lotId; lot = l; break }
}
if (!lotId) throw new Error('no lot held by the e2e buyer')
console.log(`lot ${lotId}: ${lot[3]} tokens, issuer ${lot[1]}`)

// ONE signature -> bearer key.
const secret = crypto.getRandomValues(new Uint8Array(16))
const apiKey = 'sk-surplus-' + Buffer.from(new Uint8Array([...toBytes(lotId), ...toBytes(lot[1]), ...secret])).toString('base64url')
const keyHash = keccak256(toBytes(apiKey))
const maxTokens = BigInt(lot[3])
const expiry = BigInt(Math.min(Number(lot[5]) - 300, Math.floor(Date.now() / 1000) + 7 * 86400))
const signature = await wallet.signTypedData({
  domain: { name: 'SurplusSettlement', version: '1', chainId: baseSepolia.id, verifyingContract: SETTLEMENT },
  types: { SpendKeyAuth: [
    { name: 'lotId', type: 'bytes32' }, { name: 'keyHash', type: 'bytes32' },
    { name: 'maxTokens', type: 'uint64' }, { name: 'expiry', type: 'uint64' },
  ]},
  primaryType: 'SpendKeyAuth',
  message: { lotId, keyHash, maxTokens, expiry },
})

async function post(url, body, headers = {}) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  const text = await r.text()
  if (!r.ok) throw new Error(`${url} -> ${r.status}: ${text}`)
  return JSON.parse(text)
}

const reg = await post(`${VENUE}/v1/spend-keys`, { lotId, keyHash, maxTokens: Number(maxTokens), expiry: Number(expiry), signature })
console.log(`key registered: model ${reg.model}`)

// REAL inference, vanilla OpenAI shape, bearer auth — zero crypto in the path.
const out = await post(
  `${VENUE}/v1/chat/completions`,
  { model: reg.model, messages: [{ role: 'user', content: 'In one short sentence: what is special about buying inference on a market?' }], max_tokens: 60 },
  { authorization: `Bearer ${apiKey}` },
)
const served = out.usage.completion_tokens
console.log(`REAL completion (${served} tokens): "${out.choices[0].message.content.trim()}"`)

// Flush and verify the on-chain debit.
const flush = await post(`${VENUE}/v1/spend/flush`, {})
if (flush.settled !== 1) throw new Error(`flush: ${JSON.stringify(flush)}`)
const digest = await pub.readContract({ address: SETTLEMENT, abi, functionName: 'spendAuthDigest', args: [{ lotId, keyHash, maxTokens, expiry }] })
// Public RPC is load-balanced; the settle tx may not be visible on the node
// answering the read yet. Poll until it is.
let settled = 0n, lotAfter = lot
for (let i = 0; i < 20 && Number(settled) === 0; i++) {
  await new Promise((r) => setTimeout(r, 3000))
  settled = await pub.readContract({ address: SETTLEMENT, abi, functionName: 'spendSettled', args: [digest] })
  lotAfter = await pub.readContract({ address: SETTLEMENT, abi, functionName: 'lots', args: [lotId] })
}
if (Number(settled) !== served) throw new Error(`settled ${settled} != served ${served}`)
if (Number(lot[3]) - Number(lotAfter[3]) !== served) throw new Error('lot did not debit by served tokens')

console.log('')
console.log('=== LIVE SPEND RAIL ON BASE SEPOLIA ===')
console.log(`one signature -> ${apiKey.slice(0, 26)}…`)
console.log(`real inference served and settled: lot ${lot[3]} -> ${lotAfter[3]} tokens, spendSettled=${settled}`)
