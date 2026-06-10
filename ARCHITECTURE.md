# Surplus Intelligence — Architecture

> An open market for AI inference. **Buy** discounted inference. **Sell** your
> surplus inference. Operators **make markets** in inference tokens; the spread
> is the product.

This repo is the blueprint that builds that system. It clones the shape of the
**ai-trading-blueprint** (operator-run autonomous agents, an arena UI, on-chain
settlement, a validator-gated execution envelope) but trades a different asset:
**prepaid inference tokens**, redeemable through the **Tangle Router** against
real LLM operators.

The deliverable in this commit is the **engine** — the market, the
market-making loop, and the router/privacy bridge — built and tested. The
operator service, contracts, and arena UI are migrations layered on top of
proven inference + trading blueprints; the map for that work is in
[Blueprint migration](#blueprint-migration).

---

## What is being traded

A **token credit** is the right to redeem N tokens of inference for a specific
`(model, tokenKind)` through the router. One instrument per `(model, input|output)`:

```
anthropic/claude-opus-4-8:output   — output tokens for Opus 4.8
anthropic/claude-opus-4-8:input    — input tokens for Opus 4.8
...
```

Units, fixed across the whole system (`@surplus/market-core/types`):

| Quantity   | Unit                                          |
|------------|-----------------------------------------------|
| quantity   | tokens (integer)                              |
| price      | micro-tsUSD per **1M tokens** (integer)       |
| notional   | micro-tsUSD (integer, half-up at fill)        |

`tsUSD` has 6 decimals, so a price of `15_000_000` = **$15.00 per 1M tokens** —
the same number the router reports as `pricing.completion = "0.000015"` USD/token.
`@surplus/router-bridge` does that conversion (`usdPerTokenToMicroPerM`).

### Two sides of the market

- **Sellers** hold surplus inference (an operator with idle GPUs, or a buyer
  who over-purchased a prepaid pack) and list **asks**.
- **Buyers** want inference below list price and lift **bids** / hit asks.
- **Operators / market makers** quote **both sides** continuously, earning the
  spread and absorbing inventory risk. This is the role the blueprint onboards.

The **reference price** the market quotes around is the router's own list price
for the model (`RouterClient.referenceQuote`). The market discovers a *discount*
to list; it never invents a price from nothing.

---

## Packages

```
packages/
  market-core/     domain: orderbook, quoting, risk, ledger, simulator   (no deps)
  mm-loop/         THE LOOP: market-making on @tangle-network/agent-runtime
  router-bridge/   Tangle Router client, ShieldedCredits SpendAuth, Tor (Arti) privacy
```

### `@surplus/market-core` — the market

Pure, dependency-free, deterministic. Nothing reads a clock; timestamps are
caller-supplied, so every test asserts exact behavior and every session replays.

- **`OrderBook`** — price-time priority limit book. Matching at maker price,
  partial fills, self-match prevention (cancels the resting maker rather than
  printing a wash trade), tick/min-qty validation, aggregated depth snapshots.
- **`computeQuotes`** — inventory-aware two-sided quoting, Avellaneda–Stoikov
  style. Reservation price `r = mid − q·γ·σ²·τ` skews away from held inventory;
  half-spread `γσ²τ/2 + (1/γ)ln(1+γ/k)`. Pulls a side at the inventory cap.
- **`assessQuotes`** — the **pre-trade risk gate**. Inventory caps, per-quote
  notional caps, max deviation from reference, min spread, and a drawdown
  **kill switch**. Fail-closed: one violation invalidates the whole quote set.
- **`Ledger`** — average-cost position + PnL + mark-to-reference + drawdown.
- **`SimulatedMarket`** — seeded venue: reference price on a geometric random
  walk, Poisson taker flow crossing the book. Deterministic given a seed.

### `@surplus/mm-loop` — the loop you asked for

The market-making agent built **directly on the agent-runtime loops API**
(`@tangle-network/agent-runtime/loops`, the `./loops` subpath of v0.48.0). It
is a `runLoop` driven loop. See [The loop](#the-loop).

### `@surplus/router-bridge` — payments + privacy

- **`RouterClient`** — typed reads of the router's public surface: `/v1/models`
  (→ reference pricing) and `/api/operators` (→ who can sell / relay).
- **`SpendAuth`** — a byte-for-byte mirror of tangle-router's
  `lib/shielded/spend-auth.ts` EIP-712 typed data, so marketplace settlement
  signs exactly what operators and the `ShieldedCredits` contract already verify.
- **Tor privacy** — `TorTransport` (tunnel via Arti's SOCKS proxy) +
  `selectOperators` / `OperatorMemory` anti-stickiness. See [Privacy](#privacy-tor-via-arti-on-the-sell-side).

---

## The loop

A **market-making session is one `runLoop` run**. The mapping onto the
agent-runtime loop kernel:

| Loop concept       | Surplus binding                                                        |
|--------------------|------------------------------------------------------------------------|
| `Task`             | `MarketTick` — a full snapshot (ref mid, book, inventory, equity, params, limits) |
| `Driver`           | `marketMakerDriver` — refine chain, one round = one market tick         |
| `AgentRunSpec`     | algorithmic A–S quoter (inline) **or** an agentic sandbox run           |
| `OutputAdapter`    | `quoteSetOutput` — sandbox event stream → `QuoteSet` (bare/fenced/prose JSON) |
| `Validator`        | `riskValidator` — the risk gate as the loop's scorer; verdict steers the driver |
| `Decision`         | `'continue' | 'done' | 'fail'`                                          |

### Control flow

`plan()` is the **only** place venue state moves — this is what makes a session
replayable and every state transition attributable to a loop round:

```
round N  plan():     commit round N-1's quotes IFF the risk gate passed
                     (else pull stale quotes), advance market time one tick,
                     observe → emit the next MarketTick task   (or [] to end)
round N  batch:      executor quotes for that tick
                     · algorithmic: Avellaneda–Stoikov, 0 tokens, deterministic
                     · agentic:     a sandboxed agent answers with a JSON quote
round N  validate:   riskValidator scores the quote set, records the verdict
                     on the session (so a kill switch acts the NEXT round)
...
decide():            'fail' on kill switch · 'done' on horizon · else 'continue'
```

The risk gate is the safety boundary **by wiring, not convention**: a quote set
with `valid: false` is never applied to the venue. An agent can return anything;
out-of-limits quotes are discarded unplaced (proven by the
`rejects malformed and limit-breaching agent output` test — 0 fills, 5 rejected
ticks, every verdict invalid).

### Two modes, one kernel

```ts
import { runMarketMakingLoop, SimVenue, agenticRunSpec } from '@surplus/mm-loop'

// Algorithmic (default): deterministic A–S quoter, no sandbox, no tokens.
const result = await runMarketMakingLoop({ venue, params, limits, horizonTicks: 120 })

// Agentic: bring a real @tangle-network/sandbox client + a harness profile.
const result = await runMarketMakingLoop({
  venue, params, limits, horizonTicks: 120,
  mode: 'agentic',
  sandboxClient,                                  // real sandbox SDK client
  agentRun: agenticRunSpec({ name: 'claude-code' }),
})
```

The algorithmic executor is wired through the runtime's **own**
`inlineSandboxClient` shell — the documented adapter for presenting a non-box
executor as a `SandboxClient` — so the deterministic quoter and a real agent run
through the identical kernel, adapter, and risk gate. Swapping modes never
touches loop wiring.

### Why this shape

- **Refine chain, not fanout.** A market maker is a sequential controller over
  one evolving book, not N independent attempts at one answer. One tick per
  round, inventory carried forward.
- **The validator is the risk desk.** Reusing the loop's scorer as the pre-trade
  gate means the same code that *ranks* a quote also *authorizes* it — no second
  risk path to drift out of sync.
- **`maxConcurrency: 1`.** Ticks are causal; round N's fills change round N+1's
  inventory. Concurrency would corrupt the ledger.
- **`maxIterations = horizon + 1`.** The extra round lets the final plan() commit
  the last tick's quotes, advance, observe the horizon, and end on a clean `done`.

### Continuous operation

A session is bounded (a horizon). A production market maker runs **forever**:
the operator service runs back-to-back sessions on a tick cron (the
ai-trading-blueprint's `JOB_WORKFLOW_TICK`, default `0 */5 * * * *`), persisting
the ledger across sessions and resuming inventory. Each session is one traced,
cost-accounted `runLoop` — the unit of observability and the unit of the
analyst/self-improvement loop (`@tangle-network/agent-runtime/analyst-loop`)
that tunes `QuoteParams` from realized PnL between sessions.

---

## Payments

Two rails, matching the trading + inference blueprints already in the fleet.

### Rail 1 — Router-settled (Stripe / platform credits)

The path most buyers take. Identical to how `tangle-router` bills today:

1. Buyer funds a balance on `id.tangle.tools` (Stripe card / crypto on-ramp).
2. Buyer spends through the router's OpenAI-compatible `/v1/chat/completions`.
3. The router deducts from the buyer's balance, pays the fulfilling operator
   their cut (`PlatformRevenue` / `OperatorPayout`, default 20% platform take).

The marketplace sits **in front** of this: a buyer who holds a discounted token
lot redeems it, and the marketplace settles the difference between the lot's
strike and the router's list price. The router is the clearing house.

### Rail 2 — On-chain shielded (x402 / ShieldedCredits)

The path that makes the **sell side private** and is the native two-sided
settlement rail. Mirrors `llm-inference-blueprint` + `tangle-router/lib/shielded`:

1. A party funds a **shielded credit account** on Tangle EVM
   (`ShieldedCredits.fundCredits(commitment, amount, token)`), 6-decimal tsUSD.
2. To buy a token lot (or to claim a maker payout), they sign an **EIP-712
   `SpendAuth`** off-chain (`@surplus/router-bridge/buildSpendAuthMessage`) —
   `{ commitment, serviceId, jobIndex, amount, operator, nonce, expiry }`.
3. The operator/marketplace `authorizeSpend(auth)` on-chain, fulfills, then
   `claimPayment(authHash, recipient)`. Nonce is per-account monotonic (replay
   protection); orphaned auths reconcile via the router's `SpendAuthRefund` path.

`@surplus/router-bridge`'s SpendAuth is a deliberate copy of the router's typed
data — **drift is a fund-loss bug**; change only in lockstep with the router.

---

## Privacy: Tor (via Arti) on the sell side

> *The ask:* when people sell unused tokens, preserve their privacy so the
> router doesn't keep routing them to the same operators, which would let those
> operators correlate and de-anonymize the seller.

A shielded credit account hides *identity on-chain*. It does **not** hide the
*fulfillment path*: when surplus inference is redeemed, some operator runs it,
sees the seller's IP, and — if always the same operator — can correlate timing +
volume across redemptions and re-link the seller. Two separable problems, solved
by two layers:

### 1. Network anonymity → Tor, via Arti (not hand-rolled)

We do **not** roll our own onion crypto. Network-layer anonymity is delegated to
**Tor** through **Arti** (`arti-client`, the Tor Project's Rust Tor
implementation). Operators are reached either as Tor **onion services**
(`http://<...>.onion`) or as clearnet HTTPS via a Tor exit, so the operator never
learns the seller's IP and no on-path observer links the two. Tor brings the
things a bespoke overlay can't: a real anonymity set, relay diversity, guard
nodes, path constraints, directory-authority consensus, and years of audit.

`@surplus/router-bridge` ships `TorTransport`: an HTTP(S) transport that tunnels
every request through Arti's local **SOCKS5** proxy (RFC 1928 — a wire protocol,
not cryptography; all anonymity is Tor's). The destination is sent as a hostname
so `.onion` names resolve inside Tor, never locally. Point `socksPort` at Arti's
listener (default 9150). Tested against a real in-process SOCKS5 conversation —
the same bytes Arti speaks; tests do **not** contact the live Tor network.

### 2. Operator-selection anti-stickiness → ours (Tor can't do it)

Tor anonymizes the pipe; it does **not** choose *which marketplace operator*
fulfills a redemption. That choice is ours, and left naive it re-introduces
concentration. `selectOperators` picks fulfilling operators weighted **away**
from the ones this seller used recently:

```
weight(op) = max(ε, 1 − penalty · recencyWeight(op))
```

`recencyWeight` decays linearly with position in the seller's recent-operator
list (last-used penalized most); `ε > 0` keeps a fully-penalized operator
*possible* (availability beats a perfect avoid). `OperatorMemory` persists that
recent list per seller — keyed by the shielded commitment — so the spread holds
**across** redemptions instead of re-rolling each time. `TorRedemptionClient`
composes the two: select an anti-sticky operator, reach it through Tor.

Tested (12 tests): the SOCKS5 handshake + HTTP tunnel round-trips through the
proxy; redemptions spread across operators; and the memory is bounded and
per-seller.

> **Feature-flag it.** `PRIVACY_MODE = tor | off`. `tor` routes through Arti;
> `off` is direct (dev/trusted networks). Caveat: Tor adds real latency, so the
> live token-by-token streaming path may run direct while redemption/settlement
> runs over Tor. Depend on the published `arti-client` crate from crates.io — not
> a GitHub mirror.

---

## Blueprint migration

Cloning the trading blueprint's structure; swapping the asset to inference
tokens; reusing the inference blueprints for the operator/sell side.

### From `ai-trading-blueprint` (the shape)

| Trading blueprint                                   | Surplus equivalent                                          | Status |
|-----------------------------------------------------|-------------------------------------------------------------|--------|
| `trading-runtime` (intents, strategy, portfolio)    | `@surplus/market-core` (orderbook, quoting, ledger, risk)   | **built** |
| trading agent sidecar (Claude in Docker)            | `@surplus/mm-loop` on agent-runtime loops                   | **built** |
| `JOB_WORKFLOW_TICK` cron (`0 */5 * * * *`)          | back-to-back MM sessions on the same tick cron              | migrate |
| `trading-blueprint-lib` jobs (provision/start/stop) | marketplace jobs (list instrument / start MM / stop / status)| migrate |
| `TradingVault` + validator-signed envelope          | token-credit vault + validator-gated lot settlement         | migrate |
| `arena/` React Router 7 + blueprint-ui UI           | marketplace arena (leaderboard, books, MM dashboards)       | clone  |
| operator TLV registration (`registration.rs`)       | operator registration (capacity, models, `.onion` address)  | migrate |

### From `llm-inference-blueprint` / `modal-inference-blueprint` (the sell side)

The operator who *sells* tokens **is** an inference operator. Reuse, don't reinvent:

- vLLM (`operator/src/vllm.rs`) or Modal (`operator/src/proxy.rs`) backends as the
  thing a token credit ultimately redeems against.
- `InferenceBSM.sol` on-chain model/price registration → the marketplace's listed
  instruments and their reference prices.
- `tangle-inference-core` billing (`authorizeSpend` → serve → `claimPayment`) →
  the shielded settlement rail above (Rail 2).
- The metering surface (`prompt_tokens` / `completion_tokens`, per-task pricing
  units) → how a redeemed lot is debited against actual usage.

### Tangle Router (the clearing house)

- `RouterClient` reads `/v1/models` (reference price) and `/api/operators`
  (sellers + their `.onion`/endpoint set). **built.**
- Buyers spend through the router's OpenAI-compatible API (Rail 1). The
  marketplace settles the discount.
- Privacy is Tor via Arti: operators run as onion services / behind Arti, the
  seller reaches them through `TorTransport`. **transport + anti-stickiness
  selection built; running Arti + publishing operator `.onion`s is
  operator-service work.**

---

## Build & test

```bash
pnpm install
pnpm -r typecheck      # strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes
pnpm -r test           # 36 tests across the three packages
pnpm demo:mm           # run the market-making loop against the simulator
```

`pnpm demo:mm` runs a 120-tick session end to end and prints the session report
(decision, fills, position, equity, realized PnL, max drawdown, kill switch).
