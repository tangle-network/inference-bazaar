# Audit status — 2026-06-12

Disposition of every finding from `.evolve/critical-audit/2026-06-12T02:16:28Z/`.

## CRITICAL — all closed
- **C1** BFT — third attester on an independent host (Helsinki), live 2-of-3.
- **C2** owner custody — `TimelockController` bootstrap in `Deploy.s.sol`
  (`USE_TIMELOCK=1`), proven + CI-gated (`Timelock.t.sol`). Live-close gated on a
  Gnosis Safe signer set (ownership decision).
- **C3** per-book nonce · **C4** per-book attesters · **C5** authenticated
  `/clob/propose` + merged-router rate limit.

## HIGH
- **H1** ✅ finality persistence — `settled`/`cancelled` journal to
  `clob-finality.json`, restored on boot.
- **H2** ✅ (merged) `settleRedemptionAttested` bound to `lotBook` + proof-of-service receipt.
- **H3** ⏳ **deferred, by design.** `_applyBatch` is all-or-nothing and
  `verify_proposal` is chain-state-free, so a fill that reverts on-chain
  (withdrawn balance, lost lot) loses the whole epoch's batch — stranding the
  GOOD orders in it until expiry. The correct fix is **finality-on-observed-
  settlement** (today prune/settled fires on co-sign) plus a pre-submit
  `eth_call` dry-run that drops only the doomed fills. That changes consensus
  finality semantics across the live 3-node fleet and must be its own focused PR
  with multi-node tests — NOT a sweep commit. Bounded today: safety holds
  (`batchNonce` + `filled` cap), and griefing self-limits by order expiry.
- **H4** ✅ serial collection (parallel `join_all`) + body-size cliff (16MB
  limit; digest-pull is the scale redesign).
- **H5** ✅ fail-closed config · **H6** ✅ metrics + QoS · **H7** ✅ transport
  logged + documented as fleet-wide · **H8** ✅ invariants + error paths ·
  **H9** ✅ live co-sign assertion.

## MEDIUM
- **M1** ✅ (merged) redeem `used_auths` persistence · **M2** ✅ (merged) proven
  publics bind book+nonce · **M3** ✅ deterministic expiry filter · **M5** ✅ dep
  pins · **M6** ✅ docs · **M7** ✅ epoch-scaled attest deadline.
- **M4** ⏳ **deferred.** `Venue` is a 7-mutex god-object and `clob.rs` is ~1.3k
  lines (pool + transport + driver + submitter + handlers). A clean extraction
  (`clob/{pool,driver,submit,http}.rs`, a typed `Attester`) is worth doing but
  is a pure-quality refactor that adds churn/conflict surface — its own PR, not
  bundled into a security sweep where it would obscure the diffs.

## LOW — all closed
- **L1** ✅ e2e keys moved to a gitignored `.keys/` with ownership/mode checks;
  the live proof's quorum-calldata verify (H9) already guards wrong-event pickup.
- **L2** ✅ out-of-`i64`-domain orders rejected at admission.

## PRODUCT (P1–P3) — not engineering-sweep items
Buyer funnel (P1, partially addressed by the spend rail + front door), instance
economics (P2), permissionless onboarding (P3) are product/economics decisions,
tracked separately.

## The two open engineering items, restated
1. **H3 / finality-on-settlement** — the one real consensus change left; needs a
   dedicated PR + multi-node tests. Highest-value remaining HIGH.
2. **M4 / module split** — quality refactor, own PR.

Everything else from the audit is closed and (where live) proven on Base Sepolia.
