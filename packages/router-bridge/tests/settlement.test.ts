import { describe, expect, it, vi } from 'vitest'
import {
  RouterCreditsRail,
  type RouterSettlementPort,
  SettlementRouter,
  ShieldedRail,
  type ShieldedChainPort,
  splitFee,
} from '../src/settlement'
import type { SpendAuthPayload } from '../src/spend-auth'

const spendAuth = (amount: bigint): SpendAuthPayload => ({
  commitment: `0x${'ab'.repeat(32)}`,
  serviceId: 1n,
  jobIndex: 0,
  amount,
  operator: `0x${'cd'.repeat(20)}`,
  nonce: 0n,
  expiry: 9_999_999_999n,
  signature: '0x',
})

describe('splitFee', () => {
  it('splits operator cut vs platform take (default 20%)', () => {
    expect(splitFee(1_000_000n)).toEqual({ operator: 800_000n, platform: 200_000n })
    expect(splitFee(1_000_000n, { platformTakeBps: 0 })).toEqual({
      operator: 1_000_000n,
      platform: 0n,
    })
    expect(() => splitFee(1n, { platformTakeBps: 10_001 })).toThrow(/range/)
  })
})

describe('RouterCreditsRail', () => {
  it('deducts the buyer and credits the operator their cut', async () => {
    const port: RouterSettlementPort = {
      deduct: vi.fn(async () => 'platform-txn-1'),
      credit: vi.fn(async () => {}),
    }
    const rail = new RouterCreditsRail(port)
    // 100k tokens @ 15_000_000 micro/M = 1_500_000 base units = $1.50
    const receipt = await rail.settle({
      orderId: 'o1',
      rail: 'router-credits',
      buyer: 'user_42',
      operator: 'op_alpha',
      instrumentId: 'anthropic/claude-opus-4-8:output',
      qtyTokens: 100_000,
      priceMicroPerM: 15_000_000,
    })
    expect(receipt.amountBaseUnits).toBe(1_500_000n)
    expect(receipt.operatorBaseUnits).toBe(1_200_000n)
    expect(receipt.platformBaseUnits).toBe(300_000n)
    expect(receipt.ref).toBe('platform-txn-1')
    expect(port.deduct).toHaveBeenCalledWith('user_42', 1_500_000n, 'surplus:o1')
    expect(port.credit).toHaveBeenCalledWith('op_alpha', 1_200_000n, 'surplus:o1')
  })
})

describe('ShieldedRail', () => {
  it('authorizes then claims, returning the claim tx hash', async () => {
    const chain: ShieldedChainPort = {
      authorizeSpend: vi.fn(async () => '0xauthhash'),
      claimPayment: vi.fn(async () => '0xclaimtx'),
    }
    const rail = new ShieldedRail(chain)
    const receipt = await rail.settle({
      orderId: 'o2',
      rail: 'shielded',
      buyer: `0x${'ab'.repeat(32)}`,
      operator: `0x${'cd'.repeat(20)}`,
      instrumentId: 'anthropic/claude-opus-4-8:output',
      qtyTokens: 100_000,
      priceMicroPerM: 15_000_000,
      spendAuth: spendAuth(2_000_000n),
    })
    expect(receipt.amountBaseUnits).toBe(1_500_000n)
    expect(receipt.ref).toBe('0xclaimtx')
    expect(chain.authorizeSpend).toHaveBeenCalledOnce()
    expect(chain.claimPayment).toHaveBeenCalledWith('0xauthhash', `0x${'cd'.repeat(20)}`)
  })

  it('rejects an order whose spendAuth under-authorizes the fill', async () => {
    const chain: ShieldedChainPort = {
      authorizeSpend: vi.fn(async () => '0x'),
      claimPayment: vi.fn(async () => '0x'),
    }
    const rail = new ShieldedRail(chain)
    await expect(
      rail.settle({
        orderId: 'o3',
        rail: 'shielded',
        buyer: '0x',
        operator: '0x',
        instrumentId: 'x',
        qtyTokens: 100_000,
        priceMicroPerM: 15_000_000,
        spendAuth: spendAuth(1_000_000n), // < 1_500_000 required
      }),
    ).rejects.toThrow(/authorizes/)
    expect(chain.authorizeSpend).not.toHaveBeenCalled()
  })
})

describe('SettlementRouter', () => {
  it('dispatches each order to the rail it names — both first-class', async () => {
    const routerPort: RouterSettlementPort = {
      deduct: vi.fn(async () => 'txn'),
      credit: vi.fn(async () => {}),
    }
    const chain: ShieldedChainPort = {
      authorizeSpend: vi.fn(async () => '0xauth'),
      claimPayment: vi.fn(async () => '0xtx'),
    }
    const router = new SettlementRouter(
      new RouterCreditsRail(routerPort),
      new ShieldedRail(chain),
    )

    const viaRouter = await router.settle({
      orderId: 'r',
      rail: 'router-credits',
      buyer: 'u',
      operator: 'op',
      instrumentId: 'x',
      qtyTokens: 1_000_000,
      priceMicroPerM: 3_000_000,
    })
    expect(viaRouter.rail).toBe('router-credits')
    expect(routerPort.deduct).toHaveBeenCalledOnce()

    const viaShielded = await router.settle({
      orderId: 's',
      rail: 'shielded',
      buyer: '0x',
      operator: '0x',
      instrumentId: 'x',
      qtyTokens: 1_000_000,
      priceMicroPerM: 3_000_000,
      spendAuth: spendAuth(5_000_000n),
    })
    expect(viaShielded.rail).toBe('shielded')
    expect(chain.authorizeSpend).toHaveBeenCalledOnce()
  })
})
