/**
 * The firm-trade routine, shared by every executing surface. One leg =
 * RFQ (operator's signed order) → buyer signs the matching EIP-712 order in
 * the wallet → venue pairs the fill → settleFills lands on Base Sepolia.
 * Funds are real: the buyer's deposited tsUSD in InferenceBazaarSettlement pays the
 * issuer; the minted lot is the receipt.
 */
import { useCallback } from 'react'
import { zeroHash, type Hex } from 'viem'
import { useAccount, usePublicClient, useSignTypedData, useWriteContract } from 'wagmi'
import { CHAIN } from './api'
import { endpointFor, type Venue } from './venues'
import { pickAntiSticky, privacyOn, rememberOperator } from './privacy'
import {
  EIP712_DOMAIN,
  fillRfq,
  flushSettlement,
  ORDER_TYPES,
  randomSalt,
  requestRfq,
  SETTLEMENT,
  SETTLEMENT_ABI,
  USD_ABI,
  type RfqQuote,
  type WireOrder,
} from './settlement'

export interface TradeProgress {
  step:
    | 'funding-mint'
    | 'funding-approve'
    | 'funding-deposit'
    | 'quoting'
    | 'signing'
    | 'pairing'
    | 'settling'
  detail?: string
}

export interface TradeReceipt {
  instrumentId: string
  qtyTokens: number
  priceMicroPerM: number
  costMicro: number
  settleTx: Hex | null
  /** The operator whose quote won the auction. */
  operator?: `0x${string}`
}

export interface FirmTradeQuote {
  instrumentId: string
  qtyTokens: number
  priceMicroPerM: number
  costMicro: number
  rfq: RfqQuote
  venue: Venue
}

export interface FirmRoutePlan {
  instrumentId: string
  requestedTokens: number
  filledTokens: number
  quotes: FirmTradeQuote[]
  partial: boolean
}

/** Fan an RFQ to every healthy venue; best price wins (ties → lower latency). */
// Privacy never overpays: anti-stickiness only chooses AMONG quotes within this
// fraction of the best price (the "competitive tier").
const ANTI_STICKY_PRICE_TOLERANCE = 0.005 // 0.5%

async function collectFirmQuotes(
  venues: Venue[],
  params: { instrumentId: string; side: 'buy' | 'sell'; qtyTokens: number },
): Promise<Array<{ rfq: Awaited<ReturnType<typeof requestRfq>>; venue: Venue }>> {
  const live = venues.filter((v) => v.healthy)
  if (live.length === 0) throw new Error('no live venues')
  const quotes = await Promise.all(
    live.map(async (venue) => {
      try {
        // Under privacy mode, reach the operator at its onion (Tor browser).
        const rfq = await requestRfq({ ...params, venueUrl: endpointFor(venue, privacyOn()) })
        return rfq.quoting && rfq.order ? { rfq, venue } : null
      } catch {
        return null
      }
    }),
  )
  const valid = quotes.filter((q): q is NonNullable<typeof q> => q !== null)
  if (valid.length === 0) throw new Error('no operator is quoting this instrument')
  valid.sort((a, b) =>
    params.side === 'buy'
      ? a.rfq.order.priceMicroPerM - b.rfq.order.priceMicroPerM ||
        (a.venue.latencyMs ?? 1e9) - (b.venue.latencyMs ?? 1e9)
      : b.rfq.order.priceMicroPerM - a.rfq.order.priceMicroPerM ||
        (a.venue.latencyMs ?? 1e9) - (b.venue.latencyMs ?? 1e9),
  )
  return valid
}

async function bestQuote(
  venues: Venue[],
  params: { instrumentId: string; side: 'buy' | 'sell'; qtyTokens: number },
  /** Buyer identity for anti-sticky acquisition (only used under privacy mode). */
  antiStickyIdentity?: string,
): Promise<{ rfq: Awaited<ReturnType<typeof requestRfq>>; venue: Venue }> {
  const valid = await collectFirmQuotes(venues, params)

  // Anti-stickiness (privacy): spread acquisitions across operators so a consumer's
  // eventual redemption footprint isn't concentrated where one operator can
  // correlate it. Only among quotes within tolerance of the best price.
  if (antiStickyIdentity && privacyOn() && valid.length > 1) {
    const best = valid[0]!.rfq.order.priceMicroPerM
    const tier = valid.filter(
      (q) => Math.abs(q.rfq.order.priceMicroPerM - best) / best <= ANTI_STICKY_PRICE_TOLERANCE,
    )
    if (tier.length > 1) {
      const ids = tier.map((q) => q.venue.operator.toLowerCase())
      const pickedId = pickAntiSticky(ids, antiStickyIdentity)
      const picked = tier.find((q) => q.venue.operator.toLowerCase() === pickedId)!
      rememberOperator(antiStickyIdentity, pickedId)
      return picked
    }
  }
  return valid[0]!
}

export async function planFirmBuyRoute(
  venues: Venue[],
  params: { instrumentId: string; qtyTokens: number },
): Promise<FirmRoutePlan> {
  const valid = await collectFirmQuotes(venues, { ...params, side: 'buy' })
  const requestedTokens = Math.max(0, Math.floor(params.qtyTokens))
  let remaining = requestedTokens
  const quotes: FirmTradeQuote[] = []

  for (const { rfq, venue } of valid) {
    if (remaining <= 0) break
    const qtyTokens = Math.min(remaining, rfq.order.qtyTokens)
    if (qtyTokens <= 0) continue
    const priceMicroPerM = rfq.order.priceMicroPerM
    quotes.push({
      instrumentId: params.instrumentId,
      qtyTokens,
      priceMicroPerM,
      costMicro: Math.round((priceMicroPerM * qtyTokens) / 1e6),
      rfq,
      venue,
    })
    remaining -= qtyTokens
  }

  const filledTokens = requestedTokens - remaining
  return {
    instrumentId: params.instrumentId,
    requestedTokens,
    filledTokens,
    quotes,
    partial: filledTokens < requestedTokens,
  }
}

export function useFirmTrade() {
  const { address } = useAccount()
  const client = usePublicClient({ chainId: CHAIN.id })
  const { signTypedDataAsync } = useSignTypedData()
  const { writeContractAsync } = useWriteContract()

  /**
   * Make sure the wallet's in-contract balance covers `costMicro`, minting
   * test tsUSD on the dev token and depositing the shortfall. Every step is
   * an on-chain transaction the user confirms.
   */
  const ensureFunds = useCallback(
    async (costMicro: bigint, onProgress: (p: TradeProgress) => void) => {
      if (!address || !client) throw new Error('wallet not connected')
      const balance = (await client.readContract({
        address: SETTLEMENT.address,
        abi: SETTLEMENT_ABI,
        functionName: 'balances',
        args: [address],
      })) as bigint
      if (balance >= costMicro) return
      const shortfall = costMicro - balance

      const usdBalance = (await client.readContract({
        address: SETTLEMENT.usd,
        abi: USD_ABI,
        functionName: 'balanceOf',
        args: [address],
      })) as bigint
      if (usdBalance < shortfall) {
        onProgress({ step: 'funding-mint', detail: 'minting test tsUSD' })
        const tx = await writeContractAsync({
          address: SETTLEMENT.usd,
          abi: USD_ABI,
          functionName: 'mint',
          args: [address, shortfall - usdBalance],
          chainId: CHAIN.id,
        })
        await client.waitForTransactionReceipt({ hash: tx })
      }

      const allowance = (await client.readContract({
        address: SETTLEMENT.usd,
        abi: USD_ABI,
        functionName: 'allowance',
        args: [address, SETTLEMENT.address],
      })) as bigint
      if (allowance < shortfall) {
        onProgress({ step: 'funding-approve', detail: 'approving tsUSD' })
        const tx = await writeContractAsync({
          address: SETTLEMENT.usd,
          abi: USD_ABI,
          functionName: 'approve',
          args: [SETTLEMENT.address, shortfall],
          chainId: CHAIN.id,
        })
        await client.waitForTransactionReceipt({ hash: tx })
      }

      onProgress({ step: 'funding-deposit', detail: 'depositing to settlement' })
      const tx = await writeContractAsync({
        address: SETTLEMENT.address,
        abi: SETTLEMENT_ABI,
        functionName: 'deposit',
        args: [shortfall],
        chainId: CHAIN.id,
      })
      await client.waitForTransactionReceipt({ hash: tx })
    },
    [address, client, writeContractAsync],
  )

  const buyFirmQuote = useCallback(
    async (
      firm: FirmTradeQuote,
      onProgress: (p: TradeProgress) => void,
    ): Promise<TradeReceipt> => {
      if (!address) throw new Error('wallet not connected')

      const costMicro = BigInt(firm.costMicro)

      await ensureFunds(costMicro, onProgress)

      onProgress({ step: 'signing', detail: 'confirm the order in your wallet' })
      const taker: WireOrder = {
        instrument: firm.rfq.order.instrument,
        side: 0,
        priceMicroPerM: firm.priceMicroPerM,
        qtyTokens: firm.qtyTokens,
        lotId: zeroHash,
        trader: address,
        expiry: firm.rfq.order.expiry,
        salt: randomSalt(),
      }
      const signature = await signTypedDataAsync({
        domain: EIP712_DOMAIN,
        types: ORDER_TYPES,
        primaryType: 'Order',
        message: {
          instrument: taker.instrument,
          side: taker.side,
          priceMicroPerM: BigInt(taker.priceMicroPerM),
          qtyTokens: BigInt(taker.qtyTokens),
          lotId: taker.lotId,
          trader: taker.trader,
          expiry: BigInt(taker.expiry),
          salt: taker.salt,
        },
      })

      onProgress({ step: 'pairing' })
      const venueUrl = endpointFor(firm.venue, privacyOn())
      await fillRfq({
        makerInstrumentId: firm.instrumentId,
        maker: firm.rfq.order,
        makerSignature: firm.rfq.signature,
        taker,
        takerSignature: signature as Hex,
        venueUrl,
      })

      onProgress({ step: 'settling', detail: 'submitting settleFills' })
      const flush = await flushSettlement(venueUrl)
      const settleTx = (flush.tx as Hex | undefined) ?? null

      return {
        instrumentId: firm.instrumentId,
        qtyTokens: firm.qtyTokens,
        priceMicroPerM: firm.priceMicroPerM,
        costMicro: Number(costMicro),
        settleTx,
        operator: firm.venue.operator,
      }
    },
    [address, ensureFunds, signTypedDataAsync],
  )

  /** Buy one leg firm: preflight RFQ coverage before any wallet transaction. */
  const buyLeg = useCallback(
    async (
      instrumentId: string,
      qtyTokens: number,
      onProgress: (p: TradeProgress) => void,
      venues: Venue[],
    ): Promise<TradeReceipt> => {
      if (!address) throw new Error('wallet not connected')

      onProgress({ step: 'quoting', detail: `auctioning across ${venues.filter((v) => v.healthy).length} venues` })
      const plan = await planFirmBuyRoute(venues, { instrumentId, qtyTokens })
      if (plan.quotes.length === 0) throw new Error('no operator is quoting this instrument')
      if (plan.partial) {
        throw new Error(
          `only ${plan.filledTokens.toLocaleString()} of ${plan.requestedTokens.toLocaleString()} tokens are firm right now`,
        )
      }
      return buyFirmQuote(plan.quotes[0]!, onProgress)
    },
    [address, buyFirmQuote],
  )

  /** Resell a held lot firm: best bid across all venues → sign → settle. */
  const sellLot = useCallback(
    async (
      instrumentId: string,
      lotId: Hex,
      qtyTokens: number,
      onProgress: (p: TradeProgress) => void,
      venues: Venue[],
    ): Promise<TradeReceipt> => {
      if (!address) throw new Error('wallet not connected')

      onProgress({ step: 'quoting', detail: `auctioning across ${venues.filter((v) => v.healthy).length} venues` })
      const { rfq, venue } = await bestQuote(venues, { instrumentId, side: 'sell', qtyTokens })
      const qty = Math.min(qtyTokens, rfq.order.qtyTokens)
      const proceedsMicro = BigInt(Math.round((rfq.order.priceMicroPerM * qty) / 1e6))

      onProgress({ step: 'signing', detail: 'confirm the sale in your wallet' })
      const taker: WireOrder = {
        instrument: rfq.order.instrument,
        side: 1,
        priceMicroPerM: rfq.order.priceMicroPerM,
        qtyTokens: qty,
        lotId,
        trader: address,
        expiry: rfq.order.expiry,
        salt: randomSalt(),
      }
      const signature = await signTypedDataAsync({
        domain: EIP712_DOMAIN,
        types: ORDER_TYPES,
        primaryType: 'Order',
        message: {
          instrument: taker.instrument,
          side: taker.side,
          priceMicroPerM: BigInt(taker.priceMicroPerM),
          qtyTokens: BigInt(taker.qtyTokens),
          lotId: taker.lotId,
          trader: taker.trader,
          expiry: BigInt(taker.expiry),
          salt: taker.salt,
        },
      })

      onProgress({ step: 'pairing' })
      const venueUrl = endpointFor(venue, privacyOn())
      await fillRfq({
        makerInstrumentId: instrumentId,
        maker: rfq.order,
        makerSignature: rfq.signature,
        taker,
        takerSignature: signature as Hex,
        venueUrl,
      })

      onProgress({ step: 'settling', detail: 'submitting settleFills' })
      const flush = await flushSettlement(venueUrl)

      return {
        instrumentId,
        qtyTokens: qty,
        priceMicroPerM: rfq.order.priceMicroPerM,
        costMicro: Number(proceedsMicro),
        settleTx: (flush.tx as Hex | undefined) ?? null,
        operator: venue.operator,
      }
    },
    [address, signTypedDataAsync],
  )

  return { buyLeg, buyFirmQuote, sellLot }
}

export const STEP_LABEL: Record<TradeProgress['step'], string> = {
  'funding-mint': 'Minting test tsUSD',
  'funding-approve': 'Approving tsUSD',
  'funding-deposit': 'Depositing to settlement',
  quoting: 'Requesting firm quote',
  signing: 'Awaiting wallet signature',
  pairing: 'Pairing signed orders',
  settling: 'Settling on Base Sepolia',
}
