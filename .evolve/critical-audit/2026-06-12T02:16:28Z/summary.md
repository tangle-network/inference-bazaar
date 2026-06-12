# Critical Audit — Surplus (2026-06-12, HEAD 9ecbbc8)

Reviewers: A (security), B (architecture), C (standards/tests/docs), D (product personas — customer, operator, instance-payer). Full findings in findings.jsonl.

**Verdict: REQUEST_CHANGES** — 6 CRITICAL, 11 HIGH.

Scores: contract arithmetic 8/10 · kernel+consensus design 8/10 · system architecture 4.5/10 · test quality 6/10 · customer UX 3/10 · operator UX 2/10.

## What is genuinely good
- Collateral/liability/notional accounting traced through mint, resale carve-out, redemption, default, expiry-reclaim: no underflow, no double-free, invariant holds on every path (Reviewer A, exhaustively).
- Set-deterministic matching with digest tiebreak is the right primitive; consensus layer (forgery/wrong-match/censorship) is a clean pure cut; trust-model docs unusually honest.
- Access control complete; reentrancy guarded where needed; EIP-712 domains correctly partitioned; _verifyQuorum + ascending aggregation correct.
- Replay/atomicity Foundry matrices and the three-way EIP-712 parity pins are above typical pre-audit shape.

## Fix plan (ordered)
1. [CRITICAL C5] operator/src/clob.rs:927 + http.rs:40 — authenticate /clob/propose (proposer sig over epoch,nonce,fillsHash) AND move rate limiter to the merged app. One-day fix, closes the order-stranding DoS.
2. [CRITICAL C1/C2] contracts — n≥3 attesters, independent custody, owner behind timelock+multisig. Policy + redeploy prerequisite for real value.
3. [CRITICAL C3/C4 + P2] contracts — per-instrument/per-instance batchNonce + attester sets + fee routing. This is the instance-#2 blocker; one redesign, do together.
4. [HIGH H1] clob — finality only on observed on-chain settlement; persist pool/settled/cancelled; pool-sync anti-entropy.
5. [HIGH H3] pre-simulate fills before co-sign/submit (or per-fill skip on-chain) — kills the free liveness grief.
6. [HIGH H5/H6] fail-closed config; /metrics with quorum/epoch/pool counters.
7. [HIGH H4] parallel attestation collection; digest-based proposals.
8. [HIGH H8/H9] error-path + invariant Foundry tests; co-sign assertions in live proof scripts.
9. [HIGH H2 + M1] redemption: bind work commitment into receipt; persist used_auths; design holder-challenge for attested redemption.
10. [HIGH H7 + M5] transport migration plan; pin blueprint-* exactly; guard the bincode workaround with a round-trip test.
11. [MEDIUM M3/M4/M6/M7] expiry in verify_proposal; module splits; docs sweep; constant validation.
12. [PRODUCT P1] consumption rail redesign: API key against lot, lazy receipts — see persona section in the session report.
13. [PRODUCT P3] operator runbook + registry-driven attester membership + key role separation.
