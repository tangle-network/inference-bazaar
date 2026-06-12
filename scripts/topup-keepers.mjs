// Top up the fleet keeper wallets with Base Sepolia gas from FUNDER_KEY.
// Usage: FUNDER_KEY=0x... [AMOUNT_WEI=400000000000000] node scripts/topup-keepers.mjs
import { createWalletClient, createPublicClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'

const RPC = process.env.RPC ?? 'https://base-sepolia-rpc.publicnode.com'
const AMOUNT = BigInt(process.env.AMOUNT_WEI ?? 400_000_000_000_000n) // 0.0004 ETH
const KEEPERS = [
  '0x2420FFf17c4213A4075cf5f7B6dc33429Aaf22Bb', // service 3 / deployer
  '0x483fA87BE29E007bc21349A1fE9380CAf1f4Bb48', // service 4
]
if (!process.env.FUNDER_KEY) throw new Error('FUNDER_KEY required')

const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) })
const wallet = createWalletClient({
  account: privateKeyToAccount(process.env.FUNDER_KEY),
  chain: baseSepolia,
  transport: http(RPC),
})

for (const to of KEEPERS) {
  const before = await pub.getBalance({ address: to })
  const hash = await wallet.sendTransaction({ to, value: AMOUNT })
  await pub.waitForTransactionReceipt({ hash })
  console.log(`${to}: ${before} -> ${await pub.getBalance({ address: to })} wei (${hash})`)
}
