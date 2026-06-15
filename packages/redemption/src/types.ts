/**
 * Redemption types — the spending/metering side of a InferenceBazaar credit.
 * Issuance, escrow, and RFQ live with the settlement agent; everything here
 * starts from a credit that already exists and proves it is spendable.
 *
 * Units (inherited from market-core, do not redefine):
 * - token quantity: integer tokens
 * - price: integer micro-tsUSD per 1M tokens (15_000_000 = $15.00/M)
 * - money / backing: integer micro-tsUSD ($1 = 1e6)
 */

/** A prepaid, price-locked, metered inference quota — what a buyer holds. */
export interface Credit {
  id: string
  /** Platform user id or shielded commitment. */
  owner: string
  /** e.g. 'anthropic/claude-opus-4-8' */
  model: string
  tokenKind: 'input' | 'output'
  /** Tokens remaining to spend. Strictly decreasing across debits. */
  qtyRemaining: number
  /** Original quota — for invariant checks + telemetry. */
  qtyIssued: number
  /** Locked price the buyer pays per 1M tokens, micro-tsUSD. */
  strikeMicroPerM: number
  /**
   * Escrowed backing in micro-tsUSD, posted at issuance, that funds operator
   * payouts as the credit is spent. Decreases with each debit. MUST always
   * equal cost(strike, qtyRemaining) — checked as an invariant.
   */
  backingMicro: number
  /** Unix seconds; calls after this are rejected and the remainder refunds. */
  expiry: number
}

/** A metered inference call the router asks us to debit a credit for. */
export interface MeteredCall {
  creditId: string
  model: string
  tokenKind: 'input' | 'output'
  /** Actual metered tokens for THIS call (from the router's usage accounting). */
  tokens: number
  /** Unix seconds the call was metered at. */
  ts: number
  /** The operator that fulfilled it — paid from backing. */
  operator: string
}

export interface DebitResult {
  creditId: string
  tokensDebited: number
  /** Cost at the locked strike, micro-tsUSD — paid to the operator from backing. */
  operatorPayoutMicro: number
  qtyRemaining: number
  backingRemaining: number
  exhausted: boolean
}

export type DebitError =
  | { kind: 'unknown-credit'; creditId: string }
  | { kind: 'wrong-instrument'; expected: string; got: string }
  | { kind: 'expired'; expiry: number; ts: number }
  | { kind: 'insufficient-quota'; qtyRemaining: number; requested: number }

export function isDebitError<T extends object>(value: T | DebitError): value is DebitError {
  return 'kind' in value
}

/**
 * Unspent backing owed back to the issuance side on expiry or explicit close.
 * This package never moves money — settlement executes the intent, exactly as
 * it executes the operator's settlement intents today.
 */
export interface RefundIntent {
  creditId: string
  owner: string
  /** Exactly the backing remaining at close, micro-tsUSD. */
  amountMicro: number
  reason: 'expired' | 'exhausted' | 'closed'
  /** Unix seconds the close was requested at. */
  ts: number
}
