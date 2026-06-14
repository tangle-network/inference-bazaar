# Critical audit — money-path scope (2026-06-14) + harden

Reviewers A/B/C each scored **6/10**. 19 findings (0 CRITICAL, 6 HIGH, 9 MEDIUM, 4 LOW).
All 6 HIGH were adversarially verified as CONFIRMED, then **fixed and re-verified
with real-system tests** in the same session (`/critical-audit and /harden`).

## Fix plan (HIGH — all resolved)

1. [HIGH] operator/src/bin/gateway.rs:62 — per-channel `acked` was in-memory only; a
   restart re-signs `cum=0`, the operator 409s `stale_voucher`, the channel bricks.
   Action: journal acked to `SURPLUS_GATEWAY_STATE` (atomic) on every advance; seed
   from it on startup.
   Verification: `gateway-multilot-e2e` kills + restarts the gateway and asserts the
   post-restart call succeeds and bills further on-chain. ✅

2. [HIGH] operator/src/redeem.rs:302 — serve-auth reservation + served journaled only
   AFTER inference; a crash re-opens already-spent quota.
   Action: `persist_redeem()` right after reserving the auth (before inference) and on
   `release_auth`.
   Verification: `settlement-e2e` redemption serve+receipt path still green. ✅

3. [HIGH] scripts/gateway-multilot-e2e.mjs:156 — streaming through the gateway untested.
   Action: add a `stream:true` call through the gateway; assert SSE content flows and the
   private `surplus` event is stripped.
   Verification: "streamed N chars through the gateway (surplus event stripped)". ✅

4. [HIGH] .github/workflows/ci.yml:142 — money-path e2e excluded from CI.
   Action: new `money-e2e` job runs `spend-e2e.sh` + `gateway-multilot-e2e.sh`; `viem`
   declared as a root devDependency so `node scripts/*.mjs` resolves after `pnpm install`.
   Verification: both scripts pass end-to-end locally; job present in CI. ✅

5. [HIGH] .github/workflows/ci.yml:163 — app job was typecheck-only; SOR math ran nowhere.
   Action: add `tsx` + a `test` script (router.check.ts) to the app; add an `app — test`
   CI step.
   Verification: `pnpm test` → "router: 15 passed, 0 failed". ✅

6. [HIGH] operator/src/spend.rs:311 — `authorize()` never mirrored on-chain revocation
   or current holder; a revoked/leaked key or resold lot kept being served for free.
   Action: `reconcile_revocations()` on each flush drops revoked/resold channels
   (fail-open on transient RPC); doc corrected to the flush-cycle bound.
   Verification: `spend-e2e` revokes on-chain, asserts `flush.dropped >= 1`, a subsequent
   serve returns 401, and no further billing. ✅

## MEDIUM/LOW (deferred — tracked in findings.jsonl)

complete_stream task-leak on disconnect; redeem_serve missing assert_domain; re-attest
loop after challenge; Buy.tsx SOR silent leg-drop; Deploy.s.sol 1-of-1 book guard; redeem
cap vs digest basis; base-sepolia.sh dead require; gateway concurrent double-serve;
deploy address-length validation. None is a production-incident blocker on a 1-of-1 launch.

## Verdict

Initial: **REQUEST_CHANGES** (6 HIGH).
After harden + re-verify: **APPROVE** — 0 CRITICAL/HIGH remain; every HIGH fix is backed
by a real-system test (anvil + operator + stub), not a mock.
