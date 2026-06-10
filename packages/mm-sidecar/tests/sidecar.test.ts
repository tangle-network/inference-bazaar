import { afterEach, describe, expect, it } from 'vitest'
import { listenSidecar, type ListeningSidecar } from '../src/server'

const params = {
  gamma: 0.0000015,
  sigma: 22_500,
  horizonTicks: 120,
  k: 1.5,
  size: 50_000,
  maxInventory: 300_000,
  tickSize: 1000,
}
const limits = {
  maxInventory: 400_000,
  maxQuoteNotional: 2_000_000_000,
  maxDeviationBps: 300,
  minSpreadBps: 2,
  killSwitchDrawdown: 5_000_000,
}

let sidecar: ListeningSidecar
afterEach(async () => {
  if (sidecar) await sidecar.close()
})

async function post(
  port: number,
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, any> }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, any> }
}

describe('mm-sidecar HTTP server', () => {
  it('serves /health', async () => {
    sidecar = await listenSidecar(0)
    const res = await fetch(`http://127.0.0.1:${sidecar.port}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('returns risk-gated two-sided quotes for a flat book', async () => {
    sidecar = await listenSidecar(0)
    const { status, body } = await post(sidecar.port, '/quote', {
      instrumentId: 'anthropic/claude-opus-4-8:output',
      refMid: 15_000_000,
      inventoryTokens: 0,
      drawdownMicro: 0,
      params,
      limits,
    })
    expect(status).toBe(200)
    expect(body.valid).toBe(true)
    expect(body.bid.price).toBeLessThan(15_000_000)
    expect(body.ask.price).toBeGreaterThan(15_000_000)
    expect(body.killSwitch).toBe(false)
  })

  it('reports the kill switch on drawdown (operator must not quote)', async () => {
    sidecar = await listenSidecar(0)
    const { body } = await post(sidecar.port, '/quote', {
      instrumentId: 'x',
      refMid: 15_000_000,
      inventoryTokens: 0,
      drawdownMicro: 9_000_000,
      params,
      limits,
    })
    expect(body.killSwitch).toBe(true)
    expect(body.valid).toBe(false)
  })

  it('rejects malformed quote requests with 422', async () => {
    sidecar = await listenSidecar(0)
    const { status, body } = await post(sidecar.port, '/quote', { instrumentId: 'x' })
    expect(status).toBe(422)
    expect(body.error).toMatch(/refMid|params|object/)
  })

  it('404s unknown routes', async () => {
    sidecar = await listenSidecar(0)
    const res = await fetch(`http://127.0.0.1:${sidecar.port}/nope`)
    expect(res.status).toBe(404)
  })
})
