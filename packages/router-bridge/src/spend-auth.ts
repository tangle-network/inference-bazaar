export {
  SHIELDED_CREDITS_DOMAIN, SPEND_AUTH_TYPES, buildSpendAuthMessage,
  type SpendAuthPayload,
} from '@tangle-network/tcloud/shielded'

export const TANGLE_CHAIN_IDS = { testnet: 3799, mainnet: 5845 } as const

/** Cost of `qty` tokens at `priceMicroPerM` micro-tsUSD per 1M tokens, in base units. */
export function tokenLotCostBaseUnits(priceMicroPerM: number, qtyTokens: number): bigint {
  return BigInt(Math.ceil((priceMicroPerM * qtyTokens) / 1_000_000))
}
