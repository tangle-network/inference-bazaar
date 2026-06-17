/**
 * InferenceBazaarSettlement binding — the firm rail, live on Base Sepolia.
 *
 * A trade is real here or it isn't a trade: the buyer signs an EIP-712 order
 * in their wallet, the venue pairs it with the operator's signed quote, and
 * `settleFills` moves deposited tsUSD and mints a collateral-backed credit
 * lot on-chain, atomically. Supply is provable (issuer collateral ≥ liability,
 * contract-enforced); demand is provable (the lot + the balance debit).
 */
import { keccak256, toHex, type Address, type Hex, type PublicClient } from 'viem'
import type { GetContractEventsReturnType } from 'viem/actions'
import { useQuery } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'
import { CHAIN, VENUE_URL } from './api'

export const SETTLEMENT = {
  address: '0x31D0215d77A06ff97Cb61BbBe4b931Ac0D1da8aA' as Address,
  usd: '0x14Ff9231D03Fd9AD75e553004585f13Ff51db630' as Address,
  /** Block the contracts deployed at — event scans start here. */
  fromBlock: 42887343n,
}

const LOG_SCAN_BLOCKS = 1_900n
const ZERO_LOT_ID = `0x${'0'.repeat(64)}` as Hex

export const EIP712_DOMAIN = {
  name: 'InferenceBazaarSettlement',
  version: '1',
  chainId: CHAIN.id,
  verifyingContract: SETTLEMENT.address,
} as const

/** Holder authorization for one venue serve call (operator-verified EIP-712). */
export const SERVE_DOMAIN = {
  name: 'InferenceBazaarServe',
  version: '1',
  chainId: 84532,
  verifyingContract: '0x31D0215d77A06ff97Cb61BbBe4b931Ac0D1da8aA',
} as const

export const SERVE_TYPES = {
  ServeRequest: [
    { name: 'redemptionId', type: 'bytes32' },
    { name: 'messagesHash', type: 'bytes32' },
    { name: 'maxTokens', type: 'uint64' },
    { name: 'expiry', type: 'uint64' },
  ],
} as const

/** One signature delegates a session key to draw down the lot (spend channel —
 * see docs/specs/spend-rail.md). The session key (held by the gateway) then signs
 * per-request vouchers; the operator can only settle a voucher the session key
 * signed, so over-billing is impossible. Must match SPEND_PERMIT_TYPEHASH. */
export const SPEND_PERMIT_TYPES = {
  SpendPermit: [
    { name: 'lotId', type: 'bytes32' },
    { name: 'sessionKey', type: 'address' },
    { name: 'maxTokens', type: 'uint64' },
    { name: 'expiry', type: 'uint64' },
  ],
} as const

export const RECEIPT_TYPES = {
  RedemptionReceipt: [
    { name: 'redemptionId', type: 'bytes32' },
    { name: 'servedTokens', type: 'uint64' },
    // Proof of WHAT was served: keccak256(modelIdHash, messagesHash, outputHash).
    // /redeem returns it; the holder reproduces outputHash from the served
    // content before signing. Must match RECEIPT_TYPEHASH in the contract.
    { name: 'workCommitment', type: 'bytes32' },
  ],
} as const

/** Off-chain auth for the `/v1/usage` meter read: the holder signs this and the
 * venue returns only that holder's channels. Bound to the settlement domain so a
 * captured signature can't be replayed at another deployment. Must match the
 * operator's USAGE_QUERY_TYPE (`UsageQuery(address holder,uint64 expiry)`). */
export const USAGE_QUERY_TYPES = {
  UsageQuery: [
    { name: 'holder', type: 'address' },
    { name: 'expiry', type: 'uint64' },
  ],
} as const

/** One channel's live counters as the venue meters them. `served` runs ahead of
 * on-chain `settled` by exactly `inflight` (vouchered-but-unsettled). */
export interface MeterRow {
  lotId: Hex
  maxTokens: number
  servedTokens: number
  settledTokens: number
  inflightTokens: number
  remainingTokens: number
}

/** Holder-authenticated read of live spend from ONE venue. Returns its rows keyed
 * by lotId; throws on a non-200 so the caller can skip an unreachable venue. */
export async function fetchVenueUsage(
  venueUrl: string,
  holder: Address,
  expiry: number,
  sig: Hex,
): Promise<Map<Hex, MeterRow>> {
  const res = await fetch(`${venueUrl}/v1/usage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ holder, expiry, sig }),
  })
  if (!res.ok) throw new Error(await res.text())
  const out = (await res.json()) as { lots?: Array<Record<string, unknown>> }
  const rows = new Map<Hex, MeterRow>()
  for (const l of out.lots ?? []) {
    const lotId = l.lotId as Hex
    rows.set(lotId, {
      lotId,
      maxTokens: Number(l.maxTokens ?? 0),
      servedTokens: Number(l.servedTokens ?? 0),
      settledTokens: Number(l.settledTokens ?? 0),
      inflightTokens: Number(l.inflightTokens ?? 0),
      remainingTokens: Number(l.remainingTokens ?? 0),
    })
  }
  return rows
}

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

type FillSettledLog = GetContractEventsReturnType<typeof SETTLEMENT_ABI, 'FillSettled'>[number]

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
  venueUrl?: string
}): Promise<RfqQuote> {
  const res = await fetch(`${params.venueUrl ?? VENUE_URL}/rfq`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      instrumentId: params.instrumentId,
      side: params.side,
      qtyTokens: params.qtyTokens,
    }),
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
  venueUrl?: string
}): Promise<Record<string, unknown>> {
  const res = await fetch(`${params.venueUrl ?? VENUE_URL}/rfq/fill`, {
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

export async function flushSettlement(venueUrl?: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${venueUrl ?? VENUE_URL}/settlement/flush`, { method: 'POST' })
  if (!res.ok) throw new Error(`flush: ${await res.text()}`)
  return res.json() as Promise<Record<string, unknown>>
}

// ── On-chain reads ───────────────────────────────────────────────────────────

export interface CreditLot {
  lotId: Hex
  instrument: Hex
  /** Tokens still spendable on-chain — decreases with each settled draw-down. */
  qtyTokens: bigint
  lockedTokens: bigint
  /** Tokens this lot was minted with (from FillSettled). filled − qty = spent. */
  filledTokens: bigint
  expiry: bigint
  notionalMicro: bigint
  issuer: Address
  txHash: Hex
}

async function fetchFillSettledLogs(client: PublicClient): Promise<FillSettledLog[]> {
  const latestBlock = await client.getBlockNumber()
  const logs: FillSettledLog[] = []

  for (let fromBlock = SETTLEMENT.fromBlock; fromBlock <= latestBlock; fromBlock += LOG_SCAN_BLOCKS) {
    const endBlock = fromBlock + LOG_SCAN_BLOCKS - 1n
    const toBlock = endBlock > latestBlock ? latestBlock : endBlock
    const page = await client.getContractEvents({
      address: SETTLEMENT.address,
      abi: SETTLEMENT_ABI,
      eventName: 'FillSettled',
      fromBlock,
      toBlock,
    })
    logs.push(...page)
  }

  return logs
}

export async function fetchMyLots(client: PublicClient, holderAddress: Address): Promise<CreditLot[]> {
  const logs = await fetchFillSettledLogs(client)
  const out: CreditLot[] = []

  for (const log of [...logs].reverse()) {
    const lotId = log.args.lotId as Hex | undefined
    if (!lotId || lotId === ZERO_LOT_ID) continue
    const lot = await client.readContract({
      address: SETTLEMENT.address,
      abi: SETTLEMENT_ABI,
      functionName: 'lots',
      args: [lotId],
    })
    const [holder, issuer, instrument, qtyTokens, lockedTokens, expiry, notionalMicro] = lot
    if (holder.toLowerCase() !== holderAddress.toLowerCase()) continue
    out.push({
      lotId,
      instrument,
      qtyTokens,
      lockedTokens,
      filledTokens: (log.args.qtyTokens as bigint | undefined) ?? qtyTokens,
      expiry,
      notionalMicro,
      issuer,
      txHash: log.transactionHash,
    })
  }

  return out
}

/** The connected wallet's credit lots — FillSettled events → lots() reads. */
export function useMyLots(address: Address | undefined) {
  const client = usePublicClient({ chainId: CHAIN.id })
  return useQuery({
    queryKey: ['lots', address],
    enabled: !!address && !!client,
    refetchInterval: 30_000,
    queryFn: () => fetchMyLots(client!, address!),
  })
}
