/** Filled trades choose Platform credits or ShieldedCredits through settlement ports. */
import { tokenLotCostBaseUnits, type SpendAuthPayload } from './spend-auth'

export type SettlementRailKind = 'router-credits' | 'shielded'

interface BaseOrder {
  orderId: string
  /** Platform user id (router rail) or shielded commitment (shielded rail). */
  buyer: string
  /** Payee operator id (router rail) or operator address (shielded rail). */
  operator: string
  instrumentId: string
  qtyTokens: number
  /** Execution price, micro-tsUSD per 1M tokens. */
  priceMicroPerM: number
}

export interface RouterCreditsOrder extends BaseOrder {
  rail: 'router-credits'
}

export interface ShieldedOrder extends BaseOrder {
  rail: 'shielded'
  /** Buyer's pre-signed authorization for this fill. */
  spendAuth: SpendAuthPayload
}

export type SettlementOrder = RouterCreditsOrder | ShieldedOrder

export interface SettlementReceipt {
  orderId: string
  rail: SettlementRailKind
  /** Total charged to the buyer, base units (micro-tsUSD). */
  amountBaseUnits: bigint
  /** Operator's cut after the platform take, base units. */
  operatorBaseUnits: bigint
  /** Platform take, base units. */
  platformBaseUnits: bigint
  status: 'settled'
  /** Tx hash (shielded) or platform transaction id (router). */
  ref: string
}

export interface SettlementRail<Order extends SettlementOrder> {
  readonly kind: Order['rail']
  settle(order: Order): Promise<SettlementReceipt>
}

/** Operator cut vs platform take, in basis points (default 20% platform take). */
export interface FeePolicy {
  platformTakeBps: number
}

const DEFAULT_FEE: FeePolicy = { platformTakeBps: 2000 }

export function splitFee(
  amount: bigint,
  fee: FeePolicy = DEFAULT_FEE,
): { operator: bigint; platform: bigint } {
  if (fee.platformTakeBps < 0 || fee.platformTakeBps > 10_000) {
    throw new Error(`platformTakeBps out of range: ${fee.platformTakeBps}`)
  }
  const platform = (amount * BigInt(fee.platformTakeBps)) / 10_000n
  return { operator: amount - platform, platform }
}

// ── Rail 1: router / platform credits ────────────────────────────────────────

/**
 * The marketplace's view of the live platform's balance ops. The router owns
 * the money; we only ask it to move. Mirrors the router's `deductViaPlatform` /
 * `grantViaPlatform` so a real adapter is a thin HTTP wrapper.
 */
export interface RouterSettlementPort {
  /** Deduct `amount` base units from the buyer's platform balance; returns a txn id. */
  deduct(buyer: string, amountBaseUnits: bigint, memo: string): Promise<string>
  /** Credit `amount` base units to the operator's payout balance. */
  credit(operator: string, amountBaseUnits: bigint, memo: string): Promise<void>
}

export class RouterCreditsRail implements SettlementRail<RouterCreditsOrder> {
  readonly kind = 'router-credits' as const
  private readonly port: RouterSettlementPort
  private readonly fee: FeePolicy

  constructor(port: RouterSettlementPort, fee: FeePolicy = DEFAULT_FEE) {
    this.port = port
    this.fee = fee
  }

  async settle(order: RouterCreditsOrder): Promise<SettlementReceipt> {
    const amount = tokenLotCostBaseUnits(order.priceMicroPerM, order.qtyTokens)
    const { operator, platform } = splitFee(amount, this.fee)
    const ref = await this.port.deduct(order.buyer, amount, `inference-bazaar:${order.orderId}`)
    await this.port.credit(order.operator, operator, `inference-bazaar:${order.orderId}`)
    return {
      orderId: order.orderId,
      rail: this.kind,
      amountBaseUnits: amount,
      operatorBaseUnits: operator,
      platformBaseUnits: platform,
      status: 'settled',
      ref,
    }
  }
}

// ── Rail 2: on-chain shielded credits ────────────────────────────────────────

/**
 * The marketplace's view of the ShieldedCredits contract. A real adapter is a
 * viem client (see tangle-router/lib/shielded/on-chain). authorize reserves the
 * buyer's pre-signed amount; claim moves it to the operator.
 */
export interface ShieldedChainPort {
  authorizeSpend(auth: SpendAuthPayload): Promise<string>
  claimPayment(authHash: string, recipient: string): Promise<string>
}

export class ShieldedRail implements SettlementRail<ShieldedOrder> {
  readonly kind = 'shielded' as const
  private readonly chain: ShieldedChainPort
  private readonly fee: FeePolicy

  constructor(chain: ShieldedChainPort, fee: FeePolicy = DEFAULT_FEE) {
    this.chain = chain
    this.fee = fee
  }

  async settle(order: ShieldedOrder): Promise<SettlementReceipt> {
    const amount = tokenLotCostBaseUnits(order.priceMicroPerM, order.qtyTokens)
    if (order.spendAuth.amount < amount) {
      throw new Error(
        `spendAuth authorizes ${order.spendAuth.amount} < required ${amount} base units`,
      )
    }
    const { operator, platform } = splitFee(amount, this.fee)
    const authHash = await this.chain.authorizeSpend(order.spendAuth)
    const ref = await this.chain.claimPayment(authHash, order.operator)
    return {
      orderId: order.orderId,
      rail: this.kind,
      amountBaseUnits: amount,
      operatorBaseUnits: operator,
      platformBaseUnits: platform,
      status: 'settled',
      ref,
    }
  }
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

/** Routes each fill to the rail its order names. Both rails are first-class. */
export class SettlementRouter {
  private readonly routerRail: RouterCreditsRail
  private readonly shieldedRail: ShieldedRail

  constructor(routerRail: RouterCreditsRail, shieldedRail: ShieldedRail) {
    this.routerRail = routerRail
    this.shieldedRail = shieldedRail
  }

  settle(order: SettlementOrder): Promise<SettlementReceipt> {
    switch (order.rail) {
      case 'router-credits':
        return this.routerRail.settle(order)
      case 'shielded':
        return this.shieldedRail.settle(order)
      default: {
        const exhaustive: never = order
        throw new Error(`unknown settlement rail: ${JSON.stringify(exhaustive)}`)
      }
    }
  }
}
