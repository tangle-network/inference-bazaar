// E2E proof: a fresh buyer buys 1M Sonnet output tokens firm, settled on Base Sepolia.
import { createPublicClient, createWalletClient, http, parseAbi, keccak256, toHex, zeroHash } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ephemeralKey } from './_keys.mjs'
import { baseSepolia } from 'viem/chains'

const RPC = process.env.RPC ?? 'https://sepolia.base.org'
const VENUE = process.env.VENUE ?? 'https://surplus.178.104.232.124.sslip.io'
const SETTLEMENT = process.env.SETTLEMENT ?? '0x64867eacf2e4581d182c2Be634cfD7fF3D3d9f83'
const USD = process.env.USD ?? '0x14Ff9231D03Fd9AD75e553004585f13Ff51db630'
// 'mint' (test tsUSD, open mint) or 'transfer' (real USDC: the funder pays).
const FUND_MODE = process.env.FUND_MODE ?? 'mint'
const FUNDER_KEY = process.env.FUNDER_KEY // gas (and USDC when FUND_MODE=transfer)

const settlementAbi = parseAbi([
  'function deposit(uint256 amount)',
  'function balances(address) view returns (uint256)',
  'function lots(bytes32) view returns (address holder, address issuer, bytes32 instrument, uint64 qtyTokens, uint64 lockedTokens, uint64 expiry, uint128 notionalMicro)',
])
const usdAbi = parseAbi([
  'function mint(address to, uint256 amount)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
])

const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) })
const fs = await import('node:fs')
const buyerKey = ephemeralKey('firm-buyer')
const buyer = privateKeyToAccount(buyerKey)
const wallet = createWalletClient({ account: buyer, chain: baseSepolia, transport: http(RPC) })
const funder = createWalletClient({ account: privateKeyToAccount(FUNDER_KEY), chain: baseSepolia, transport: http(RPC) })

console.log('buyer:', buyer.address)

// Gas for the buyer's funding txs (skip if already funded).
let tx
if ((await pub.getBalance({ address: buyer.address })) < 100000000000000n) {
  tx = await funder.sendTransaction({ to: buyer.address, value: 200000000000000n })
  await pub.waitForTransactionReceipt({ hash: tx })
}

const INSTRUMENT = process.env.INSTRUMENT ?? 'claude-sonnet-4-6:output'
const QTY = Number(process.env.QTY ?? 1_000_000)

// 1. Firm quote from the live operator.
const rfq = await (await fetch(`${VENUE}/rfq`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instrumentId: INSTRUMENT, side: 'buy', qtyTokens: QTY }),
})).json()
if (!rfq.quoting) throw new Error('not quoting: ' + JSON.stringify(rfq))
console.log('maker quote:', rfq.order.priceMicroPerM, 'micro/1M, signed by', rfq.order.trader)

const costMicro = BigInt(Math.round((rfq.order.priceMicroPerM * QTY) / 1e6))

// 2. Fund: mint (test token) or real transfer from the funder, then approve + deposit.
if ((await pub.readContract({ address: USD, abi: usdAbi, functionName: 'balanceOf', args: [buyer.address] })) < costMicro) {
  if (FUND_MODE === 'transfer') {
    tx = await funder.writeContract({ address: USD, abi: usdAbi, functionName: 'transfer', args: [buyer.address, costMicro] })
  } else {
    tx = await wallet.writeContract({ address: USD, abi: usdAbi, functionName: 'mint', args: [buyer.address, costMicro] })
  }
  await pub.waitForTransactionReceipt({ hash: tx })
}
tx = await wallet.writeContract({ address: USD, abi: usdAbi, functionName: 'approve', args: [SETTLEMENT, costMicro] })
await pub.waitForTransactionReceipt({ hash: tx })
tx = await wallet.writeContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'deposit', args: [costMicro] })
await pub.waitForTransactionReceipt({ hash: tx })
console.log('deposited', costMicro.toString(), 'micro tsUSD')

// 3. Sign the matching taker order (EIP-712).
const taker = {
  instrument: keccak256(toHex(INSTRUMENT)),
  side: 0,
  priceMicroPerM: rfq.order.priceMicroPerM,
  qtyTokens: QTY,
  lotId: zeroHash,
  trader: buyer.address,
  expiry: rfq.order.expiry,
  salt: keccak256(toHex('e2e-proof-' + Date.now())),
}
const signature = await wallet.signTypedData({
  domain: { name: 'SurplusSettlement', version: '1', chainId: baseSepolia.id, verifyingContract: SETTLEMENT },
  types: { Order: [
    { name: 'instrument', type: 'bytes32' }, { name: 'side', type: 'uint8' },
    { name: 'priceMicroPerM', type: 'uint64' }, { name: 'qtyTokens', type: 'uint64' },
    { name: 'lotId', type: 'bytes32' }, { name: 'trader', type: 'address' },
    { name: 'expiry', type: 'uint64' }, { name: 'salt', type: 'bytes32' },
  ]},
  primaryType: 'Order',
  message: { ...taker, priceMicroPerM: BigInt(taker.priceMicroPerM), qtyTokens: BigInt(taker.qtyTokens), expiry: BigInt(taker.expiry) },
})

// 4. Pair the fill on the venue, then flush on-chain.
const fill = await (await fetch(`${VENUE}/rfq/fill`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    maker: { instrumentId: INSTRUMENT, order: rfq.order, signature: rfq.signature },
    taker: { instrumentId: INSTRUMENT, order: taker, signature },
  }),
})).json()
console.log('paired:', JSON.stringify(fill).slice(0, 200))

const flush = await (await fetch(`${VENUE}/settlement/flush`, { method: 'POST' })).json()
console.log('flush:', JSON.stringify(flush))

// 5. Verify on-chain: balance debited, lot minted to buyer.
const bal = await pub.readContract({ address: SETTLEMENT, abi: settlementAbi, functionName: 'balances', args: [buyer.address] })
console.log('buyer settlement balance after:', bal.toString())
