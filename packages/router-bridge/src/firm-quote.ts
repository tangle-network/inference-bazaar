/**
 * SurplusSettlement firm orders — the buyer-side mirror of
 * `crates/settlement-core` and `contracts/src/SurplusSettlement.sol`.
 *
 * A CLOB order and an RFQ quote are the same EIP-712 `Order`. This module
 * builds the typed data a wallet signs (viem `signTypedData` / EIP-1193
 * `eth_signTypedData_v4`); it deliberately carries no crypto deps, like
 * `spend-auth.ts`. Byte parity Rust<->Solidity is pinned by
 * crates/settlement/tests/parity.rs + contracts/test/Eip712Parity.t.sol;
 * this module's types are pinned to the same canonical type strings below.
 * Drift here is a fund-loss bug: change only in lockstep with the contract.
 */

export const SURPLUS_SETTLEMENT_DOMAIN = {
  name: 'SurplusSettlement',
  version: '1',
} as const

export const SIDE_BUY = 0
export const SIDE_SELL = 1

export const ORDER_TYPES = {
  Order: [
    { name: 'instrument', type: 'bytes32' },
    { name: 'side', type: 'uint8' },
    { name: 'priceMicroPerM', type: 'uint64' },
    { name: 'qtyTokens', type: 'uint64' },
    { name: 'lotId', type: 'bytes32' },
    { name: 'trader', type: 'address' },
    { name: 'expiry', type: 'uint64' },
    { name: 'salt', type: 'bytes32' },
  ],
} as const

export const RECEIPT_TYPES = {
  RedemptionReceipt: [
    { name: 'redemptionId', type: 'bytes32' },
    { name: 'servedTokens', type: 'uint64' },
  ],
} as const

export const BATCH_TYPES = {
  SettlementBatch: [
    { name: 'batchNonce', type: 'uint64' },
    { name: 'fillsHash', type: 'bytes32' },
  ],
} as const

/** The exact strings Solidity/Rust hash into typehashes — parity-pinned in tests. */
export const CANONICAL_TYPE_STRINGS = {
  Order:
    'Order(bytes32 instrument,uint8 side,uint64 priceMicroPerM,uint64 qtyTokens,bytes32 lotId,address trader,uint64 expiry,bytes32 salt)',
  RedemptionReceipt: 'RedemptionReceipt(bytes32 redemptionId,uint64 servedTokens)',
  SettlementBatch: 'SettlementBatch(uint64 batchNonce,bytes32 fillsHash)',
} as const

/** A firm order exactly as signed and as the operator's HTTP API expects it. */
export interface FirmOrder {
  /** keccak256(instrumentId), 0x-hex. */
  instrument: string
  side: typeof SIDE_BUY | typeof SIDE_SELL
  /** Limit price, micro-tsUSD per 1M tokens. */
  priceMicroPerM: bigint
  qtyTokens: bigint
  /** Sell side: lot to deliver from; zero hash mints against the seller's collateral. */
  lotId: string
  trader: string
  /** Unix seconds — the firm-quote TTL. */
  expiry: bigint
  /** Uniqueness/replay salt, 0x-hex 32 bytes. */
  salt: string
}

export const ZERO_LOT = `0x${'00'.repeat(32)}`

export function buildOrderMessage(order: FirmOrder, chainId: number, contractAddress: string) {
  return {
    domain: {
      ...SURPLUS_SETTLEMENT_DOMAIN,
      chainId,
      verifyingContract: contractAddress as `0x${string}`,
    },
    types: ORDER_TYPES,
    primaryType: 'Order' as const,
    message: {
      instrument: order.instrument as `0x${string}`,
      side: order.side,
      priceMicroPerM: order.priceMicroPerM,
      qtyTokens: order.qtyTokens,
      lotId: order.lotId as `0x${string}`,
      trader: order.trader as `0x${string}`,
      expiry: order.expiry,
      salt: order.salt as `0x${string}`,
    },
  }
}

export function buildReceiptMessage(
  redemptionId: string,
  servedTokens: bigint,
  chainId: number,
  contractAddress: string,
) {
  return {
    domain: {
      ...SURPLUS_SETTLEMENT_DOMAIN,
      chainId,
      verifyingContract: contractAddress as `0x${string}`,
    },
    types: RECEIPT_TYPES,
    primaryType: 'RedemptionReceipt' as const,
    message: {
      redemptionId: redemptionId as `0x${string}`,
      servedTokens,
    },
  }
}

/**
 * Fill notional in micro-tsUSD, rounded half-up — mirrors the contract's
 * `(execPrice * qty + 500_000) / 1_000_000` exactly.
 */
export function fillCostMicro(execPriceMicroPerM: bigint, qtyTokens: bigint): bigint {
  return (execPriceMicroPerM * qtyTokens + 500_000n) / 1_000_000n
}

// ── Operator HTTP wire types (POST /rfq, /rfq/fill, /order-signed) ───────────

export interface RfqRequest {
  instrumentId: string
  /** The requester's side: 'buy' crosses the operator's ask, 'sell' its bid. */
  side: 'buy' | 'sell'
  qtyTokens: number
}

/**
 * Wire shape of a firm order in operator responses — what the Rust operator
 * emits as JSON (serde u64 -> JSON number).
 *
 * The uint64 fields are typed `number` to match that emission, NOT `bigint`:
 * the SIGNING path ({@link FirmOrder}/{@link buildOrderMessage}) uses `bigint`
 * and is the source of truth. These wire numbers are only ever round-tripped
 * back to the operator, which re-verifies the signature — so any value above
 * `Number.MAX_SAFE_INTEGER` (2^53) would corrupt and the operator would REJECT
 * the order (fail-closed: a rejected fill, never a mis-settled one). Current
 * pricing (micro-tsUSD/M ~1e7), quantities (~1e6), and expiries (~2e9) sit far
 * below 2^53, so this is a documented bound, not a live risk. If uint64 values
 * could ever approach 2^53, carry these three fields as decimal strings and add
 * a matching string-or-int deserializer on the operator side.
 */
export interface FirmOrderWire {
  instrument: string
  side: number
  priceMicroPerM: number
  qtyTokens: number
  lotId: string
  trader: string
  expiry: number
  salt: string
}

export interface RfqQuoteResponse {
  quoting: boolean
  instrumentId?: string
  order?: FirmOrderWire
  signature?: string
  digest?: string
  validUntil?: number
  rationale?: string
  reasons?: string[]
}

export interface SignedOrderBody {
  instrumentId: string
  order: FirmOrderWire
  signature: string
}

export interface RfqFillRequest {
  maker: SignedOrderBody
  taker: SignedOrderBody
}

/** Hit a firm quote: countersign and cross at the venue. */
export async function fillRfqQuote(
  venueUrl: string,
  body: RfqFillRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const res = await fetchImpl(`${venueUrl}/rfq/fill`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(`rfq/fill failed: ${res.status} ${await res.text()}`)
  }
  return res.json()
}
