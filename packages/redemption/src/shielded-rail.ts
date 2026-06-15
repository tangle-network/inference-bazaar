import type { SpendAuthPayload } from '@inference-bazaar/router-bridge'
import { CreditBook } from './credit-book'
import type { DebitError, DebitResult, MeteredCall } from './types'
import { isDebitError } from './types'

/**
 * The live, zero-router-change redemption rail.
 *
 * A credit's escrow is a dedicated ShieldedCredits commitment funded with
 * `backingMicro` at issuance (settlement side). Spending it requires no new
 * router code: each metered call becomes a SpendAuth for exactly the debit's
 * operator payout, pinned to the selling operator. The router's existing x402
 * path verifies the auth, serves, and claims the amount to that operator from
 * the commitment. Closure carries over from the CreditBook: the sum of auth
 * amounts over any redemption sequence equals the backing issued, so the
 * escrow exhausts on the same call as the quota.
 */

/** Binds a credit to its on-chain escrow and obligated operator. */
export interface ShieldedCreditBinding {
  creditId: string
  /** ShieldedCredits commitment (bytes32) funded with this credit's backing at issuance. */
  commitment: string
  /**
   * Selling operator's payout address. Every auth is pinned here — the router
   * rejects a SpendAuth whose operator does not match the routed operator, so
   * the call can only be served (and claimed) by the operator who sold the
   * inference-bazaar. Refusal of a valid pinned auth is the Phase 6 slashing condition.
   */
  operatorAddress: string
  /** Tangle service id the operator serves under. */
  serviceId: bigint
}

/** A planned spend authorization — sign it and send as `X-Payment-Signature`. */
export interface PlannedSpendAuth {
  creditId: string
  debit: DebitResult
  /** EIP-712 payload minus the signature; amount == debit.operatorPayoutMicro. */
  auth: Omit<SpendAuthPayload, 'signature'>
}

export interface ShieldedRedemptionPlannerOptions {
  /** Auth validity window in seconds from the call's metering ts. Default 300. */
  authTtlSec?: number
}

/**
 * Turns CreditBook debits into spend authorizations. Deterministic and pure
 * like the book itself: no clocks (ts comes from the call), no signing (the
 * holder of the credit's spending key signs the returned payload), no I/O.
 * Nonces are monotonic per commitment and consumed only by successful debits,
 * so a rejected call never burns replay protection.
 */
export class ShieldedRedemptionPlanner {
  private readonly bindings = new Map<string, ShieldedCreditBinding>()
  private readonly nonces = new Map<string, bigint>()
  private readonly jobIndexes = new Map<string, number>()
  private readonly authTtlSec: number

  constructor(private readonly book: CreditBook, opts: ShieldedRedemptionPlannerOptions = {}) {
    this.authTtlSec = opts.authTtlSec ?? 300
  }

  /** Bind an issued credit to its escrow commitment + obligated operator. */
  bind(binding: ShieldedCreditBinding): void {
    if (!this.book.get(binding.creditId)) {
      throw new Error(`cannot bind unknown credit: ${binding.creditId}`)
    }
    if (this.bindings.has(binding.creditId)) {
      throw new Error(`credit already bound: ${binding.creditId}`)
    }
    this.bindings.set(binding.creditId, { ...binding })
  }

  /**
   * Debit the metered call and emit the matching spend authorization. The
   * auth's amount is exactly the debit's operator payout, so authorizations
   * over a redemption sequence sum to the backing issued — the on-chain
   * escrow cannot over- or under-pay relative to the metered quota.
   */
  authorize(call: MeteredCall): PlannedSpendAuth | DebitError {
    const binding = this.bindings.get(call.creditId)
    if (!binding) return { kind: 'unknown-credit', creditId: call.creditId }

    const debit = this.book.debit(call)
    if (isDebitError(debit)) return debit

    const nonce = this.nonces.get(binding.commitment) ?? 0n
    this.nonces.set(binding.commitment, nonce + 1n)
    const jobIndex = this.jobIndexes.get(binding.commitment) ?? 0
    this.jobIndexes.set(binding.commitment, (jobIndex + 1) % 256) // uint8 on-chain

    return {
      creditId: call.creditId,
      debit,
      auth: {
        commitment: binding.commitment,
        serviceId: binding.serviceId,
        jobIndex,
        amount: BigInt(debit.operatorPayoutMicro),
        operator: binding.operatorAddress,
        nonce,
        expiry: BigInt(call.ts + this.authTtlSec),
      },
    }
  }
}
