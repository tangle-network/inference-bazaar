# Surplus Intelligence — Architecture

> An open market for AI inference. **Buy** discounted inference. **Sell** your
> surplus inference. Operators **make markets** in inference tokens; the spread
> is the product.

This repo is the blueprint that builds that system. It trades **prepaid
inference token credits**: collateral-backed lots that a holder redeems for real
inference served by the operator that sold them.

## The shipped shape (two-layer liquidity)

This is the live architecture, not a plan:

- **Within a service instance** — ONE shared order book per instrument, matched by
  a **rotating epoch-matcher** over the instance's bonded operators. Matching is
  set-deterministic (`crates/matcher::match_epoch`, a pure function of the order
  SET with a digest tiebreak — no sequencing discretion), driven by
  `operator/src/clob.rs` over a PKI-gated gossip mesh (`operator/src/mesh.rs`,
  blueprint-networking). A batch settles either **attested** (the issuing-book
  quorum re-runs the match and co-signs) or **proven** (an SP1 proof that runs
  the SAME `match_epoch` in-circuit — `zk/program` — and commits the input-set
  commitment + fills, so a lone prover has no pairing/price/omission discretion).
- **Across instances** — there is NO global matcher. The single market is the one
  canonical `SurplusSettlement` contract (book-scoped: per-instance attester
  quorum, nonce, and fee), plus blueprint-wide **NBBO aggregation**, **portable
  signed EIP-712 orders**, and a **smart-order-router** in the app.
- **Every operator is both a market-maker AND an inference server.** A seller
  backs the lots it issues by serving the model itself (`operator/src/inference.rs`:
  managed vLLM or an OpenAI-compatible backend) — router-proxy reselling is
  refused on a bonded issuer. Redemption settles against a **work-committed
  receipt** (proof of the model + request + output served), with a holder-
  challenge window on the quorum path.

The quoting brain (where to price) is the stateless `mm-sidecar` over
`@surplus/market-core`; execution (which crossing orders fill) is the epoch
matcher. See [The market-making loop](#the-market-making-loop).

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

### `@surplus/mm-loop` — OFFLINE research / agentic-quoting prototype

A single-operator, continuous Avellaneda–Stoikov session built on the
agent-runtime loops API (`@tangle-network/agent-runtime/loops`). **It is NOT the
production maker** — nothing in the operator, sidecar, or any deploy unit imports
it. It exists for two things: offline parameter sweeps (`@surplus/mm-eval`) and
as the worked example of *agentic* quoting (an LLM in the quote loop) that a
future sidecar can adopt behind the same `/quote` HTTP contract. The live quoting
brain is the stateless `mm-sidecar` (below); the live *matching* is the
set-deterministic epoch matcher (the continuous single-operator session can't
give peers the bit-identical re-execution the shared book's co-signing needs).
See [The market-making loop](#the-market-making-loop).

### `@surplus/router-bridge` — payments + privacy

- **`RouterClient`** — typed reads of the router's public surface: `/v1/models`
  (→ reference pricing) and `/api/operators` (→ who can sell / relay).
- **`SpendAuth`** — a byte-for-byte mirror of tangle-router's
  `lib/shielded/spend-auth.ts` EIP-712 typed data, so marketplace settlement
  signs exactly what operators and the `ShieldedCredits` contract already verify.
- **Tor privacy** — `TorTransport` (tunnel via Arti's SOCKS proxy) +
  `selectOperators` / `OperatorMemory` anti-stickiness. See [Privacy](#privacy-tor-via-arti-on-the-sell-side).

---

## The market-making loop

> Scope: this describes the `@surplus/mm-loop` **research/agentic-prototype**
> session shape. In production, quoting is the stateless `mm-sidecar` (one
> risk-gated A–S quote set per `/quote` call, driven by the seed.sh tick) and
> matching is the epoch matcher — NOT a continuous in-process runLoop. The two
> share the same `@surplus/market-core` math; this section documents the loop
> kernel that the offline harness and the future agentic sidecar run on.

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

### Rail 3 — Firm (the settlement spine)

The rail that makes "cross the spread and DEFINITELY get your token spend"
true. Four layers, all built:

**1. Discovery — CLOB + RFQ, one signed struct.** A CLOB order and an RFQ
response are the *same* EIP-712 `Order` (`instrument, side, price, qty, lotId,
trader, expiry, salt` under domain `SurplusSettlement/1`). RFQ
(`POST /rfq`) returns a firm, signed, short-TTL quote for exactly the
requested size, priced by the risk-gated sidecar and never better for the
taker than the risk gate allowed; the requester countersigns and crosses
(`POST /rfq/fill`) or posts to the book (`POST /order-signed`). Matching two
signed orders yields a `SignedFill` — the atomic settlement unit.

**2. Commitment — signatures, not promises.** The venue verifies every order
signature at intake, but it is only a relayer: the contract re-verifies
everything, so a malicious venue can censor, never forge or alter a fill.
Firm quotes bound maker exposure by `expiry` (default TTL 120s); `cancelOrder`
is the on-chain kill switch.

**3. Settlement — atomic by construction** (`contracts/src/SurplusSettlement.sol`).
There is deliberately **no escrow-then-release two-phase flow**: buyers deposit
tsUSD into a balance they can withdraw at any time, and `settleFills` debits
the buyer, pays the seller (minus the platform fee), and mints/transfers the
credit lot in ONE transaction with no external calls — it either all happens
or none of it does, which *eliminates* the "paid, no credit" window instead of
timeout-patching it. Cumulative per-order fill caps (`filled[orderHash]`),
limit-price bounds, expiry and cancellation are all contract-enforced. Batch
compression shares one boundary with two verifiers:
`settleBatchAttested` (m-of-n attester quorum over `(batchNonce, fillsHash)`)
and `settleBatchProven` (SP1 proof committing
`abi.encode(domainSeparator, fillsHash)`). In both, signature validity is the
ONLY delegated check — limits, caps, and balance invariants are still enforced
on-chain, so a rogue quorum can at most vouch for signatures that were never
made, not invent balances. The SP1 program (`zk/program`) shares the exact
digest/recovery code with the venue via `crates/settlement-core`; byte parity
across Solidity ↔ Rust ↔ TS is pinned by fixture tests on all three sides.

**4. Redemption guarantee — collateral first, slashing second.** A credit lot
is a claim on its bonded *issuer*. Minting requires payment-token collateral
≥ outstanding refund value × (1 + default penalty), checked at mint and on
collateral withdrawal — every lot is fully cash-backed on-chain. Redemption
opens a deadline (`redemptionWindow`); the issuer serves through the router
and settles with the holder's signed `RedemptionReceipt` (or an attester
quorum in dispute). Deadline missed → `claimDefault` repays the holder the
lot's paid value **plus the penalty, straight from issuer collateral** —
compensation never depends on slash routing, because Tangle slashes flow to
the staking system, not the harmed buyer. The default is recorded on-chain and
`SurplusBSM.challengeDefault` (permissionless — the record is objective)
proposes a restake slash through tnt-core's `proposeSlash` as deterrence on
top. Expired lots refund their unredeemed value the same way: paid, unserved
spend always comes back as cash.

Proven live end to end (`scripts/settlement-e2e.sh`, against anvil): atomic
fill → receipt redemption → collateral default with penalty → 2-of-3 attested
batch → SP1-public-values-bound proven batch. The SP1 program executes the
same fills in ~11.4M cycles (`zk/prover`, execute mode); a tampered signature
makes the batch uncommittable.

---

## Privacy: Tor (via Arti) on the sell side

> *The ask:* when people sell unused tokens, preserve their privacy so the
> router doesn't keep routing them to the same operators, which would let those
> operators correlate and de-anonymize the seller.

A shielded credit account hides *identity on-chain*. It does **not** hide the
*fulfillment path*: redeeming surplus inference is the seller's CLIENT dialing an
operator's `/redeem` — the operator sees the source IP at that moment and, if
always the same operator, can correlate timing + volume across redemptions and
re-link the seller. The leak is on the **inbound** leg, so the fix lives on the
**redemption client**, not the operator (which is the server there and cannot
anonymize its own inbound peers). Two separable problems, two layers:

### 1. Network anonymity → Tor, via Arti (not hand-rolled), on the client

We do **not** roll our own onion crypto. Network-layer anonymity is delegated to
**Tor** through **Arti** (`arti-client`). The seller's redemption client reaches
operators as Tor **onion services** (`http://<...>.onion`) or clearnet via a Tor
exit, so the operator never learns the seller's IP. This requires operators to
**publish `.onion` endpoints** in the venue registry (deploy work).

Two integration points, both real:
- **App / redemption client** (the leaking leg): `@surplus/router-bridge` ships
  `TorTransport` + `TorRedemptionClient` — an HTTP(S) transport tunneling every
  request through Arti's local **SOCKS5** proxy (`.onion` resolves inside Tor;
  default listener 9150). Tested against a real in-process SOCKS5 conversation.
  *(Wiring the app's redemption fetch through it is the remaining app step once
  operators publish onions.)*
- **Operator outbound** (`PRIVACY_MODE=tor`): when the operator itself is an
  outbound client — a remote OpenAI-compatible backend, or acting as a redemption
  client to another operator — `operator/src/inference.rs` routes through Arti's
  SOCKS5 (`socks5h`, `SURPLUS_TOR_SOCKS`). This protects the operator's own calls;
  it does not (and cannot) anonymize sellers dialing it.

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
| `TradingVault` + validator-signed envelope          | `SurplusSettlement` + attester-quorum / SP1-proven batches  | **built** |
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
