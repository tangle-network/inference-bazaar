# Spec — Redemption debit + router adapter (`@surplus/redemption`)

**Phase 5 of `ROADMAP.md`. Delivers gate G1: a bought credit is spendable on real
inference.** This is the spending/metering side of the system. It is
**non-colliding** with the settlement-agent's work (they own issuance + escrow +
RFQ; this owns what happens when a buyer *uses* the credit they were issued).

Status: **implemented** — `packages/redemption`, 12 tests green. Only the
live-router wiring checkbox remains (Phase 8).

---

## 1. The problem in one paragraph

The market trades, and settlement issues a buyer a credit. But a credit is
worthless unless it can be *spent on inference*. The unit on the orderbook
(tokens of a specific model + token-kind) must be the **same unit** consumed when
the buyer makes an inference call. A credit is therefore **not** a transferable
bag of ERC-20s — it is a *prepaid, price-locked, metered quota*: "N tokens of
`model:tokenKind` at locked strike price P, redeemable through the Tangle Router
until consumed or expired." This package proves that unit **closes** (tokens
bought = tokens metered = tokens spent), and defines the seam the router
implements to debit a credit per call.

## 2. Scope

**In scope (build this):**
- A `Credit` model + a pure, deterministic **debit accounting** engine.
- The **router metering adapter interface** — the typed seam the Tangle Router
  implements to recognize a Surplus credit and debit its quota per call.
- An **end-to-end redemption proof**: buy → meter N calls → debit at strike →
  operator paid from escrow → exhaust → next credit / refund.
- A `SimulatedRouter` + `MockOperator` so the proof runs with no live deps.

**Out of scope (do NOT build — other owners / later phases):**
- Credit *issuance*, escrow, RFQ, signed quotes, batch settlement → settlement-agent (Phase 4).
- Slashing on refusal, double-spend nonce enforcement → Phase 6.
- The live router code itself → this package defines the *interface*; wiring it
  into the real router is the last checkbox (Phase 5, "Live router integration").
- Any change to `market-core`, `mm-loop`, `mm-sidecar`, `orderbook`, `operator`.

## 3. Units (inherited, do not redefine)

Same as the rest of the system (`market-core/types`):
- token quantity: integer tokens.
- price: integer **micro-tsUSD per 1M tokens** (e.g. `15_000_000` = $15.00/M).
- money / notional / backing: integer **micro-tsUSD** (base units; $1 = 1e6).
- Cost of `qty` tokens at price `p`: `round(p * qty / 1_000_000)` micro-tsUSD
  (reuse `tokenLotCostBaseUnits` from `@surplus/router-bridge`).

## 4. Types

```ts
/** A prepaid, price-locked, metered inference quota — what a buyer holds. */
export interface Credit {
  id: string
  owner: string                 // platform user id or shielded commitment
  model: string                 // e.g. 'anthropic/claude-opus-4-8'
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
```

## 5. The invariant (this is the whole point)

At all times, for every credit:

```
backingMicro == tokenLotCostBaseUnits(strikeMicroPerM, qtyRemaining)
```

and across any redemption sequence:

```
qtyIssued == qtyRemaining + sum(tokensDebited)               // quota conserved
backingIssued == backingRemaining + sum(operatorPayoutMicro) // money conserved
```

Refund on exhaustion/expiry returns exactly `backingRemaining` to... whoever the
issuance side designates (out of scope here — emit a `RefundIntent`, don't move
money). The proof asserts these three equalities hold after every debit.

## 6. The debit engine (pure)

```ts
export class CreditBook {
  issue(credit: Credit): void          // accept a credit minted by settlement
  get(creditId: string): Credit | undefined
  /**
   * Debit a metered call against its credit at the locked strike. Partial-call
   * semantics: if the call meters more tokens than remain, debit what remains,
   * mark exhausted, and return `insufficient-quota` info so the router can
   * fall back to the next credit / balance for the overflow. NEVER over-debit.
   */
  debit(call: MeteredCall): DebitResult | DebitError
  /** Refund the unspent backing (expiry or explicit close). Emits a RefundIntent. */
  close(creditId: string, ts: number): RefundIntent | undefined
}
```

Deterministic, no clock reads (ts is passed in), no money movement — it computes
*what should move* and emits intents, mirroring how the operator emits settlement
intents today. The settlement side executes them.

## 7. Router metering adapter interface (the seam)

This is the contract the **Tangle Router** implements (or calls) so a Surplus
credit is spendable. Define it here; the router implements it later.

```ts
/**
 * The router consults this on each inference call to decide whether a Surplus
 * credit covers it, and to debit the credit after metering. The router still
 * does the actual inference + token metering; this only handles credit
 * selection + debit + operator payout instruction.
 */
export interface RedemptionAdapter {
  /**
   * Before serving: does this user hold a credit that covers (model, tokenKind)?
   * Returns the credit to debit, or null to fall back to normal balance.
   * Selection policy (e.g. soonest-expiry-first) lives here.
   */
  selectCredit(owner: string, model: string, tokenKind: 'input' | 'output', ts: number): Credit | null

  /**
   * After serving + metering: debit the credit for the metered tokens. Returns
   * the payout instruction (operator, micro-tsUSD) the router/settlement clears,
   * plus any overflow tokens the credit could not cover (bill normally).
   */
  redeem(call: MeteredCall): {
    debit: DebitResult
    overflowTokens: number       // metered beyond quota — router bills these at list
    payout: { operator: string; amountMicro: number }
  } | DebitError
}
```

**Router integration shape (documentation, for the live wiring checkbox):** the
router's `/v1/chat/completions` path calls `selectCredit` pre-flight; if a credit
is returned, it serves inference, meters usage as today, then calls `redeem` with
the metered token count; the operator is paid `payout` from backing instead of
the buyer's USD balance; `overflowTokens` are billed normally. No change to the
router's metering — only the *source of funds* changes when a credit applies.

## 8. Proof harness (the deliverable that closes G1)

Build `SimulatedRouter` + `MockOperator` and an e2e test asserting:

1. **Unit closure.** Issue a 100k-token credit at $14.90/M. Meter a sequence of
   calls totaling 100k tokens. Assert `sum(tokensDebited) == 100_000`,
   `qtyRemaining == 0`, and the invariant (§5) holds after *every* debit.
2. **Operator paid from backing, not buyer.** Assert total operator payout ==
   issued backing, and the buyer's USD balance is untouched.
3. **Overflow falls back.** A call metering more than remains debits the
   remainder, returns `overflowTokens`, and the router bills those normally.
4. **Expiry refunds the remainder.** A call after `expiry` is rejected; `close`
   emits a `RefundIntent` for exactly `backingRemaining`.
5. **Wrong instrument rejected.** A credit for `:output` cannot pay an `:input`
   call.
6. **Determinism.** Same call sequence → same debits + payouts.

## 9. Package layout

```
packages/redemption/
  package.json        # deps: @surplus/router-bridge (tokenLotCostBaseUnits) only
  src/
    types.ts          # Credit, MeteredCall, DebitResult, DebitError, RefundIntent
    credit-book.ts    # CreditBook (the pure debit engine)
    adapter.ts        # RedemptionAdapter interface + a DefaultRedemptionAdapter
    sim-router.ts     # SimulatedRouter + MockOperator (proof scaffolding)
    index.ts
  tests/
    closure.test.ts   # §8.1–8.2 unit closure + operator-paid-from-backing
    redemption.test.ts# §8.3–8.6 overflow, expiry, wrong-instrument, determinism
```

## 9.5 Live rail without router changes: ShieldedCredits + SpendAuth

The router's existing x402 path already implements the spend leg: verify
`X-Payment-Signature`, skip balance billing entirely, proxy to the operator,
claim the authorized amount to the operator on-chain. `shielded-rail.ts` maps
the debit engine onto it:

- **Issuance (settlement side):** fund a *dedicated* ShieldedCredits
  commitment with exactly `backingMicro`; hand the buyer the spending key.
  That commitment is the credit's escrow — it cannot fund more than
  `qtyIssued` tokens at strike, so the quota is enforced in money terms
  on-chain.
- **Spend (this package):** `ShieldedRedemptionPlanner.authorize(call)`
  debits the book and emits a SpendAuth whose `amount` is exactly the debit's
  operator payout, pinned to the selling operator's address (the router
  rejects auths whose operator ≠ routed operator, so only the seller can
  serve and claim). Nonces are per-commitment monotonic and only consumed by
  successful debits. Sum of auth amounts over any sequence == backing issued
  (proven in `shielded-rail.test.ts`).
- **Distinct flows:** crossing the spread (buying the lot) pays
  `strike × qty` once via settlement's rails; that payment *funds* this
  commitment. Redemption then meters it out to the operator per call. Credits
  are deliberately NOT bearer ERC-20s (§1) — secondary trading is re-listing
  the unspent remainder on the orderbook (close + refund + reissue), not
  wallet transfers.
- **Known imprecision (router-side, later):** `claimPayment(authHash,
  recipient)` claims the *authorized* amount, and SpendAuth is signed
  pre-serve — exact per-call closure on the live rail therefore requires the
  planner to be driven by *metered* counts (authorize-after-meter, as the
  operator venue does) or the small router change to claim metered cost.
  Refusal of a valid pinned auth is the Phase 6 slashing condition; the
  escrow itself protects principal (unserved backing refunds at expiry).

## 10. Acceptance criteria (Phase 5 boxes in ROADMAP.md)

- [x] `CreditBook` debit closes the unit; §5 invariants hold after every debit.
  *(closure.test.ts green)*
- [x] `RedemptionAdapter` selects + debits + instructs operator payout; simulated
  router pays the operator from backing. *(redemption.test.ts green)*
- [x] e2e proof: buy → meter → debit → pay → exhaust → refund. *(both suites)*
- [ ] Live router integration: a real `/v1/chat/completions` debits a real
  credit. *(separate — needs router code; opens the tcloud PR in Phase 8.)*

## 11. Definition of done

`pnpm --filter @surplus/redemption test` green; `typecheck` clean; the e2e proof
demonstrates **tokens bought = tokens metered = tokens spent** with money
conserved (operator payouts == backing). At that point a Surplus credit is
*provably* spendable inference, and only the live-router wiring remains.
