/**
 * The firm-trade routine, shared by every executing surface. One leg =
 * RFQ (operator's signed order) → buyer signs the matching EIP-712 order in
 * the wallet → venue pairs the fill → settleFills lands on Base Sepolia.
 * Funds are real: the buyer's deposited tsUSD in SurplusSettlement pays the
 * issuer; the minted lot is the receipt.
 */
import { useCallback } from 'react'
import { zeroHash, type Hex } from 'viem'
import { useAccount, usePublicClient, useSignTypedData, useWriteContract } from 'wagmi'
import { CHAIN } from './api'
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

  /** Buy one leg firm: quote → sign → pair → settle on-chain. */
  const buyLeg = useCallback(
    async (
      instrumentId: string,
      qtyTokens: number,
      onProgress: (p: TradeProgress) => void,
    ): Promise<TradeReceipt> => {
      if (!address) throw new Error('wallet not connected')

      onProgress({ step: 'quoting' })
      const rfq = await requestRfq({ instrumentId, side: 'buy', qtyTokens })
      if (!rfq.quoting || !rfq.order) {
        throw new Error(`operator is not quoting: ${(rfq.reasons ?? []).join(', ') || 'no liquidity'}`)
      }
      const qty = Math.min(qtyTokens, rfq.order.qtyTokens)
      const costMicro = BigInt(Math.round((rfq.order.priceMicroPerM * qty) / 1e6))

      await ensureFunds(costMicro, onProgress)

      onProgress({ step: 'signing', detail: 'confirm the order in your wallet' })
      const taker: WireOrder = {
        instrument: rfq.order.instrument,
        side: 0,
        priceMicroPerM: rfq.order.priceMicroPerM,
        qtyTokens: qty,
        lotId: zeroHash,
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
      await fillRfq({
        makerInstrumentId: instrumentId,
        maker: rfq.order,
        makerSignature: rfq.signature,
        taker,
        takerSignature: signature as Hex,
      })

      onProgress({ step: 'settling', detail: 'submitting settleFills' })
      const flush = await flushSettlement()
      const settleTx = (flush.tx as Hex | undefined) ?? null

      return {
        instrumentId,
        qtyTokens: qty,
        priceMicroPerM: rfq.order.priceMicroPerM,
        costMicro: Number(costMicro),
        settleTx,
      }
    },
    [address, ensureFunds, signTypedDataAsync],
  )

  /** Resell a held lot firm: quote the operator's bid → sign a sell of your lot. */
  const sellLot = useCallback(
    async (
      instrumentId: string,
      lotId: Hex,
      qtyTokens: number,
      onProgress: (p: TradeProgress) => void,
    ): Promise<TradeReceipt> => {
      if (!address) throw new Error('wallet not connected')

      onProgress({ step: 'quoting' })
      const rfq = await requestRfq({ instrumentId, side: 'sell', qtyTokens })
      if (!rfq.quoting || !rfq.order) {
        throw new Error(`operator is not bidding: ${(rfq.reasons ?? []).join(', ') || 'no liquidity'}`)
      }
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
      await fillRfq({
        makerInstrumentId: instrumentId,
        maker: rfq.order,
        makerSignature: rfq.signature,
        taker,
        takerSignature: signature as Hex,
      })

      onProgress({ step: 'settling', detail: 'submitting settleFills' })
      const flush = await flushSettlement()

      return {
        instrumentId,
        qtyTokens: qty,
        priceMicroPerM: rfq.order.priceMicroPerM,
        costMicro: Number(proceedsMicro),
        settleTx: (flush.tx as Hex | undefined) ?? null,
      }
    },
    [address, signTypedDataAsync],
  )

  return { buyLeg, sellLot }
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
