# Inference Bazaar payment & routing architecture — validated against code

> Status: validated 2026-06-11 against tangle-router, tangle-inference-core,
> llm-inference-blueprint, shielded-payment-gateway, and inference-bazaar, by reading the
> actual source (every claim below carries a `file:line`). Read this before
> touching the router or pitching the payment model — it corrects several
> intuitions that turn out to be wrong in the code.

## Locked architecture (decided 2026-06-11)

The market structure is settled. Two independent axes — don't conflate them:

- **Liquidity (two layers).** *Within* a service instance, operators share **one
  order book per instrument** via a rotating epoch-matcher over that instance's
  bonded operators, using `blueprint-networking`'s PKI-gated gossip mesh exactly as
  designed (per-instance scoped). *Across* instances, the single market is the
  **global `InferenceBazaarSettlement` contract** + blueprint-wide **NBBO aggregation** +
  **portable signed orders** executed by a smart-order-router. There is **no**
  global matching mesh and **no** privileged venue — cross-instance convergence is
  settlement + aggregation, not one giant matcher. (Why: the matcher's trust /
  slashing boundary *is* the operator-set agreement, i.e. the instance; the gossip
  mesh is per-instance by design; the settlement contract is already global. See
  [`specs/shared-clob.md`](specs/shared-clob.md).)
- **Role.** Every operator is **both** a market-maker **and** an inference server.
  A seller backs the lots it issues by serving the model itself (the
  `llm-inference-blueprint` / `tangle-inference-core` stack imported **as a
  library**; vLLM or external OpenAI-compatible backend, configurable). The only
  singular role is *matcher-for-the-epoch*, which rotates.

This shipped via the build order (1) `BookClient` seam in `crates/orderbook` →
(2) inference-as-library in `inference-bazaar/operator` (operators serve + back their own
lots) → (3) per-instance epoch matcher + gossip + Attested/Proven batch
settlement → (4) cross-instance NBBO aggregation + SOR. The two-layer market is
the live shape; there is no per-operator-island interim anymore.

## How the pieces connect

The Inference Bazaar credit market is the firm spine and it is wired end to end:

1. **The Inference Bazaar credit market** (`inference-bazaar`) — prepaid, collateral-backed credit
   *lots* on `InferenceBazaarSettlement` (live tsUSD rail `0x3fa62248…`, real-USDC rail
   `0xf6A64921…`). Settlement is atomic; batches settle either **attested**
   (issuing-book quorum re-runs the match and co-signs) or **proven** (an SP1
   proof that runs `match_epoch` in-circuit and commits the input-set
   commitment + fills).
2. **The inference operators** — every operator both makes markets AND serves the
   model it sold from its own backend (`operator/src/inference.rs`: managed vLLM
   or a configured OpenAI-compatible URL; router-proxy mode is refused on a
   bonded issuer). A redeemed lot is debited against actual served usage, bound
   to a **work-committed receipt**.
3. **The router** (`tangle-router`) — the clearing house for reference pricing.
   Its ShieldedCredits SpendAuth rail (and the Stripe/fiat balance) remain the
   buyer-funding on-ramps; the firm spine above is the native two-sided rail.

## The one idea that dissolves the confusion: two orthogonal axes

A request has **two independent decisions**. Conflating them is the source of
the muddle.

```
            SOURCING  (who serves, at what price)          ×   SETTLEMENT  (how the buyer pays)
            ────────────────────────────────────              ──────────────────────────────────
   list     centralized provider at list price                  A. platform balance (fiat / Stripe)
   market   a discounted operator             ← the product     B. plain USDC per-call (x402 / direct)   ← MISSING
                                                                 C. shielded credit (SpendAuth)            ← only crypto rail today
                                                                 D. prepaid discounted credit LOT (redeem) ← market product
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

### Settlement D — prepaid discounted credit LOT. LIVE, redeemable for real inference.
- `InferenceBazaarSettlement` (Base Sepolia tsUSD rail `0x3fa622488fD970ECdE23b8384a98de6fFa5A1763`;
  real-USDC rail `0xf6A64921…`) clears firm EIP-712 orders and mints
  collateral-backed credit *lots* (`app/src/lib/settlement.ts:16`). This is the
  firm spine — both the primary market (a sell mints a lot against the seller's
  collateral) and the secondary market (resale).
- Redemption spends a lot on real inference: the holder opens a redemption, the
  issuer serves from its OWN backend (`operator/src/inference.rs` — router-proxy
  mode is refused on a bonded issuer), and settles with the holder's signed,
  WORK-COMMITTED receipt (`keccak256(modelIdHash, messagesHash, outputHash)`), or
  an issuing-book quorum attestation behind a holder-challenge window. A missed
  deadline pays the holder from issuer collateral (`claimDefault`).

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

**Inference Bazaar makes the operator's spare capacity a tradeable, discounted instrument.**
That's the special part: the credit a buyer holds is a claim on a *bonded* operator,
and "route me to the cheapest operator for this model" becomes a market outcome.
Two things to hold precisely:

1. **A seller operator *is* an inference operator.** An operator that issues credit
   lots must serve the inference those lots redeem to — it imports the
   `llm-inference-blueprint` / `tangle-inference-core` serving stack **as a library**
   and runs the model itself (vLLM subprocess or an external OpenAI-compatible
   backend, both configurable). Selling a lot you can't redeem isn't a market;
   serving is what *backs* the lot, and redemption serves against the operator's
   own local backend — not a remote router.
   > Correcting an earlier note here that said the market-venue operator "does **not**
   > serve `/chat/completions`" and is a "different role" from the inference operator.
   > That was wrong and contradicted `ARCHITECTURE.md:360` ("the operator who **sells**
   > tokens **is** an inference operator. Reuse, don't reinvent"). The real, orthogonal
   > distinction is **matcher vs. participant**: per service instance, one operator runs
   > the shared order book for an epoch (the matcher, rotating on-chain), while **every**
   > operator is both a market-maker *and* an inference server. See
   > [`docs/specs/shared-clob.md`](specs/shared-clob.md) and the locked architecture note
   > at the top of this file.
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
  returns a USD balance, not a per-(model,kind) claim). The market operator ≠ the
  inference operator. Anti-sticky selection ≠ cheapest routing.
- **The work to close it is real and mostly cross-repo** — see
  [ROUTER-INTEGRATION-SCOPE.md](./ROUTER-INTEGRATION-SCOPE.md).
