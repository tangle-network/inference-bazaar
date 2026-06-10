/**
 * ShieldedCredits SpendAuth — mirror of tangle-router's
 * `lib/shielded/spend-auth.ts` EIP-712 surface, so marketplace settlement
 * (buying a token lot, claiming a maker payout) signs byte-identical typed
 * data to what operators and the ShieldedCredits contract already verify.
 * Drift here is a fund-loss bug: change only in lockstep with the router.
 */

export const SHIELDED_CREDITS_DOMAIN = {
  name: 'ShieldedCredits',
  version: '1',
} as const

export const SPEND_AUTH_TYPES = {
  SpendAuthorization: [
    { name: 'commitment', type: 'bytes32' },
    { name: 'serviceId', type: 'uint64' },
    { name: 'jobIndex', type: 'uint8' },
    { name: 'amount', type: 'uint256' },
    { name: 'operator', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiry', type: 'uint64' },
  ],
} as const

export interface SpendAuthPayload {
  /** bytes32 — shielded credit account id. */
  commitment: string
  serviceId: bigint
  /** Request counter within a session. */
  jobIndex: number
  /** Authorized spend, base units (tsUSD, 6 decimals). */
  amount: bigint
  /** Payee operator address. */
  operator: string
  /** Per-account monotonic counter — replay protection. */
  nonce: bigint
  /** Unix seconds expiry. */
  expiry: bigint
  /** 65-byte EIP-712 signature, hex. */
  signature: string
}

export const TANGLE_CHAIN_IDS = { testnet: 3799, mainnet: 5845 } as const

export function buildSpendAuthMessage(
  params: Omit<SpendAuthPayload, 'signature'>,
  chainId: number,
  contractAddress: string,
) {
  return {
    domain: {
      ...SHIELDED_CREDITS_DOMAIN,
      chainId,
      verifyingContract: contractAddress as `0x${string}`,
    },
    types: SPEND_AUTH_TYPES,
    primaryType: 'SpendAuthorization' as const,
    message: {
      commitment: params.commitment as `0x${string}`,
      serviceId: params.serviceId,
      jobIndex: params.jobIndex,
      amount: params.amount,
      operator: params.operator as `0x${string}`,
      nonce: params.nonce,
      expiry: params.expiry,
    },
  }
}

/** Cost of `qty` tokens at `priceMicroPerM` micro-tsUSD per 1M tokens, in base units. */
export function tokenLotCostBaseUnits(priceMicroPerM: number, qtyTokens: number): bigint {
  return BigInt(Math.ceil((priceMicroPerM * qtyTokens) / 1_000_000))
}
