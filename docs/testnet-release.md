# Surplus testnet release

A repeatable checklist to bring up a Surplus testnet with confidence in both the
**trader** and **developer** experience. Launch on **1-of-1 books** first (one
issuing operator per book); multi-operator (M-of-N) books are a scale-up step
(see "Scale-up" below).

## What is verified (the confidence basis)

Run these before/after a deploy — they are the end-to-end proof:

- **Trader path** — `bash scripts/settlement-e2e.sh`: atomic fill → receipt
  redemption → collateral default (+5% penalty) → attested batch (2-of-3) →
  proven batch (SP1, strict verifier) → attested redemption (time-warped).
- **Developer path** — `bash scripts/spend-e2e.sh`: one-signature API-key mint →
  vanilla OpenAI calls, buffered **and streaming** → on-chain billing → forged
  (non-session) voucher refused.
- **Circuit parity** — `bash scripts/prove-batch.sh execute`: the SP1 guest's
  committed public values equal the host's recomputation.
- CI gates: `forge test` (settlement + invariants), Rust parity pins, the guest
  ELF + parity job, and the settlement-spine e2e.

## 1. Contracts (governance-owned)

`cd contracts && forge script script/Deploy.s.sol --broadcast` with:

- `PAYMENT_TOKEN` = the real testnet USDC (a standard ERC20 — **not** fee-on-
  transfer/rebasing; the solvency model assumes `transferFrom` moves exactly
  `amount`).
- `USE_TIMELOCK=1`, `TIMELOCK_ADMIN` = a **Gnosis Safe** (multisig), `TIMELOCK_DELAY`
  = the production reaction window. This closes audit C2 in the live config: every
  owner action (registerBook / rotateAttesters / setSp1Verifier) goes
  schedule → wait → execute, no EOA shortcut.
- `REGISTER_BOOK=1` with `BOOK_ID`, `BOOK_ATTESTERS` (the issuing operator for a
  1-of-1 launch), `BOOK_THRESHOLD=1` — so the attested + proven batch paths work
  from block 0. (Production governance can `rotateAttesters` later.)
- SP1 proven path (optional at launch): set `SP1_VERIFIER` (the live
  SP1VerifierGateway) + `SP1_VKEY` (from `scripts/prove-batch.sh vkey`). If unset,
  the proven path stays disabled and settlement uses the attested-quorum path.

Record the deployed addresses into `blueprint.toml`
(`[blueprint.manager].address`, `surplus_settlement_address`) and the app env.

## 2. Blueprint + operator fleet

- Deploy the blueprint manager (SurplusBSM) + register the blueprint via
  `cargo tangle blueprint deploy`; the runtime calls `onBlueprintCreated`, then the
  owner calls `bsm.setSettlement(settlement)`.
- Each operator runs `surplus-operator` (feature `blueprint`) with:
  - a REAL inference backend — `SURPLUS_VLLM_MODEL` (managed vLLM) **or**
    `SURPLUS_INFERENCE_URL` (+ `SURPLUS_INFERENCE_API_KEY`). Router-proxy mode is
    refused for a bonded issuer (a lot must be backed by inference it runs).
  - settlement: `SURPLUS_CHAIN_ID`, `SURPLUS_SETTLEMENT_ADDR`, `SURPLUS_RPC_URL`,
    `SURPLUS_OPERATOR_KEY` (attester/issuer), `SURPLUS_SUBMITTER_KEY` (separate
    tx/nonce key).
  - CLOB (if sharing a book): `SURPLUS_CLOB_OPERATORS`, `SURPLUS_CLOB_BOOK`,
    `SURPLUS_CLOB_THRESHOLD`. An independent-DC quorum member that never issues:
    `SURPLUS_ATTESTER_ONLY=1`.
  - privacy (optional): run `surplus-arti.service`; the operator publishes its
    `.onion` via `SURPLUS_ONION_FILE` and tunnels outbound inference with
    `PRIVACY_MODE=tor`.
- Keepers: the operator auto-flushes settlement, spend, and redemption
  attestation on timers; the `tick-keeper` drives `workflow_tick`.

## 3. App

- Set `VITE_SURPLUS_VENUE_URL`, `VITE_TANGLE_ROUTER_URL`, and your own
  `VITE_WALLETCONNECT_PROJECT_ID` (don't ship the shared fallback). See
  `app/.env.example`.

## Trust model (what to tell users)

- **Payment is bounded both ways, cryptographically.** An operator can't settle
  more than the user's key signed (session voucher / holder receipt) or beyond the
  holder-set cap; it can't withdraw collateral backing outstanding lots; non-
  delivery repays the holder from collateral + a 5% penalty. A user's grief is
  bounded to one unacknowledged request (spend) and is collateral-neutral.
- **Per-request billing is independently capped** by the user's own gateway at the
  request's `max_tokens` — an operator can't inflate a small request.
- **Residual trust = authenticity** (was the inference genuinely run by the named
  model, metered honestly). Today this rests on the holder inspecting+refusing
  (redemption rail), bonds + slashing, and reputation; **TEE-attested inference**
  is the documented path that makes it cryptographic.

## Scale-up (not blockers for a 1-of-1 launch)

- **Multi-operator (M-of-N) redemption attestation**: the anti-grief redemption
  pump self-signs (complete for 1-of-1). For N-of-M books it needs threshold-
  generic peer co-signing over the receipt digest (reusing the CLOB quorum
  transport) — build + verify with a multi-operator e2e before N-of-M books go
  live.
- **Hosted gateway** + in-app session-key management for devs who don't self-host.
- **TEE-attested inference** for cryptographic service authenticity.
