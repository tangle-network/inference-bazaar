import { describe, expect, it } from 'vitest'
import * as bridge from '@inference-bazaar/router-bridge'
import * as sdk from '@tangle-network/tcloud/shielded'
import { recoverTypedDataAddress, type Hex } from 'viem'

describe('published Router SDK contract adoption', () => {
  it('uses the same signing implementation and produces recoverable settlement wire', async () => {
    expect(bridge.buildSpendAuthMessage).toBe(sdk.buildSpendAuthMessage)
    expect(bridge.SPEND_AUTH_TYPES).toBe(sdk.SPEND_AUTH_TYPES)
    expect(bridge.SHIELDED_CREDITS_DOMAIN).toBe(sdk.SHIELDED_CREDITS_DOMAIN)
    const wallet = sdk.generateWallet()
    const params = { commitment: wallet.commitment, serviceId: 7n, jobIndex: 3,
      amount: 1_500_000n, operator: `0x${'cd'.repeat(20)}` as Hex, nonce: 42n, expiry: 1_900_000_000n }
    const chainId = bridge.TANGLE_CHAIN_IDS.mainnet, creditsAddress = `0x${'ef'.repeat(20)}` as Hex
    const signed = await sdk.signSpendAuth(wallet, { ...params, chainId, creditsAddress })
    const wire = JSON.parse(JSON.stringify(signed))
    const typed = bridge.buildSpendAuthMessage({ ...wire, serviceId: BigInt(wire.serviceId),
      amount: BigInt(wire.amount), nonce: BigInt(wire.nonce), expiry: BigInt(wire.expiry) }, chainId, creditsAddress)
    expect((await recoverTypedDataAddress({ ...typed, signature: wire.signature })).toLowerCase()).toBe(wallet.address.toLowerCase())
  })
})
