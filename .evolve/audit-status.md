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
- **H3** ✅ (PR #9, merged) pre-match simulation. `_applyBatch` is
  all-or-nothing and `verify_proposal` is chain-state-free, so a fill that
  reverts on-chain (withdrawn balance, lost lot, cancel, overfill, expiry) lost
  the whole epoch's batch and stranded the GOOD orders in it. Fix: before
  broadcasting, the proposer replays each fill's on-chain preconditions against
  live state (`simulate_doomed`), evicts the doomed orders, and re-matches the
  survivors — bounded to 3 passes; checks are conservative (never false-positive
  a fundable order, so it can drop a doomed fill but never censor). Safety was
  already total (`batchNonce` + `filled` cap); H3 turns the liveness failure
  into a no-op. Proven adversarially on anvil (`scripts/clob-presim.mjs`):
  buyer withdraws after resting, the unfundable buy is evicted, `bookNonce`
  unchanged, seller's order survives.
- **H4** ✅ serial collection (parallel `join_all`) + body-size cliff (16MB
  limit; digest-pull is the scale redesign).
- **H5** ✅ fail-closed config · **H6** ✅ metrics + QoS · **H7** ✅ transport
  logged + documented as fleet-wide · **H8** ✅ invariants + error paths ·
  **H9** ✅ live co-sign assertion.

## MEDIUM
- **M1** ✅ (merged) redeem `used_auths` persistence · **M2** ✅ (merged) proven
  publics bind book+nonce · **M3** ✅ deterministic expiry filter · **M5** ✅ dep
  pins · **M6** ✅ docs · **M7** ✅ epoch-scaled attest deadline.
- **M4** ✅ (PR #10) `clob.rs` (~1.4k lines, seven concerns in one `impl Clob`)
  split into a `clob/` module — `config` / `net` / `wire` / `pool` / `driver` /
  `peer` / `http` / `mod`. Pure move, zero behavior change: only the handful of
  cross-module `Clob` methods went private→`pub(crate)`; the public surface is
  re-exported unchanged so `mesh.rs` and the integration tests are untouched.
  Both anvil e2e proofs (happy-path settle + H3 grief) pass byte-for-byte
  against the refactored binary. The typed `Attester` newtype was left out as a
  follow-up (it ripples into `mesh.rs` + test fixtures, obscuring the move).

## LOW — all closed
- **L1** ✅ e2e keys moved to a gitignored `.keys/` with ownership/mode checks;
  the live proof's quorum-calldata verify (H9) already guards wrong-event pickup.
- **L2** ✅ out-of-`i64`-domain orders rejected at admission.

## PRODUCT (P1–P3) — not engineering-sweep items
Buyer funnel (P1, partially addressed by the spend rail + front door), instance
economics (P2), permissionless onboarding (P3) are product/economics decisions,
tracked separately.

## Status: fully swept
Every CRITICAL / HIGH / MEDIUM / LOW from the audit is now closed — H3 (PR #9,
merged) and M4 (PR #10) were the last two reasoned deferrals and are both done.
The only remaining items are non-engineering: the C2 live-close (a Gnosis Safe
signer set — Drew's ownership decision) and the PRODUCT P1–P3 economics, both
tracked separately. Everything is closed and (where live) proven on Base
Sepolia.
