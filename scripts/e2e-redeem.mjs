// E2E proof of gate G1: spend a credit lot on REAL inference.
//
//   lot (on-chain) → requestRedemption → operator serves via the Tangle
//   Router → holder signs the RedemptionReceipt → settleRedemption →
//   lot quota decremented on-chain at the locked price.
//
// Run from app/ (viem resolves there):
//   BUYER_KEY=0x… [VENUE=https://…] [LOT_ID=0x…] node ../scripts/e2e-redeem.mjs
import { createPublicClient, createWalletClient, hashTypedData, http, keccak256, parseAbi, toBytes } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'

const RPC = process.env.RPC ?? 'https://sepolia.base.org'
const VENUE = process.env.VENUE ?? 'https://surplus.178.104.232.124.sslip.io'
const SETTLEMENT = process.env.SETTLEMENT ?? '0x1cD49739e9CF48C4906aDb44021dd8cE0d8aBa64'
const LOT_ID = process.env.LOT_ID ?? '0xd66a364788d3e21840916446be91040a0a746db9f255e8a9243688a7b7f6d5ac'
const REDEEM_QTY = BigInt(process.env.REDEEM_QTY ?? 50_000)

const abi = parseAbi([
  'function requestRedemption(bytes32 lotId, uint64 qty) returns (bytes32)',
  'function openRedemptionOf(bytes32 lotId) view returns (bytes32)',
  'function lots(bytes32) view returns (address holder, address issuer, bytes32 instrument, uint64 qtyTokens, uint64 lockedTokens, uint64 expiry, uint128 notionalMicro)',
  'event RedemptionRequested(bytes32 indexed redemptionId, bytes32 indexed lotId, address indexed issuer, address holder, uint64 qtyTokens, uint64 deadline)',
])

const buyer = privateKeyToAccount(process.env.BUYER_KEY)
const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) })
const wallet = createWalletClient({ account: buyer, chain: baseSepolia, transport: http(RPC) })

const lotBefore = await pub.readContract({ address: SETTLEMENT, abi, functionName: 'lots', args: [LOT_ID] })
console.log('lot before:', { qtyTokens: lotBefore[3].toString(), notionalMicro: lotBefore[6].toString() })

// 1. Open the redemption on-chain (or resume the lot's open one).
let redemptionId = await pub.readContract({
  address: SETTLEMENT, abi, functionName: 'openRedemptionOf', args: [LOT_ID],
})
if (redemptionId === `0x${'0'.repeat(64)}`) {
  const tx = await wallet.writeContract({
    address: SETTLEMENT, abi, functionName: 'requestRedemption', args: [LOT_ID, REDEEM_QTY],
  })
  const rcpt = await pub.waitForTransactionReceipt({ hash: tx })
  const reqLog = rcpt.logs.find((l) => l.topics.length === 4)
  redemptionId = reqLog.topics[1]
  console.log('redemption opened:', redemptionId, 'tx:', tx)
} else {
  console.log('resuming open redemption:', redemptionId)
}

// 2. The issuer serves REAL inference through the Tangle Router. Serving is
// holder-gated: the request carries an EIP-712 ServeRequest signature binding
// this redemption, these exact message bytes, the token cap, and an expiry —
// knowing the (public) redemptionId alone cannot burn the holder's quota.
const messages = [{ role: 'user', content: 'In one sentence: why does an open market for surplus inference tokens make AI cheaper?' }]
const maxTokens = 120
const authExpiry = BigInt(Math.floor(Date.now() / 1000) + 300)
const authSignature = await buyer.signTypedData({
  domain: { name: 'SurplusServe', version: '1', chainId: baseSepolia.id, verifyingContract: SETTLEMENT },
  types: {
    ServeRequest: [
      { name: 'redemptionId', type: 'bytes32' },
      { name: 'messagesHash', type: 'bytes32' },
      { name: 'maxTokens', type: 'uint64' },
      { name: 'expiry', type: 'uint64' },
    ],
  },
  primaryType: 'ServeRequest',
  message: {
    redemptionId,
    messagesHash: keccak256(toBytes(JSON.stringify(messages))),
    maxTokens: BigInt(maxTokens),
    expiry: authExpiry,
  },
})
const serve = await (await fetch(`${VENUE}/redeem`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    redemptionId,
    messages,
    maxTokens,
    auth: { expiry: Number(authExpiry), signature: authSignature },
  }),
})).json()
if (!serve.completion) throw new Error('serve failed: ' + JSON.stringify(serve).slice(0, 300))
console.log('\n=== REAL COMPLETION (served from the credit) ===')
console.log(serve.completion.choices[0].message.content.trim())
console.log('================================================\n')
console.log('metered:', serve.meteredTokens, 'servedTokens:', serve.totalServedTokens, 'remaining quota:', serve.remainingQuota)

// 3. Holder signs the receipt as EIP-712 typed data (browser-wallet parity:
// the same signTypedData call works in MetaMask) and the issuer settles.
const receiptTyped = {
  domain: { name: 'SurplusSettlement', version: '1', chainId: baseSepolia.id, verifyingContract: SETTLEMENT },
  types: {
    RedemptionReceipt: [
      { name: 'redemptionId', type: 'bytes32' },
      { name: 'servedTokens', type: 'uint64' },
    ],
  },
  primaryType: 'RedemptionReceipt',
  message: { redemptionId, servedTokens: BigInt(serve.totalServedTokens) },
}
if (hashTypedData(receiptTyped) !== serve.receiptDigest) {
  throw new Error(`receipt digest mismatch: local ${hashTypedData(receiptTyped)} vs venue ${serve.receiptDigest}`)
}
const signature = await buyer.signTypedData(receiptTyped)
const settle = await (await fetch(`${VENUE}/redeem/receipt`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ redemptionId, servedTokens: serve.totalServedTokens, signature }),
})).json()
console.log('settled:', JSON.stringify(settle))

// 4. Verify on-chain: lot quota decremented at the locked price.
const lotAfter = await pub.readContract({ address: SETTLEMENT, abi, functionName: 'lots', args: [LOT_ID] })
console.log('lot after:', { qtyTokens: lotAfter[3].toString(), notionalMicro: lotAfter[6].toString() })
console.log('tokens consumed on-chain:', (lotBefore[3] - lotAfter[3]).toString())
