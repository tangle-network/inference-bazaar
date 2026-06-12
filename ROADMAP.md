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

- [x] **G1 — A credit is spendable.** A bought credit redeems into real metered
  inference through the Tangle Router, debiting its token quota at the locked
  price. *(Done: venue `/redeem` + `/redeem/receipt` serve router inference
  against an open on-chain redemption; scripts/e2e-redeem.mjs spent lot
  `0xd66a3647…` on a real Claude completion — 35 metered tokens debited the
  lot 1,000,000→999,965 and released exactly 463 micro at the $13.246/M
  strike, settled with the holder's signed receipt. Walkthrough:
  docs/examples/spend-a-credit.md.)*
- [x] **G2 — Atomic fills.** A match settles all-or-nothing: buyer escrow → credit
  issued → payment released, or none of it. *(Phase 4 — Replay.t.sol proves a
  2-fill batch with one injected failure rolls back EVERY state slot (balances,
  collateral, liability, fill caps); live on Base Sepolia twice: tsUSD tx
  `0x15a70fa6…` and real-USDC tx `0x5faa5019…`. The operator pipeline is
  crash-safe: signed fills journal to `$DATA_DIR/outbox.json` on every
  mutation, restore on boot, and an in-process auto-flush loop submits every
  30s with per-fill isolation — and the venue never signs a quote its on-chain
  funding can't settle (freeCollateral/balance-capped quoting, observed live
  refusing an over-committed RFQ).)*
- [ ] **G3 — Buyers definitely get their spend.** A credit is a claim on a bonded
  operator; refusal of a valid credit is slashable; unfulfillable → escrow
  refund. *(Phase 4 + 6, settlement-agent)*
- [x] **G4 — The venue runs on-chain.** `workflow_tick` is triggered by a real
  on-chain job on a deployed blueprint, not an HTTP poke — autonomously.
  *(Phase 3 devnet + Base Sepolia proofs, now driven by a production keeper:
  `surplus-tick-keeper@{3,4}.timer` on the Hetzner box submits the job
  on-chain every 5 min per service with flock'd nonce safety and a loud
  fail-closed low-balance refusal (proven end-to-end on both services:
  service 3 job `0x78f546be…` → result `0x2666698f…`, service 4 job
  `0x463754f7…` → result `0x19488eab…` — no human in the loop. Known
  limitation: submitJob is owner-gated, so the keeper shares the operator key
  with the runtime's result consumer; a nonce-cache collision crashes the
  runner, which systemd restarts and the producer re-delivers — observed
  self-healing. Reference prices journal to `$DATA_DIR/refs.json` so a
  restarted venue quotes immediately instead of burning the next tick on
  NoReference.)*
- [x] **G5 — Money is real.** Settlement clears on at least one rail against a
  real chain / the live router, not a stub. *(Done on REAL money: a second
  SurplusSettlement `0xf6A64921…` is live on Base Sepolia bound to canonical
  Circle USDC `0x036CbD53…`. The dedicated USDC venue (Hetzner, port 9600,
  surplus-usdc.…sslip.io) quoted a signed firm order; e2e ran
  RFQ→sign→fill→settleFills in real USDC — tx `0x5faa5019…`, 20,000 Sonnet
  output tokens at $13.546/M = 0.27092 USDC, collateral-backed lot
  `0xa9c85825…` minted — then spent it on a real router completion: 32 metered
  tokens debited 20,000→19,968 releasing exactly 433 micro-USDC at the locked
  strike, redemption `0xbbf7c74e…` settled. The tsUSD rail (`0x1cD49739…`,
  tx `0x15a70fa6…`) remains the app's demo rail.)*
- [ ] **G6 — Contracts audited.** Every contract on the value path has a review
  sign-off. *(Phase 8)*
- [x] **G7 — Abuse-bounded.** Rate limits, per-key spend caps, and double-spend
  protection on claim are enforced and tested. *(Done: contracts/test/Replay.t.sol
  — exact-fill replay, cross-batch attested replay, receipt cross-redemption
  replay, claim/reclaim replay all revert (58 forge tests green). Venue side:
  `/redeem` is holder-gated by an EIP-712 `ServeRequest` signature binding the
  exact message bytes + token cap + expiry, with consumed-auth replay
  rejection; per-IP token-bucket rate limiting across the HTTP surface
  (10× cost on /redeem) — forged-signer, missing-auth, and 429 throttling all
  verified against the live venue. Redemption-side per-owner spend caps:
  GuardedRedemptionAdapter (guard.test.ts).)*

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

## Phase 3 — On-chain devnet bring-up + trigger ✅ `surplus`

- [x] **Local devnet up.** `cargo tangle harness up` runs Anvil + Tangle. **Done:**
  harness.toml committed; chain answers (snapshot chain id 31337), blueprint
  list shows the pre-seeded protocol; operator healthy on :9100.
- [x] **Deploy ShieldedCredits to the devnet.** **Done:** ShieldedCredits
  `0x56D13Eb2…`, ShieldedGateway `0xE8addD62…`; a commitment funded with
  1_490_000 micro-tsUSD (a 100k-token credit's backing at $14.90/M) and
  `getAccount` returns it. Bonus: the firm rail too — MockUSD, SurplusSettlement
  `0x071586BA…`, SurplusBSM, SP1MockVerifierStrict.
- [x] **Deploy the Surplus blueprint.** **Done:** `blueprint deploy tangle
  --definition deploy/blueprint-definition.toml` → blueprintId 1 (tx
  `0x932a580a…`), 31-entry positional job table with `workflow_tick` at 30.
- [x] **Register + request + approve the service.** **Done:** operator
  `0x709979…` registered, request 2 approved (snapshot's
  `approveService(uint64,uint8)` — the 0.13.0 ApprovalParams selector is not
  on the snapshot proxy), serviceId 1 Active on blueprint 1.
- [x] **Trigger `workflow_tick` on-chain (G4).** **Done:** `submitJob(1, 30, …)`
  → runner executed the tick → result tx `0x52e87e37…` carries
  `WorkflowTickResult { quoting: true, rationale: "q=0.00 lots,
  reservation=15000000, halfSpread=45563" }` and the book shows the MM's
  two-sided quotes (bid 14_954_000 / ask 15_046_000, 50k tokens per side).
- [x] **Base Sepolia deploy (G5).** **Done:** blueprintId 17 on chain 84532
  (create tx `0xfe7f7ad0…`, compact 6-job definition — the padded 31-job table
  exceeds the node's ~16.7M per-tx cap, so live chains use
  `deploy/blueprint-definition.sepolia.toml` with workflow_tick at positional
  index 5; the binary routes both 5 and 30). Operator `0x2420FF…` bonded 10k
  TNT via `registerOperatorWithAsset`, registered, service 3 approved + Active.
  `workflow_tick` job tx `0xdef6ebfa…` → on-chain result tx `0x323f9d6e…`,
  book quoting bid 14_954_000 / ask 15_046_000.
  <https://sepolia.basescan.org/tx/0xdef6ebfae28b66e571e830b2c24f069d9597a502d5154a0b6728877ee02c26a2>

## Phase 4 — RFQ + atomic settlement spine 🔁 `settlement-agent`

- [x] **Signed firm quotes.** Every CLOB order + RFQ response is EIP-712 signed;
  a match yields a signed fill. **Done:** one `Order` struct serves book and
  RFQ; `SignedFill::pair` verifies both signatures at pairing and the contract
  re-verifies on `settleFills` — both live fills (`0x15a70fa6…`, `0x5faa5019…`)
  carried buyer + operator signatures verified on-chain.
- [x] **Atomic single-fill settlement (G2).** Escrow buyer → issue credit →
  release payment, or refund on timeout — all-or-nothing. **Done:**
  Replay.t.sol `test_batchAllOrNothing_stateSnapshotUnchanged` injects a
  failure into fill #2 of a batch and asserts every balance, collateral,
  liability, and fill-cap slot is byte-identical after the revert (fill #1
  included); Settlement.t.sol covers each individual revert path.
- [x] **Validator-attested batch.** N fills batched; validator quorum attests;
  one settlement. **Done:** Batch.t.sol — a 2-of-3 quorum settles a 2-fill
  batch; below-threshold, non-attester, duplicate-signer, and replayed
  attestations all revert; limits still bind under attestation.
- [x] **Shared CLOB live on the attested path (Phase C).** Two operators,
  one shared book: signed orders gossiped between services 3+4, the elected
  epoch proposer runs the set-deterministic matcher kernel, the peer
  independently re-verifies (trader sigs + exact match recompute + censorship)
  and co-signs, 2-of-2 quorum settles `settleBatchAttested`. **Done live
  2026-06-11:** batchNonce 0→1 on `0x1cD49739…`, sell entered at service 3
  and buy at service 4,
  <https://sepolia.basescan.org/tx/0x388f4408a4cd25de682facf15826e2c170397dc8ed5c93446a930d60435eed96>.
  Rehearsable e2e: `scripts/clob-e2e.sh` (anvil) and `scripts/clob-e2e-live.mjs`.
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
- [x] **Live router integration.** **Done:** the operator's redemption worker
  serves `/v1/chat/completions` through the live router and debits the
  on-chain credit at the locked strike (operator/src/redeem.rs; proof in
  scripts/e2e-redeem.mjs — real completion, quota 1,000,000→999,965).
  Router-native debit (tcloud#41 wire contract) remains the v2 ergonomics
  path; the credit is spendable today.

## Phase 6 — Redemption guarantees + abuse bounds (G3, G7) `settlement-agent` + `surplus`

- [ ] **Slashing-backed redemption (G3).** Credit → bonded operator; refusal of a
  valid credit slashes (`MultiAssetDelegation`); unfulfillable → refund. **Done
  when:** a refusal test produces a slash and makes the buyer whole.
- [x] **Double-spend protection on claim (G7).** A credit/SpendAuth nonce can be
  claimed at most once. **Done:** Replay.t.sol — identical-fill replay
  (Overfill), settled/defaulted redemption replay (RedemptionNotOpen), receipt
  replayed across redemptions (BadReceipt — digest binds the redemptionId),
  reclaim replay (LotNotFound), all rejected on-chain; plus consumed
  serve-auth replay rejected at the venue.
- [x] **Rate limits + per-key spend caps (G7).** Enforced at redemption. **Done:**
  `GuardedRedemptionAdapter` — per-owner rolling-window call/token/spend caps,
  deterministic, fail-open to balance billing; `guard.test.ts` proves over-cap
  refusal, window-slide recovery, per-owner isolation, no quota/backing leaks.

## Phase 7 — Profit engine: MM tuning + arbitrage `surplus`

- [x] **Param sweep harness.** `mm-eval`. **Done.**
- [x] **Discount-capture / cross-operator arbitrage eval.** Seller lists below
  reference; operator buys cheap, reprices toward list; measure captured
  discount. **Done:** `mm-eval/discount.ts` — seeded backtest, FIFO lot
  accounting with exact conservation (equity == proceeds − cost + residual
  mark); positive capture on every seed incl. worst; isolation proven
  structurally (one-sided strategy, zero spread PnL; below-edge dumps → zero
  trades).
- [ ] **Self-improving MM (bandit over params).** *Deferred post-launch by
  decision (2026-06-10): promotion by realized PnL needs real sessions; on
  simulated seeds the static sweep already selects params, so a bandit adds
  machinery without information.* Pre-launch substitute: pin the sweep winner
  as the operator default. **Done when (post-launch):** a promotion gate beats
  the pinned baseline on real session PnL.

## Phase 8 — Productionization `surplus`

- [x] **Operator on the Hetzner box.** **Done:** three venues serve from
  blueprint-operators (178.104.232.124): services 3 + 4 (blueprint runtimes,
  on-chain registered, TLS via Caddy at surplus./surplus2.…sslip.io) and the
  USDC venue (surplus-usdc.…sslip.io), plus the mm-sidecar, the quoter timer,
  and the tick keepers — all systemd-managed (deploy/hetzner/).
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
| 3 On-chain bring-up | ✅ done — devnet + Base Sepolia + autonomous tick keeper | G4, G5 |
| 4 RFQ + settlement | ◕ signed quotes, atomic fills, attested batch done; SP1 proof left | G2 ✅ |
| 5 Redemption spendable | ✅ done — live router spend proven on tsUSD AND real USDC | G1 ✅ |
| 6 Guarantees + abuse | ◕ G7 closed (replay suite, serve-auth, rate limits, caps); slashing (G3) left | G3, G7 ✅ |
| 7 Profit engine | ◕ sweep + discount-capture done; bandit deferred post-launch | — |
| 8 Productionization | ◑ Hetzner fleet live, tcloud PR open (#41); audit/oracle/legal left | G6 |

Tests today: 69 TS + 7 Rust green; operator (lite + blueprint) builds; venue
runs inside a real `BlueprintRunner`; `@surplus/redemption` proves unit closure
and plans the zero-router-change shielded spend rail. **Not yet live:** no
on-chain job trigger, no live-router credit spend, no audited contracts.
