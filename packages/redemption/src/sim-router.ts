import type { RedemptionAdapter } from './adapter'
import { costMicro } from './credit-book'
import type { DebitError } from './types'
import { isDebitError } from './types'

/**
 * A fulfilling operator for the proof harness. It "serves" inference (echoing
 * the router's metering) and accumulates what it is paid, split by source so
 * tests can assert payouts came from backing and not the buyer's balance.
 */
export class MockOperator {
  paidFromBackingMicro = 0
  paidFromBalanceMicro = 0
  servedCalls = 0
  servedTokens = 0

  constructor(readonly id: string) {}

  /** Serve a call; returns the metered token count (the router's accounting). */
  serve(tokens: number): number {
    this.servedCalls += 1
    this.servedTokens += tokens
    return tokens
  }

  pay(amountMicro: number, source: 'backing' | 'balance'): void {
    if (source === 'backing') this.paidFromBackingMicro += amountMicro
    else this.paidFromBalanceMicro += amountMicro
  }
}

export interface ServeRequest {
  owner: string
  model: string
  tokenKind: 'input' | 'output'
  /** Tokens this call will meter. */
  tokens: number
  /** Unix seconds. */
  ts: number
  operator: MockOperator
}

export interface ServeOutcome {
  /** Where the primary funds came from. */
  source: 'credit' | 'balance'
  creditId: string | null
  tokensDebited: number
  overflowTokens: number
  paidFromBackingMicro: number
  billedToBalanceMicro: number
  /** Set when a selected credit was rejected at redeem time (e.g. expired). */
  debitError: DebitError | null
}

export interface SimulatedRouterOptions {
  adapter: RedemptionAdapter
  /** List price the router bills at when no credit applies, micro-tsUSD per 1M. */
  listPriceMicroPerM: number
}

/**
 * The router integration shape from the spec, runnable with no live deps:
 * `selectCredit` pre-flight, serve + meter via the operator, `redeem` with the
 * metered count, operator paid from backing, overflow billed at list from the
 * buyer's USD balance. No change to metering — only the source of funds.
 */
export class SimulatedRouter {
  private readonly adapter: RedemptionAdapter
  private readonly listPriceMicroPerM: number
  private readonly balances = new Map<string, number>()

  constructor(opts: SimulatedRouterOptions) {
    this.adapter = opts.adapter
    this.listPriceMicroPerM = opts.listPriceMicroPerM
  }

  deposit(owner: string, amountMicro: number): void {
    this.balances.set(owner, this.balanceOf(owner) + amountMicro)
  }

  balanceOf(owner: string): number {
    return this.balances.get(owner) ?? 0
  }

  serve(req: ServeRequest): ServeOutcome {
    const credit = this.adapter.selectCredit(req.owner, req.model, req.tokenKind, req.ts)
    const metered = req.operator.serve(req.tokens)

    if (!credit) {
      const billed = this.billAtList(req.owner, metered, req.operator)
      return {
        source: 'balance',
        creditId: null,
        tokensDebited: 0,
        overflowTokens: metered,
        paidFromBackingMicro: 0,
        billedToBalanceMicro: billed,
        debitError: null,
      }
    }

    const outcome = this.adapter.redeem({
      creditId: credit.id,
      model: req.model,
      tokenKind: req.tokenKind,
      tokens: metered,
      ts: req.ts,
      operator: req.operator.id,
    })
    if (isDebitError(outcome)) {
      const billed = this.billAtList(req.owner, metered, req.operator)
      return {
        source: 'balance',
        creditId: credit.id,
        tokensDebited: 0,
        overflowTokens: metered,
        paidFromBackingMicro: 0,
        billedToBalanceMicro: billed,
        debitError: outcome,
      }
    }

    req.operator.pay(outcome.payout.amountMicro, 'backing')
    const billed =
      outcome.overflowTokens > 0 ? this.billAtList(req.owner, outcome.overflowTokens, req.operator) : 0
    return {
      source: 'credit',
      creditId: credit.id,
      tokensDebited: outcome.debit.tokensDebited,
      overflowTokens: outcome.overflowTokens,
      paidFromBackingMicro: outcome.payout.amountMicro,
      billedToBalanceMicro: billed,
      debitError: null,
    }
  }

  private billAtList(owner: string, tokens: number, operator: MockOperator): number {
    const amount = costMicro(this.listPriceMicroPerM, tokens)
    const balance = this.balanceOf(owner)
    if (balance < amount)
      throw new Error(`insufficient balance for ${owner}: have ${balance}, need ${amount}`)
    this.balances.set(owner, balance - amount)
    operator.pay(amount, 'balance')
    return amount
  }
}
