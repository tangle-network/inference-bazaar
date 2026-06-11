/**
 * SurplusSettlement binding — the firm rail, live on Base Sepolia.
 *
 * A trade is real here or it isn't a trade: the buyer signs an EIP-712 order
 * in their wallet, the venue pairs it with the operator's signed quote, and
 * `settleFills` moves deposited tsUSD and mints a collateral-backed credit
 * lot on-chain, atomically. Supply is provable (issuer collateral ≥ liability,
 * contract-enforced); demand is provable (the lot + the balance debit).
 */
import { keccak256, toHex, type Address, type Hex } from 'viem'
import { useQuery } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'
import { CHAIN, VENUE_URL } from './api'

export const SETTLEMENT = {
  address: '0x1cD49739e9CF48C4906aDb44021dd8cE0d8aBa64' as Address,
  usd: '0x14Ff9231D03Fd9AD75e553004585f13Ff51db630' as Address,
  /** Block the contracts deployed at — event scans start here. */
  fromBlock: 42716877n,
}

export const EIP712_DOMAIN = {
  name: 'SurplusSettlement',
  version: '1',
  chainId: CHAIN.id,
  verifyingContract: SETTLEMENT.address,
} as const

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

export interface WireOrder {
  instrument: Hex
  side: number
  priceMicroPerM: number
  qtyTokens: number
  lotId: Hex
  trader: Address
  expiry: number
  salt: Hex
}

export function instrumentHash(instrumentId: string): Hex {
  return keccak256(toHex(instrumentId))
}

export function randomSalt(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}` as Hex
}

export const SETTLEMENT_ABI = [
  { type: 'function', name: 'deposit', inputs: [{ name: 'amount', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'withdraw', inputs: [{ name: 'amount', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'balances', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'collateral', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'liability', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  {
    type: 'function', name: 'lots', inputs: [{ name: '', type: 'bytes32' }],
    outputs: [
      { name: 'holder', type: 'address' },
      { name: 'issuer', type: 'address' },
      { name: 'instrument', type: 'bytes32' },
      { name: 'qtyTokens', type: 'uint64' },
      { name: 'lockedTokens', type: 'uint64' },
      { name: 'expiry', type: 'uint64' },
      { name: 'notionalMicro', type: 'uint128' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'event', name: 'FillSettled',
    inputs: [
      { name: 'buyOrderHash', type: 'bytes32', indexed: true },
      { name: 'sellOrderHash', type: 'bytes32', indexed: true },
      { name: 'instrument', type: 'bytes32', indexed: false },
      { name: 'qtyTokens', type: 'uint64', indexed: false },
      { name: 'execPriceMicroPerM', type: 'uint64', indexed: false },
      { name: 'costMicro', type: 'uint256', indexed: false },
      { name: 'lotId', type: 'bytes32', indexed: false },
    ],
  },
] as const

export const USD_ABI = [
  { type: 'function', name: 'mint', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'approve', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'allowance', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'balanceOf', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const

// ── Venue RFQ wire ───────────────────────────────────────────────────────────

export interface RfqQuote {
  quoting: boolean
  instrumentId: string
  order: WireOrder
  signature: Hex
  digest: Hex
  validUntil: number
  rationale?: string
  reasons?: string[]
}

export async function requestRfq(params: {
  instrumentId: string
  side: 'buy' | 'sell'
  qtyTokens: number
}): Promise<RfqQuote> {
  const res = await fetch(`${VENUE_URL}/rfq`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  })
  if (!res.ok) throw new Error(`RFQ: ${await res.text()}`)
  return res.json() as Promise<RfqQuote>
}

export async function fillRfq(params: {
  makerInstrumentId: string
  maker: WireOrder
  makerSignature: Hex
  taker: WireOrder
  takerSignature: Hex
}): Promise<Record<string, unknown>> {
  const res = await fetch(`${VENUE_URL}/rfq/fill`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      maker: { instrumentId: params.makerInstrumentId, order: params.maker, signature: params.makerSignature },
      taker: { instrumentId: params.makerInstrumentId, order: params.taker, signature: params.takerSignature },
    }),
  })
  if (!res.ok) throw new Error(`fill: ${await res.text()}`)
  return res.json() as Promise<Record<string, unknown>>
}

export async function flushSettlement(): Promise<Record<string, unknown>> {
  const res = await fetch(`${VENUE_URL}/settlement/flush`, { method: 'POST' })
  if (!res.ok) throw new Error(`flush: ${await res.text()}`)
  return res.json() as Promise<Record<string, unknown>>
}

// ── On-chain reads ───────────────────────────────────────────────────────────

export interface CreditLot {
  lotId: Hex
  instrument: Hex
  qtyTokens: bigint
  lockedTokens: bigint
  expiry: bigint
  notionalMicro: bigint
  issuer: Address
  txHash: Hex
}

/** The connected wallet's credit lots — FillSettled events → lots() reads. */
export function useMyLots(address: Address | undefined) {
  const client = usePublicClient({ chainId: CHAIN.id })
  return useQuery({
    queryKey: ['lots', address],
    enabled: !!address && !!client,
    refetchInterval: 30_000,
    queryFn: async (): Promise<CreditLot[]> => {
      const logs = await client!.getContractEvents({
        address: SETTLEMENT.address,
        abi: SETTLEMENT_ABI,
        eventName: 'FillSettled',
        fromBlock: SETTLEMENT.fromBlock,
        toBlock: 'latest',
      })
      const out: CreditLot[] = []
      for (const log of logs) {
        const lotId = log.args.lotId as Hex | undefined
        if (!lotId || lotId === `0x${'0'.repeat(64)}`) continue
        const lot = await client!.readContract({
          address: SETTLEMENT.address,
          abi: SETTLEMENT_ABI,
          functionName: 'lots',
          args: [lotId],
        })
        const [holder, issuer, instrument, qtyTokens, lockedTokens, expiry, notionalMicro] = lot
        if (holder.toLowerCase() !== address!.toLowerCase()) continue
        out.push({
          lotId,
          instrument,
          qtyTokens,
          lockedTokens,
          expiry,
          notionalMicro,
          issuer,
          txHash: log.transactionHash,
        })
      }
      return out
    },
  })
}
