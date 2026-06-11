# Surplus payment & routing architecture — validated against code

> Status: validated 2026-06-11 against tangle-router, tangle-inference-core,
> llm-inference-blueprint, shielded-payment-gateway, and surplus, by reading the
> actual source (every claim below carries a `file:line`). Read this before
> touching the router or pitching the payment model — it corrects several
> intuitions that turn out to be wrong in the code.

## Why this felt confusing (it's not you — the seams are real but unwired)

The system has **three half-connected pieces**, each owned by a different repo,
and the seams between them are *designed but not yet wired*:

1. **The router's payment plane** (`tangle-router`) — how a buyer pays for one
   inference call. Today it has exactly **two** working rails: platform/Stripe
   balance (fiat) and **ShieldedCredits SpendAuth** (crypto). There is **no
   plain-USDC pay-per-call** path wired anywhere.
2. **The inference operators** (`llm-inference-blueprint` + `tangle-inference-core`)
   — who actually serves tokens and gets paid. They are hardwired to the
   ShieldedCredits SpendAuth path; a `DirectProvider` (plain-USDC) primitive
   exists but **has zero callers**.
3. **The surplus credit market** (`surplus`) — the prepaid, discounted credit
   *lots* traded on `SurplusSettlement` (currently on a **MockUSD** test token,
   not real USDC), plus a redemption design that rides the router's SpendAuth
   path. The live router hook that would make a credit spendable on a real
   `/v1/chat/completions` is an **unchecked box** (`docs/specs/redemption-debit.md:260`).

So "it only works with shielded credits" is **literally true today** for the
crypto rail — that is the only on-chain payment path the router has. The
confidence gap is real, not imagined. The rest of this doc makes the target
state precise so it stops being fuzzy.

## The one idea that dissolves the confusion: two orthogonal axes

A request has **two independent decisions**. Conflating them is the source of
the muddle.

```
            SOURCING  (who serves, at what price)          ×   SETTLEMENT  (how the buyer pays)
            ────────────────────────────────────              ──────────────────────────────────
   list     centralized provider at list price                  A. platform balance (fiat / Stripe)
   market   a surplus operator at a discount  ← the product     B. plain USDC per-call (x402 / direct)   ← MISSING
                                                                 C. shielded credit (SpendAuth)            ← only crypto rail today
                                                                 D. prepaid surplus credit LOT (redeem)    ← market product
```

**Sourcing is the market. Settlement is the wallet.** They are orthogonal: any
sourcing choice can pair with any settlement instrument. This is verified in
code — `RedemptionAdapter.selectCredit()` returns a credit *or null to fall back
to normal balance*, and "only the source of funds changes when a credit applies"
(`packages/redemption/adapter.ts:27`, `docs/specs/redemption-debit.md:185`); the
settlement layer is a per-order discriminated union `'router-credits' | 'shielded'`
dispatched on `order.rail` with an identical fee split (`router-bridge/settlement.ts:48,184`).
Operator selection takes **zero** instrument input (`router-bridge/selection.ts:40`).

Nothing fundamental forces a market buyer to hold a shielded credit. The current
coupling is **incidental** (we built the shielded rail first), not architectural.
That is the load-bearing good news: **we can add plain-USDC pay-as-you-go without
re-architecting anything** — it's a new column in the settlement axis.

## The rails, exactly as they exist in code today

### Settlement A — platform balance (fiat). WORKS.
`checkCredits()` resolves: admin-bypass → `getBalanceViaPlatform(userId)` on
id.tangle.tools → active subscription → else 0 (`tangle-router/lib/credit-check.ts:94-119`).
Funded by Stripe/on-ramp. This is how most buyers pay today. Not crypto.

### Settlement C — ShieldedCredits SpendAuth (crypto). WORKS, and is the ONLY on-chain rail.
- The buyer deposits **USDC into a VAnchor shielded pool**, minting a
  **tsUSD-denominated** (6-decimal) private credit balance bound to a `commitment`
  (`tangle-router/src/views/privacy-credits.tsx:60,155`). *(`tntUSDC` — the term
  you used — does not appear anywhere in code; the wrapped asset is tsUSD.)*
- Per call, the buyer signs an EIP-712 `SpendAuthorization`
  `{commitment, serviceId, jobIndex, amount, operator, nonce, expiry, signature}`
  and sends it as the header `x-payment-signature`
  (`tangle-router/app/api/chat/route.ts:2513`; `lib/shielded/spend-auth.ts:21-42`).
- The router `authorizeSpend` **before** serving, serves, then `claimPayment` to
  the **operator's** address **after** (`route.ts:2617,3342`). **Not atomic** —
  if serving fails between the two, the orphaned auth is dead-lettered to
  `SpendAuthRefund` and reconciled out-of-band (`route.ts:4970`, `lib/shielded/refund.ts`).
- **This is NOT Coinbase x402.** No `X-PAYMENT` envelope, no EIP-3009
  `transferWithAuthorization`, no USDC settlement, no facilitator. It is a
  Tangle-custom HTTP-402 + `X-Payment-*` header family over the ShieldedCredits
  contract. The 402 challenge advertises `X-Payment-Currency: tsUSD`,
  `X-Payment-Methods: credits,spend_auth` (`route.ts:2678`). `MPP` is an alt
  transport (`Authorization: Payment blueprintevm <b64>`) wrapping the **same**
  SpendAuth (`lib/shielded/mpp.ts`); "Tempo" is unrelated (a bridge name in
  tnt-core comments) — "MPP (Tempo)" in the docs is not a real coupled thing.

### Settlement B — plain USDC per-call (x402 / direct). PRIMITIVE EXISTS, UNWIRED.
- `tangle-inference-core/src/payment.rs:114` `DirectProvider` verifies an on-chain
  ERC-20 `transfer(operator, amount)` from a caller-supplied `tx_hash` — **no
  shielded pool, no authorize, no claim** (settle is a no-op, `:288`), with replay
  protection and a pinned token. `PaymentMode::Direct` (`config.rs:81`) and
  `payment_gate(body_payment: Option<PaymentProof>)` exist.
- **But it has zero handler callers.** The production operator
  (`llm-inference-blueprint/operator/src/server.rs:183`) has only
  `spend_auth: Option<SpendAuthPayload>` and always uses Shielded; the router only
  forwards `x-payment-signature`. Default `PaymentMode = Shielded`.
- So plain-USDC pay-as-you-go is **buildable on a tested primitive** but is not a
  live path. This is the rail you want and it's the cleanest "normal crypto" UX
  (sign one EIP-3009 / direct-transfer per call, no pool to pre-fund).

### Settlement D — prepaid surplus credit LOT. WORKS on-chain (test token), not yet redeemable through the router.
- `SurplusSettlement` (Base Sepolia `0x1cD49739…`) clears firm EIP-712 orders and
  mints collateral-backed credit *lots* against a **MockUSD** token
  (`app/src/lib/settlement.ts:16-17`). This is the secondary market for credits.
- Redemption (spending a lot on real inference) is designed to ride Settlement C's
  SpendAuth path (`packages/redemption/shielded-rail.ts`) — **the live router hook
  is unbuilt** (`redemption-debit.md:260`).

## What "decentralized inference" actually means here (and why this one is special)

You're right that this is the first real decentralized live inference on Tangle.
The distinction, in code:

- **Centralized provider** (OpenAI, Anthropic via OpenRouter): the router holds the
  key, forwards to a SaaS endpoint, bills the buyer, eats provider risk. Trust =
  the router + the SaaS.
- **Tangle inference operator** (`llm-inference-blueprint`, vLLM): an independent
  operator runs the model, is registered on-chain via `InferenceBSM` with an
  **endpoint + per-token price** (`configureModel(pricePerInputToken, pricePerOutputToken)`),
  stakes/bonds, verifies payment itself (SpendAuth today, Direct possible), serves,
  and claims payment to its own address. Trust = stake + slashing, not a SaaS.

**Surplus makes the operator's spare capacity a tradeable, discounted instrument.**
That's the special part: the credit a buyer holds is a claim on a *bonded* operator,
and "route me to the cheapest operator for this model" becomes a market outcome.
But note two corrections the audit forced:

1. The **surplus market-venue operator** (orderbook/MM in `surplus/operator`) and
   the **inference operator** (vLLM in `llm-inference-blueprint`) are **different
   roles**. The market-venue makes markets in credit lots; it does **not** serve
   `/chat/completions`. Redemption connects a lot to an *inference* operator.
   Keep them distinct in your head — conflating them is half the confusion.
2. The router-bridge `selectOperators()` deliberately routes **away** from
   recently-used operators for **seller privacy** (anti-stickiness,
   `selection.ts:6-10`) — that is the opposite of "cheapest-routing" and must not
   be reused as the buy-side router. Minimum-discount routing is a **separate,
   buy-side** policy (see scope doc).

## The privacy tradeoff, stated precisely (you want both — here's what each costs)

| | plain USDC per-call (B) | shielded SpendAuth (C) |
|---|---|---|
| Pre-funding | none — pay per call | deposit into VAnchor pool first |
| What leaks | payer address ↔ model ↔ usage, linkable across calls | commitment hides on-chain identity… |
| …but | — | …operator still sees IP + timing + volume; unlinkable **only** with Tor (Arti) + anti-sticky operator selection (`ARCHITECTURE.md:284-338`) |
| UX friction | lowest (one signature/call) | highest (fund pool, Tor latency) |
| Best for | agents, pay-as-you-go, public spend | privacy-sensitive buyers, high volume |

Both should exist. B is the **default low-friction crypto rail** most users want;
C is the **privacy upgrade**. Forcing C on everyone (today's reality) is a real UX
own-goal: it makes "just pay me in crypto for an API call" require funding a
shielded pool first. That is the single biggest product-experience gap.

## Confidence summary

- **High confidence:** the two-axis model is correct and the seams are real
  (orthogonality verified in code). Plain-USDC pay-per-call is achievable on the
  existing `DirectProvider` primitive. The redemption hook has a precise, single
  insertion point.
- **Corrected intuitions:** "x402" here is Tangle-custom, not Coinbase/USDC. The
  settlement token is tsUSD, not USDC/tntUSDC. The credit hook is a chat-route
  short-circuit (like SpendAuth), **not** a step inside `checkCredits` (which
  returns a USD balance, not a per-(model,kind) claim). The surplus operator ≠ the
  inference operator. Anti-sticky selection ≠ cheapest routing.
- **The work to close it is real and mostly cross-repo** — see
  [ROUTER-INTEGRATION-SCOPE.md](./ROUTER-INTEGRATION-SCOPE.md).
