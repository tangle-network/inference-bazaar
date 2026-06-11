import { describe, expect, it } from 'vitest'
import { runDiscountCapture, type DiscountCaptureConfig } from '../src/discount'

const KIMI = {
  id: 'moonshot/kimi-k2.6:output',
  modelId: 'moonshot/kimi-k2.6',
  tokenKind: 'output' as const,
  tickSize: 1_000, // $0.001 per 1M tokens
  minQty: 1_000,
}

/** $2.50/M list; dumps average 300bps under; lift at ≥150bps; re-offer at 50bps under. */
function config(overrides: Partial<DiscountCaptureConfig> = {}): DiscountCaptureConfig {
  return {
    instrument: KIMI,
    seeds: [1, 2, 3, 4, 5, 6, 7, 8],
    horizonTicks: 500,
    ref: { initial: 2_500_000, driftPerTick: 0, volPerTick: 0.001 },
    dump: { probPerTick: 0.15, sizeMean: 200_000, discountBpsMean: 300 },
    takers: { intensity: 1.2, sizeMean: 80_000, aggressionBps: 30 },
    strategy: { minEdgeBps: 150, resellDiscountBps: 50, maxInventory: 2_000_000 },
    ...overrides,
  }
}

describe('discount capture', () => {
  it('captures positive discount on every seed, worst seed included', () => {
    const result = runDiscountCapture(config())
    expect(result.sessions).toHaveLength(8)
    for (const s of result.sessions) {
      expect(s.tokensBought).toBeGreaterThan(0)
      expect(s.discountAtBuyMicro).toBeGreaterThan(0) // every acquisition was below ref
      expect(s.equityCaptureMicro).toBeGreaterThan(0)
    }
    expect(result.captureMinMicro).toBeGreaterThan(0)
    expect(result.captureMeanMicro).toBeGreaterThan(0)
    expect(result.resoldFraction).toBeGreaterThan(0.5) // inventory actually turns over
  })

  it('isolates the discount channel: no dumps below the edge → no trades, zero PnL', () => {
    // Dumps at ~50bps mean never clear the 150bps lift threshold.
    const result = runDiscountCapture(config({ dump: { probPerTick: 0.15, sizeMean: 200_000, discountBpsMean: 40 } }))
    for (const s of result.sessions) {
      expect(s.tokensBought).toBe(0)
      expect(s.equityCaptureMicro).toBe(0)
    }
    expect(result.resoldFraction).toBe(0)
  })

  it('money + tokens conserved per session', () => {
    const result = runDiscountCapture(config({ seeds: [42] }))
    const s = result.sessions[0]!
    expect(s.tokensBought).toBe(s.tokensResold + s.residualTokens)
    // equity == proceeds − cost + residual mark: nothing minted, nothing lost
    expect(s.equityCaptureMicro).toBe(s.proceedsMicro - s.costMicro + s.residualMarkMicro)
  })

  it('rejects a policy whose resale undercuts its own acquisition edge', () => {
    expect(() =>
      runDiscountCapture(config({ strategy: { minEdgeBps: 50, resellDiscountBps: 100, maxInventory: 1 } })),
    ).toThrow(/must exceed/)
  })

  it('determinism: identical config → identical result', () => {
    expect(runDiscountCapture(config())).toEqual(runDiscountCapture(config()))
  })
})
