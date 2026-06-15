import { describe, expect, it } from 'vitest'
import {
  BATCH_TYPES,
  buildBatchMessage,
  buildOrderMessage,
  buildReceiptMessage,
  buildServeMessage,
  CANONICAL_TYPE_STRINGS,
  fillCostMicro,
  ORDER_TYPES,
  RECEIPT_TYPES,
  SERVE_TYPES,
  SIDE_BUY,
  ZERO_LOT,
  type FirmOrder,
} from '../src/firm-quote'

/** Rebuild the EIP-712 type string a wallet will hash from a types object. */
function typeString(name: string, fields: readonly { name: string; type: string }[]): string {
  return `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(',')})`
}

// The canonical typehash preimages, pinned INDEPENDENTLY here (these exact
// strings are the typehash inputs in contracts/src/InferenceBazaarSettlement.sol,
// crates/settlement-core/src/lib.rs, and operator/src/redeem.rs). Asserting the
// types objects against these literals — NOT against CANONICAL_TYPE_STRINGS,
// which lives in the same module — is what catches a real drift (e.g. a missing
// bookId in SettlementBatch) instead of a tautology.
const PINNED = {
  Order:
    'Order(bytes32 instrument,uint8 side,uint64 priceMicroPerM,uint64 qtyTokens,bytes32 lotId,address trader,uint64 expiry,bytes32 salt)',
  RedemptionReceipt: 'RedemptionReceipt(bytes32 redemptionId,uint64 servedTokens,bytes32 workCommitment)',
  SettlementBatch: 'SettlementBatch(bytes32 bookId,uint64 batchNonce,bytes32 fillsHash)',
  ServeRequest: 'ServeRequest(bytes32 redemptionId,bytes32 messagesHash,uint64 maxTokens,uint64 expiry)',
} as const

describe('EIP-712 type parity with InferenceBazaarSettlement.sol / settlement-core', () => {
  // Each types object must produce the canonical typehash preimage byte-for-byte,
  // AND the module's own CANONICAL_TYPE_STRINGS must equal the same literal — so
  // a wallet, the contract, and the Rust core all hash identical typehashes.
  it('Order', () => {
    expect(typeString('Order', ORDER_TYPES.Order)).toBe(PINNED.Order)
    expect(CANONICAL_TYPE_STRINGS.Order).toBe(PINNED.Order)
  })

  it('RedemptionReceipt (commits workCommitment)', () => {
    expect(typeString('RedemptionReceipt', RECEIPT_TYPES.RedemptionReceipt)).toBe(PINNED.RedemptionReceipt)
    expect(CANONICAL_TYPE_STRINGS.RedemptionReceipt).toBe(PINNED.RedemptionReceipt)
  })

  it('SettlementBatch (commits bookId)', () => {
    expect(typeString('SettlementBatch', BATCH_TYPES.SettlementBatch)).toBe(PINNED.SettlementBatch)
    expect(CANONICAL_TYPE_STRINGS.SettlementBatch).toBe(PINNED.SettlementBatch)
  })

  it('ServeRequest', () => {
    expect(typeString('ServeRequest', SERVE_TYPES.ServeRequest)).toBe(PINNED.ServeRequest)
    expect(CANONICAL_TYPE_STRINGS.ServeRequest).toBe(PINNED.ServeRequest)
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
      name: 'InferenceBazaarSettlement',
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

  it('builds work-committed redemption receipts', () => {
    const msg = buildReceiptMessage(
      '0x' + '01'.repeat(32),
      20_000n,
      '0x' + '77'.repeat(32),
      3799,
      '0x' + '11'.repeat(20),
    )
    expect(msg.primaryType).toBe('RedemptionReceipt')
    expect(msg.message.servedTokens).toBe(20_000n)
    expect(msg.message.workCommitment).toBe('0x' + '77'.repeat(32))
    expect(Object.keys(msg.message)).toEqual(RECEIPT_TYPES.RedemptionReceipt.map((f) => f.name))
  })

  it('builds batch messages with bookId', () => {
    const msg = buildBatchMessage('0x' + 'b0'.repeat(32), 0n, '0x' + 'fa'.repeat(32), 3799, '0x' + '11'.repeat(20))
    expect(msg.primaryType).toBe('SettlementBatch')
    expect(Object.keys(msg.message)).toEqual(BATCH_TYPES.SettlementBatch.map((f) => f.name))
  })

  it('builds serve requests under the InferenceBazaarServe domain', () => {
    const msg = buildServeMessage('0x' + '01'.repeat(32), '0x' + '02'.repeat(32), 1024n, 1_900_000_000n, 3799, '0x' + '11'.repeat(20))
    expect(msg.domain.name).toBe('InferenceBazaarServe')
    expect(msg.primaryType).toBe('ServeRequest')
  })
})

describe('fillCostMicro', () => {
  it('rounds half-up like the contract and Fill::notional_micro', () => {
    expect(fillCostMicro(15_000_000n, 50_000n)).toBe(750_000n)
    expect(fillCostMicro(1_000n, 1_500n)).toBe(2n) // 1.5 -> 2
    expect(fillCostMicro(1_000n, 1_400n)).toBe(1n) // 1.4 -> 1
  })
})
