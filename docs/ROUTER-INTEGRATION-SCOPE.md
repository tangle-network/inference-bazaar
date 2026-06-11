# Router integration — scoped PR plan to make Surplus real end-to-end

> Companion to [PAYMENT-ARCHITECTURE.md](./PAYMENT-ARCHITECTURE.md). Every target
> below is a real `file:line` confirmed by reading source. Three changes, in
> dependency order. Each is independently shippable and independently valuable.

Goal state: a buyer points an OpenAI client at `https://router.tangle.tools/v1`,
and **either** (a) pays per-call in plain USDC, **or** (b) auto-spends a discounted
surplus credit they hold — both routed to a bonded operator, no new base URL, no
shielded pool required unless they want privacy.

---

## PR 1 — Plain-USDC pay-per-call rail (the missing "normal crypto" route)

> **Status: IMPLEMENTED (operator side), in review.** The operator + library legs
> are built, tested, and PR'd:
> - `tangle-inference-core#1` — persistent replay store + dual-rail
>   `CompositeProvider` + `PaymentMode::Both` (16 lib + 47 integration tests green).
> - `llm-inference-blueprint#13` — `ChatCompletionRequest.payment` + the Direct
>   branch, additive to shielded (26/26 server_tests green).
>
> A buyer can now pay per call in plain USDC to a decentralized vLLM operator with
> no shielded pool. **Remaining:** step 2 below (the router's `/v1/chat/completions`
> forward path for the direct/x402 proof) — the live Next.js route, deferred to a
> reviewed PR.

**Why:** today the only crypto rail forces a VAnchor shielded-pool deposit first.
This adds the low-friction "sign one payment per call" UX. The verification
primitive already exists and is tested — this PR *wires* it.

**Repos: `tangle-inference-core` + `llm-inference-blueprint` + `tangle-router`.**

1. **Operator: accept a direct payment proof.**
   `llm-inference-blueprint/operator/src/server.rs:183` — `ChatCompletionRequest`
   has only `spend_auth: Option<SpendAuthPayload>`. Add `payment: Option<PaymentProof>`
   and, when present, route through the **existing** `payment_gate(... body_payment ...)`
   (`tangle-inference-core/src/server.rs:761`) instead of `validate_spend_auth`.
   `PaymentMode::Direct` + `DirectProvider` (`payment.rs:114`, verifies an on-chain
   ERC-20 `transfer(operator, amount)` by `tx_hash`, replay-guarded, pinned token)
   are already built — this is wiring, not new crypto.
   - **Gotcha to fix first:** `DirectProvider`'s replay set is in-memory
     (`RwLock<HashSet>`) — persist it (operator restart currently forgets used
     tx hashes → replay). Tracked in the inference-core audit notes.

2. **Router: accept + forward a direct payment.**
   `tangle-router/app/api/chat/route.ts:2513` gates on `x-payment-signature`. Add a
   sibling branch on a new header (recommend the **real Coinbase x402** `X-PAYMENT`
   envelope with EIP-3009 `transferWithAuthorization` over USDC, so off-the-shelf
   x402 clients work) that forwards the proof to the operator and **skips** the
   `checkCredits` gate exactly like the SpendAuth short-circuit at `route.ts:2633`
   (`if (!spendAuthSettled)`). Advertise it in the 402 challenge
   (`route.ts:2678` `X-Payment-Methods: credits,spend_auth` → add `,usdc`).

3. **Token:** settle in real USDC (the operator's pinned `payment_token_address`,
   `tangle-inference-core/src/config.rs:134`), not tsUSD, for the direct rail.

**Effort:** M (wiring + one new router branch + x402 envelope parsing).
**Risk:** Medium — touches the live billing path; must stay fail-closed (only mark
paid after on-chain confirmation, mirror `route.ts:2596`). Ship behind a per-model
flag.
**Decouples from Surplus entirely** — this is a general router capability that also
benefits every other blueprint. Build it first; it's the highest-leverage and
least Surplus-specific.

---

## PR 2 — Surplus-credit redemption hook (held credits auto-apply)

**Why:** makes a bought credit lot actually spendable on `/v1/chat/completions`.
This is the "[ ] live router integration" box (`redemption-debit.md:260`).

**Repo: `tangle-router` (+ a read API on the surplus venue/settlement).**

**Insertion point — corrected:** *not* inside `lib/credit-check.ts` (that returns a
USD balance; a credit is a per-`(model,kind)` token claim). It is a **pre-flight
short-circuit branch in the chat route**, parallel to SpendAuth:

```
route.ts, after model resolution, BEFORE the credit/balance gate (~:2510):
  const credit = await surplusSelectCredit(userId|address, resolvedModel, kind)   // adapter.ts:selectCredit
  if (credit) {
     route the request to credit.boundOperator                                    // sourcing pinned to the lot's issuer
     serve + meter as normal
     surplusRedeem(credit, meteredTokens)  → emits the operator SpendAuth/payout   // shielded-rail.ts:authorize
     spendAuthSettled = true   // reuse the existing short-circuit so checkCredits is skipped (route.ts:2633)
     return
  }
  // else fall through to today's gate unchanged
```

The contract for this already exists: `packages/redemption/adapter.ts:27`
`selectCredit(owner, model, tokenKind, ts) → Credit | null` and
`redeem(MeteredCall) → payout` (soonest-expiry-first, `:45-54`). The router needs a
read path to the credit book — expose `GET /credits?owner=&model=&kind=` on the
surplus venue (or read `SurplusSettlement.lots()` on-chain, already done client-side
in `app/src/lib/settlement.ts:168`).

**Known imprecision to close:** the SpendAuth is signed pre-serve so it claims the
*authorized* amount, not the *metered* amount (`redemption-debit.md:245`). Fix by
authorizing-after-metering (the router already knows the metered count at claim
time) or capping at metered in `claimPayment`.

**Effort:** M. **Risk:** Medium (new spend path; fail-closed: a failed redeem must
fall through to normal billing, never serve free). **Depends on:** a real settlement
token (see PR 3 prerequisite) and the credit-book read API.

---

## PR 3 — Operators as routable inference providers + minimum-discount routing

**Why:** "route me to the cheapest operator for this model" needs (a) surplus
inference operators in the router's provider catalog with a price, and (b) a
buy-side, price-aware ordering. Today neither exists for surplus operators.

1. **Register inference operators in the router catalog.** The router already reads
   `GET /api/operators` with `RouterOperator { endpointUrl, models[].inputPrice/outputPrice }`
   (`packages/router-bridge/src/router-client.ts:24-40`). A surplus *inference*
   operator (llm-inference-blueprint, `InferenceBSM.configureModel(pricePerInputToken,
   pricePerOutputToken)` + `onRegister` endpoint) must publish into that catalog with
   its **discounted** price. (The surplus *market-venue* operator does not serve
   inference — keep the roles separate.)

2. **Minimum-discount routing — a NEW buy-side policy.** Express it via the router's
   existing `gatewayOpts.order` / `routeTo` override (`tangle-router/lib/routing-rules.ts`,
   used at `route.ts:2427`): order candidate operators by effective price ascending,
   health-gated by `lib/provider-health.ts`.
   - **Do NOT reuse `router-bridge/selection.ts`** — that is the *sell-side*
     anti-stickiness selector built to spread a seller across operators for privacy
     (`selection.ts:6-10`); it explicitly avoids cheapest-routing. Buy-side cheapest
     and sell-side spread are different policies on different sides of the trade.

**Effort:** M–L. **Risk:** Low-Medium (routing/ordering; no new money path if PR 1/2
landed). **This is where "Minimum-Discount Routing" from the docs becomes code.**

---

## Surplus-side prerequisites (do in this repo, no router dependency)

- **Replace MockUSD with the real settlement asset.** `SurplusSettlement` is
  deployed against `0x14Ff92…` MockUSD (`app/src/lib/settlement.ts:17`). For prod,
  point `paymentToken` at real USDC (Base) or the canonical tsUSD, and align the
  redemption SpendAuth `amount` units. Until then, lots are test-token-backed.
- **Credit-book read API** for PR 2 (`GET /credits?owner=&model=&kind=` on the venue).
- **App: "Connect your app" surface** — show the buyer the real base URL
  (`https://router.tangle.tools/v1`), their key, an OpenAI snippet, and the payment
  methods that actually exist (platform balance + shielded today; mark direct-USDC
  "rolling out" until PR 1 lands — no fake readiness).
- **App: pay-as-you-go affordance** — once PR 1 lands, a "use inference now, pay per
  call in USDC" path that needs no prepaid lot. Until then, the lot market is the
  only on-chain product and should be labelled as price-lock + privacy, not as the
  only way to consume.

## Sequencing

```
PR 1 (plain-USDC rail)  ──▶  unblocks pay-as-you-go UX everywhere
        │
PR 3 (operator catalog + min-discount routing)  ──▶  "route to cheapest operator"
        │
PR 2 (credit redemption hook)  ──▶  prepaid lots become spendable
        ▲
        └── prerequisite: real settlement token + credit-book read API (surplus repo)
```

Land PR 1 first: it's the most valuable, the least Surplus-specific, and it
delivers the "pay with normal crypto" rail you want without depending on the credit
market at all. PRs 2–3 then layer the discounted-market product on top.
