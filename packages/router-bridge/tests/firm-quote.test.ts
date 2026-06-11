import { describe, expect, it } from 'vitest'
import {
  BATCH_TYPES,
  buildOrderMessage,
  buildReceiptMessage,
  CANONICAL_TYPE_STRINGS,
  fillCostMicro,
  ORDER_TYPES,
  RECEIPT_TYPES,
  SIDE_BUY,
  ZERO_LOT,
  type FirmOrder,
} from '../src/firm-quote'

/** Rebuild the EIP-712 type string a wallet will hash from a types object. */
function typeString(name: string, fields: readonly { name: string; type: string }[]): string {
  return `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(',')})`
}

describe('EIP-712 type parity with SurplusSettlement.sol / settlement-core', () => {
  // The wallet derives the typehash from the types object; if these strings
  // match the canonical ones (pinned byte-for-byte against Solidity and Rust
  // in their parity tests), wallet signatures verify on-chain.
  it('Order type string matches the contract typehash preimage', () => {
    expect(typeString('Order', ORDER_TYPES.Order)).toBe(CANONICAL_TYPE_STRINGS.Order)
  })

  it('RedemptionReceipt type string matches', () => {
    expect(typeString('RedemptionReceipt', RECEIPT_TYPES.RedemptionReceipt)).toBe(
      CANONICAL_TYPE_STRINGS.RedemptionReceipt,
    )
  })

  it('SettlementBatch type string matches', () => {
    expect(typeString('SettlementBatch', BATCH_TYPES.SettlementBatch)).toBe(
      CANONICAL_TYPE_STRINGS.SettlementBatch,
    )
  })
})

describe('buildOrderMessage', () => {
  const order: FirmOrder = {
    instrument: '0x' + 'ab'.repeat(32),
    side: SIDE_BUY,
    priceMicroPerM: 15_000_000n,
    qtyTokens: 50_000n,
    lotId: ZERO_LOT,
    trader: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    expiry: 1_900_000_000n,
    salt: '0x' + '00'.repeat(31) + 'aa',
  }

  it('assembles domain + message for eth_signTypedData_v4', () => {
    const msg = buildOrderMessage(order, 3799, '0x1111111111111111111111111111111111111111')
    expect(msg.domain).toEqual({
      name: 'SurplusSettlement',
      version: '1',
      chainId: 3799,
      verifyingContract: '0x1111111111111111111111111111111111111111',
    })
    expect(msg.primaryType).toBe('Order')
    expect(msg.message.side).toBe(0)
    expect(msg.message.priceMicroPerM).toBe(15_000_000n)
    // Field order in the message follows the type definition.
    expect(Object.keys(msg.message)).toEqual(ORDER_TYPES.Order.map((f) => f.name))
  })

  it('builds redemption receipts', () => {
    const msg = buildReceiptMessage('0x' + '01'.repeat(32), 20_000n, 3799, '0x' + '11'.repeat(20))
    expect(msg.primaryType).toBe('RedemptionReceipt')
    expect(msg.message.servedTokens).toBe(20_000n)
  })
})

describe('fillCostMicro', () => {
  it('rounds half-up like the contract and Fill::notional_micro', () => {
    expect(fillCostMicro(15_000_000n, 50_000n)).toBe(750_000n)
    expect(fillCostMicro(1_000n, 1_500n)).toBe(2n) // 1.5 -> 2
    expect(fillCostMicro(1_000n, 1_400n)).toBe(1n) // 1.4 -> 1
  })
})
