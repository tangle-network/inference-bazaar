# Surplus — Launch Roadmap

The single source of truth for what ships, in what order, and what "done" means.
No aspirational checkmarks: a box is checked **only** when its completion
criterion is demonstrable (a passing test, a live trace, an on-chain tx). "Built
but unverified" is not done.

Status legend: `[x]` done + verified · `[~]` in progress · `[ ]` not started.
Owner: `surplus` = this repo's main thread · `settlement-agent` = the parallel
Fable agent on the RFQ/settlement spine.

---

## Definition of Done for LIVE (the hard gates)

All of these must be simultaneously true to call Surplus production. Each links
to the phase that delivers it.

- [ ] **G1 — A credit is spendable.** A bought credit redeems into real metered
  inference through the Tangle Router, debiting its token quota at the locked
  price. *(Phase 5)*
- [ ] **G2 — Atomic fills.** A match settles all-or-nothing: buyer escrow → credit
  issued → payment released, or none of it. *(Phase 4, settlement-agent)*
- [ ] **G3 — Buyers definitely get their spend.** A credit is a claim on a bonded
  operator; refusal of a valid credit is slashable; unfulfillable → escrow
  refund. *(Phase 4 + 6, settlement-agent)*
- [ ] **G4 — The venue runs on-chain.** `workflow_tick` is triggered by a real
  on-chain job on a deployed blueprint, not an HTTP poke. *(Phase 3)*
- [ ] **G5 — Money is real.** Settlement clears on at least one rail against a
  real chain / the live router, not a stub. *(Phase 3 + 4)*
- [ ] **G6 — Contracts audited.** Every contract on the value path has a review
  sign-off. *(Phase 8)*
- [ ] **G7 — Abuse-bounded.** Rate limits, per-key spend caps, and double-spend
  protection on claim are enforced and tested. *(Phase 6)*

---

## Phase 0 — Engine (TypeScript) ✅

- [x] `@surplus/market-core`: orderbook, A–S quoting, risk gate + kill switch,
  ledger, seeded simulator. **Done:** 17 tests green.
- [x] `@surplus/mm-loop`: market-making as one `runLoop` on agent-runtime loops;
  algorithmic + agentic modes through one kernel. **Done:** 7 tests green.
- [x] `@surplus/mm-sidecar`: stateless HTTP quote server (the operator's brain).
  **Done:** 5 tests green + live `curl` smoke.
- [x] `@surplus/router-bridge`: RouterClient, SpendAuth (EIP-712 mirror),
  settlement (both rails), Tor transport, anti-sticky operator selection.
  **Done:** 17 tests green.
- [x] `@surplus/mm-eval`: deterministic param sweep + scorecard; disqualifies
  kill-switch and non-trading configs. **Done:** 5 tests green; finding logged
  (pure spread-capture ≈ breakeven-minus; edge is discount-to-list).

## Phase 1 — Open orderbook + operator venue (Rust) ✅

- [x] `crates/orderbook`: `MatchingEngine` trait + `NativeBook` (price-time
  priority, ported from market-core). **Done:** 7 Rust tests green;
  `orderbook-rs` documented as optional adapter behind the trait.
- [x] `operator` (lite): hosts the book per instrument; `/order /cancel /book
  /mm-tick`; fills → inventory + settlement intents (both rails). **Done:**
  builds; live e2e (seller lists → MM ticks/crosses → buyers lift → inventory
  + intents correct).

## Phase 2 — Venue inside a real blueprint (Rust) ✅

- [x] `operator/src/bin/blueprint.rs`: venue as a `BackgroundService`; jobs
  `workflow_tick` (30), `list_instrument` (0), `status` (4) wired via
  `Router::route(JOB, handler.layer(TangleLayer))`; `BlueprintRunner::builder`.
  **Done:** compiles against the full alpha SDK (rustc 1.91, `core2` patched);
  binary boots the real blueprint CLI (`surplus-operator run --data-dir
  --http-rpc-url`).

## Phase 3 — On-chain devnet bring-up + trigger 🔜 `surplus`

- [ ] **Local devnet up.** `cargo tangle harness up` runs Anvil + Tangle (chain
  31338). **Done when:** `cargo tangle blueprint list` shows the chain and the
  RPC answers.
- [ ] **Deploy ShieldedCredits to the devnet.** `forge script` the
  `shielded-payment-gateway` deploy against 31338. **Done when:** the contract
  address is recorded and `getAccount` returns for a funded commitment.
- [ ] **Deploy the Surplus blueprint.** `cargo tangle blueprint deploy` from
  `blueprint.toml`. **Done when:** a `blueprintId` is returned and visible in
  `blueprint list`.
- [ ] **Register + request + approve the service.** **Done when:** a `serviceId`
  is active with this operator in the set.
- [ ] **Trigger `workflow_tick` on-chain (G4).** Submit the job via `cargo tangle
  blueprint jobs`. **Done when:** the on-chain job call produces a
  `WorkflowTickResult` and the operator's book shows the MM's quotes — i.e. the
  runner (not an HTTP poke) drove a tick.
- [ ] **Base Sepolia deploy (G5).** Repeat deploy/register against chain 84532
  using the committed tnt-core manifest. **Done when:** `workflow_tick`
  triggers on Base Sepolia and the tx is linkable.

## Phase 4 — RFQ + atomic settlement spine 🔁 `settlement-agent`

- [~] **Signed firm quotes.** Every CLOB order + RFQ response is EIP-712 signed;
  a match yields a signed fill. **Done when:** a fill carries verifiable
  buyer-auth + operator-quote signatures.
- [~] **Atomic single-fill settlement (G2).** Escrow buyer → issue credit →
  release payment, or refund on timeout — all-or-nothing. **Done when:** a test
  proves no partial state survives an injected failure at each step.
- [~] **Validator-attested batch.** N fills batched; validator quorum attests;
  one settlement. **Done when:** a batch settles behind a quorum signature and a
  bad batch is rejected.
- [ ] **SP1 batch proof.** Swap quorum attestation for a SuccinctVM validity
  proof of the matching circuit. **Done when:** the settlement contract verifies
  a real proof and rejects a forged one. *(toolchain present: `~/.sp1`.)*

## Phase 5 — Redemption: credits are spendable (G1) 🔜 `surplus`

> Spec: `docs/specs/redemption-debit.md`. This is the gap that makes a bought
> credit usable. Non-colliding with the settlement spine (this is the
> spending/metering side; they own issuance/escrow).

- [x] **Credit model + debit accounting.** A `Credit { model, tokenKind,
  qtyRemaining, strikePrice, backing }` and a pure debit that closes the unit
  (tokens bought = tokens metered = tokens spent). **Done:**
  `@surplus/redemption` `CreditBook`; `closure.test.ts` proves quota + money
  conservation after every debit and refund-on-exhaustion/expiry.
- [x] **Router metering adapter interface.** The typed seam the Tangle Router
  implements to recognize a Surplus credit and debit its quota per inference
  call at the strike price. **Done:** `RedemptionAdapter` +
  `DefaultRedemptionAdapter` (soonest-expiry-first); `SimulatedRouter` pays the
  operator from backing in `redemption.test.ts`.
- [x] **End-to-end redemption proof.** buy credit → meter N inference calls →
  quota debits at strike → operator paid → quota exhausts → next credit/refund.
  **Done:** 12 tests green across both suites — closure, overflow fallback,
  expiry refund, wrong-instrument, roll-to-next-credit, determinism.
- [ ] **Live router integration.** Wire the adapter into the real router so a
  credit redeems against live inference. **Done when:** a real
  `/v1/chat/completions` call debits a real credit and returns a completion.

## Phase 6 — Redemption guarantees + abuse bounds (G3, G7) `settlement-agent` + `surplus`

- [ ] **Slashing-backed redemption (G3).** Credit → bonded operator; refusal of a
  valid credit slashes (`MultiAssetDelegation`); unfulfillable → refund. **Done
  when:** a refusal test produces a slash and makes the buyer whole.
- [ ] **Double-spend protection on claim (G7).** A credit/SpendAuth nonce can be
  claimed at most once. **Done when:** a replay test is rejected on-chain.
- [ ] **Rate limits + per-key spend caps (G7).** Enforced at redemption. **Done
  when:** an over-cap call is refused and tested.

## Phase 7 — Profit engine: MM tuning + arbitrage `surplus`

- [x] **Param sweep harness.** `mm-eval`. **Done.**
- [ ] **Discount-capture / cross-operator arbitrage eval.** Seller lists below
  reference; operator buys cheap, reprices toward list; measure captured
  discount. **Done when:** the backtest shows positive discount capture and
  isolates it from spread PnL.
- [ ] **Self-improving MM (bandit over params).** Promote params from the sweep
  by realized PnL between sessions. **Done when:** a promotion gate beats the
  static baseline on held-out seeds.

## Phase 8 — Productionization `surplus`

- [ ] **Operator on the Hetzner box.** Deploy the operator binary to the
  blueprint-operators host. **Done when:** it registers from the box and serves.
- [ ] **Contracts audited (G6).** Review every value-path contract. **Done when:**
  a sign-off exists per contract.
- [ ] **Price-oracle integrity.** Sanity-bound the router reference feed so the
  MM can't be picked off by a lagged/gamed price. **Done when:** a stale/oob
  reference is rejected and tested.
- [ ] **Two-sided liquidity cold-start.** A seeding plan (operator-as-first-MM)
  so the market isn't empty at launch. **Done when:** a documented seed runs on
  testnet with both sides quoting.
- [x] **tcloud PR: market/limit price + credits in the agent harness.** Let a
  user pick market vs limit price and spend credits directly from pi / agents.
  **Done:** tangle-network/tcloud#41 — `ChatOptions.pricing` (market/limit +
  credits), `ChatCompletion.surplus` redemption blocks, harness/pi/CLI wiring;
  harness test spends a credit into `AgentRunResult.surplus`. Router-side
  debit (the live `/v1/chat/completions` wiring) is the remaining Phase 5 box.
- [ ] **Legal/custody review.** Selling inference credits for money may be a
  stored-value instrument. **Done when:** counsel has reviewed pre-mainnet.

---

## Snapshot

| Phase | State | Gate |
|---|---|---|
| 0 Engine (TS) | ✅ done | — |
| 1 Orderbook + venue | ✅ done | — |
| 2 Venue in blueprint | ✅ done | — |
| 3 On-chain bring-up | 🔜 next (`surplus`) | G4, G5 |
| 4 RFQ + settlement | 🔁 in progress (`settlement-agent`) | G2 |
| 5 Redemption spendable | 🔜 spec'd, ready to start | **G1** |
| 6 Guarantees + abuse | ◻ not started | G3, G7 |
| 7 Profit engine | ◔ harness done | — |
| 8 Productionization | ◻ not started | G6 |

Tests today: 51 TS + 7 Rust green; operator (lite + blueprint) builds; venue
runs inside a real `BlueprintRunner`. **Not yet live:** no on-chain job trigger,
no spendable credit, no audited contracts.
