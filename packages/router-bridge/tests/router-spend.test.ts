import { describe, expect, it } from 'vitest'
import {
  RouterClient,
  usdPerTokenToMicroPerM,
} from '../src/router-client'
import { buildSpendAuthMessage, tokenLotCostBaseUnits, TANGLE_CHAIN_IDS } from '../src/spend-auth'

describe('usdPerTokenToMicroPerM', () => {
  it('converts OpenRouter USD-per-token strings to micro-tsUSD per 1M tokens', () => {
    // $0.000015/token = $15/M = 15_000_000 micro-tsUSD/M
    expect(usdPerTokenToMicroPerM('0.000015')).toBe(15_000_000)
    expect(usdPerTokenToMicroPerM('0.000003')).toBe(3_000_000)
    expect(usdPerTokenToMicroPerM(undefined)).toBeUndefined()
    expect(usdPerTokenToMicroPerM('not-a-number')).toBeUndefined()
  })
})

describe('RouterClient', () => {
  const fetchStub = (body: unknown): typeof fetch =>
    (async () =>
      ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => body,
      }) as Response) as unknown as typeof fetch

  it('derives a reference quote from the model catalog', async () => {
    const client = new RouterClient({
      baseUrl: 'https://router.test',
      fetchImpl: fetchStub({
        data: [
          {
            id: 'anthropic/claude-opus-4-8',
            pricing: { prompt: '0.000005', completion: '0.000025' },
          },
        ],
      }),
    })
    const quote = await client.referenceQuote('anthropic/claude-opus-4-8')
    expect(quote).toEqual({
      modelId: 'anthropic/claude-opus-4-8',
      inputMicroPerM: 5_000_000,
      outputMicroPerM: 25_000_000,
    })
    expect(await client.referenceQuote('missing/model')).toBeUndefined()
  })

  it('normalizes both operator response shapes', async () => {
    const arrayClient = new RouterClient({
      baseUrl: 'https://router.test',
      fetchImpl: fetchStub([{ id: '1', slug: 'op', name: 'Op', status: 'active', endpointUrl: 'https://op' }]),
    })
    expect(await arrayClient.operators()).toHaveLength(1)
    const wrappedClient = new RouterClient({
      baseUrl: 'https://router.test',
      fetchImpl: fetchStub({ operators: [{ id: '1', slug: 'op', name: 'Op', status: 'active', endpointUrl: 'https://op' }] }),
    })
    expect(await wrappedClient.operators()).toHaveLength(1)
  })
})

describe('SpendAuth', () => {
  it('builds EIP-712 typed data matching the router contract surface', () => {
    const msg = buildSpendAuthMessage(
      {
        commitment: `0x${'ab'.repeat(32)}`,
        serviceId: 7n,
        jobIndex: 3,
        amount: 1_500_000n,
        operator: `0x${'cd'.repeat(20)}`,
        nonce: 42n,
        expiry: 1_900_000_000n,
      },
      TANGLE_CHAIN_IDS.mainnet,
      `0x${'ef'.repeat(20)}`,
    )
    expect(msg.domain.name).toBe('ShieldedCredits')
    expect(msg.domain.chainId).toBe(5845)
    expect(msg.primaryType).toBe('SpendAuthorization')
    expect(msg.message.amount).toBe(1_500_000n)
    expect(msg.types.SpendAuthorization[0]).toEqual({ name: 'commitment', type: 'bytes32' })
  })

  it('prices a token lot in shielded base units', () => {
    // 100k tokens at 15_000_000 micro/M = 1_500_000 base units = $1.50
    expect(tokenLotCostBaseUnits(15_000_000, 100_000)).toBe(1_500_000n)
    expect(tokenLotCostBaseUnits(3_000_000, 1)).toBe(3n) // ceils
  })
})
