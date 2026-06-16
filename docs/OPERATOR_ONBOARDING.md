# Operator onboarding

How to run an Inference Bazaar operator — from "try it on my laptop" to a bonded
issuer selling real inference on Base Sepolia. Every command below is real; the
env-var names are exactly what `operator/src/config.rs` reads.

There are two roles:

- **Lite venue** — an HTTP market maker with no chain. Good for kicking the tires
  and local dev. Boots with near-zero config.
- **Bonded issuer** — the production role. It signs orders that mint
  collateral-backed credit lots on-chain and **must serve the model it sold**
  from its own inference backend. This is what you onboard for a live market.

Quickest path to a running bonded issuer: [`deploy/onboard-operator.sh`](../deploy/onboard-operator.sh)
does the mechanical steps (build → collateral → write `.env`). The governance
step (Tangle service registration/approval) is multi-party and is called out
explicitly below.

---

## 0. Prerequisites

- **Rust** (pinned by `rust-toolchain.toml` — 1.91) and **Cargo**.
- **Foundry** (`cast`, `forge`) for on-chain steps.
- **Node 20+** and `pnpm` (the market-making sidecar is a Node process).
- **An inference backend** you control: either a GPU box running vLLM, or any
  OpenAI-compatible endpoint + key. Router-proxy mode is **refused** for a bonded
  issuer — a lot must be backed by inference you actually run.
- **Two funded EVM keys** on the target chain (Base Sepolia, chain id `84532`):
  - the **operator/attester key** (signs RFQ + CLOB quotes; its address must be
    in the book's attester set), and
  - a **submitter key** that pays gas and sends txs. It can fall back to the
    operator key for dev, but keep them separate in production so the signing key
    never touches the RPC/nonce path.
- Some **payment token** (tsUSD on the test rail, real Circle USDC on the USDC
  rail) to post as collateral.

---

## 1. Try it first — the lite venue (no chain)

```bash
cargo run -p inference-bazaar-operator --bin inference-bazaar-operator-lite
```

With no settlement env set it boots a chainless HTTP venue on
`127.0.0.1:9100` quoting the default instrument. Hit `GET /health`,
`GET /instruments`, `POST /book`. This proves your build and sidecar wiring
before you touch keys or money.

To quote, it needs the **mm-sidecar** (the pricing brain) running — see step 5.

---

## 2. Point at a deployment

If a deployment already exists (e.g. the live testnet fleet), just collect its
addresses. To stand up your own:

```bash
# Local anvil (deploys MockUSD, deployer is the timelock admin):
RPC=http://127.0.0.1:8545 PRIVATE_KEY=0x<funded> deploy/deploy-inference-bazaar.sh

# Base Sepolia with REAL USDC + a Safe as timelock admin:
RPC=https://sepolia.base.org PRIVATE_KEY=0x<funded> \
  PAYMENT_TOKEN=0x036CbD53842c5426634e7929541eC2318f3dCF7e \
  TIMELOCK_ADMIN=0x<safe> deploy/deploy-inference-bazaar.sh
```

This writes [`deploy/.env.deployed`](../deploy/.env.deployed):

```
INFERENCE_BAZAAR_CHAIN_ID=84532
INFERENCE_BAZAAR_SETTLEMENT_ADDR=0x…
INFERENCE_BAZAAR_BSM_ADDR=0x…
INFERENCE_BAZAAR_PAYMENT_TOKEN=0x…
INFERENCE_BAZAAR_RPC_URL=https://sepolia.base.org
```

`source deploy/.env.deployed` and you have the contract coordinates every later
step needs.

---

## 3. Post collateral (this is what "bonded" means)

A credit lot can only be minted if the issuer's on-chain collateral covers it —
the contract enforces `collateral(issuer) ≥ 1.05 × liability` on every fill. So
before you can sell, deposit collateral in the payment token:

```bash
SET=$INFERENCE_BAZAAR_SETTLEMENT_ADDR
TOKEN=$INFERENCE_BAZAAR_PAYMENT_TOKEN
AMOUNT=20000000            # 20 tsUSD (6 decimals). Size it to how much you intend to back.

cast send $TOKEN  "approve(address,uint256)" $SET $AMOUNT --rpc-url $INFERENCE_BAZAAR_RPC_URL --private-key $SUBMITTER_KEY
cast send $SET    "depositCollateral(uint256)" $AMOUNT     --rpc-url $INFERENCE_BAZAAR_RPC_URL --private-key $SUBMITTER_KEY
```

On the test rail you can mint tsUSD first (`cast send $TOKEN "mint(address,uint256)" <you> $AMOUNT`).
On the USDC rail there is no mint — fund the key from a Circle faucet/transfer.

Your sellable headroom is `freeCollateral(issuer)`; the operator reads it and
quotes inside it (a quote past your headroom is refused, see
`operator/src/market.rs:462`).

---

## 4. Stand up your inference backend

Pick one — the operator panics at boot if a bonded issuer has neither:

- **Managed vLLM** (operator spawns it): set `INFERENCE_BAZAAR_VLLM_MODEL` to a
  HF model id (needs a GPU with enough VRAM for the model).
- **External OpenAI-compatible** endpoint: set `INFERENCE_BAZAAR_INFERENCE_URL`
  (+ `INFERENCE_BAZAAR_INFERENCE_API_KEY` if it needs auth).

The model you serve must match the instrument you quote
(`<model>:<kind>`, e.g. `groq/llama-3.1-8b-instant:output`).

---

## 5. Start the market-making sidecar

The operator delegates pricing to the sidecar; it won't quote without one.

```bash
pnpm --filter @inference-bazaar/mm-sidecar build
node packages/mm-sidecar/dist/index.mjs      # listens on :9110 by default
```

(Production runs it as `deploy/hetzner/inference-bazaar-mm-sidecar.service`.)

---

## 6. Environment

Source `deploy/.env.deployed`, then add the operator-specific vars. **Required**
for a bonded issuer:

| Var | What |
|---|---|
| `INFERENCE_BAZAAR_CHAIN_ID` | EVM chain id (`84532` Base Sepolia) |
| `INFERENCE_BAZAAR_SETTLEMENT_ADDR` | deployed `InferenceBazaarSettlement` |
| `INFERENCE_BAZAAR_RPC_URL` | EVM RPC endpoint |
| `INFERENCE_BAZAAR_OPERATOR_KEY` | attester/signing key (its address must be in the book attesters) |
| `INFERENCE_BAZAAR_SUBMITTER_KEY` | gas/submitter key (falls back to operator key) |
| one of `INFERENCE_BAZAAR_VLLM_MODEL` **or** `INFERENCE_BAZAAR_INFERENCE_URL` | your inference backend |
| `INFERENCE_BAZAAR_SIDECAR_URL` | quoting sidecar (default `http://127.0.0.1:9110`) |

**Optional / tuning:**

| Var | Default | What |
|---|---|---|
| `INFERENCE_BAZAAR_OPERATOR_ADDR` | `127.0.0.1:9100` | HTTP bind address |
| `INFERENCE_BAZAAR_INSTRUMENT` | `groq/llama-3.1-8b-instant:output` | boot market `<model>:<kind>` |
| `INFERENCE_BAZAAR_MM_SIZE` | `50000` | quote size per level, tokens |
| `INFERENCE_BAZAAR_ROUTER_URL` | `https://router.tangle.tools` | reference pricing |
| `INFERENCE_BAZAAR_FROM_BLOCK` | `0` | block to scan from for `/credits` (set to the deploy block) |
| `INFERENCE_BAZAAR_RFQ_TTL_SECS` | `120` | how long a firm quote stays settleable |
| `INFERENCE_BAZAAR_ATTESTER_ONLY` | unset | quorum member that co-signs but never issues |
| `INFERENCE_BAZAAR_CLOB_OPERATORS` / `_CLOB_BOOK` / `_CLOB_THRESHOLD` | — | shared multi-operator CLOB (needs `--features mesh`) |
| `INFERENCE_BAZAAR_ONION_FILE`, `PRIVACY_MODE=tor` | — | Tor privacy (run Arti separately) |

A ready-to-edit template lives at [`.env.operator.example`](../.env.operator.example).

---

## 7. Run

### Local testing only — run the binary directly

For kicking the tires on your own box, run the lite venue directly. It goes
on-chain the moment `CHAIN_ID` + `SETTLEMENT_ADDR` are set:

```bash
cargo run -p inference-bazaar-operator --bin inference-bazaar-operator-lite
```

> ⛔ **Do NOT do this in production.** Running `inference-bazaar-operator run`
> directly (with a hardcoded `SERVICE_ID` / `TEST_MODE=true`) bypasses the entire
> on-chain lifecycle. It's a dev shortcut only.

### Production — run the Blueprint Manager (it spawns the instance)

Each production operator box runs the **Blueprint Manager daemon**. The manager
watches the chain and **spawns the `inference-bazaar-operator run` instance itself**
when a user's service request is approved — you never `ExecStart` the instance binary:

```bash
cargo-tangle blueprint run --protocol tangle \
  --http-rpc-url <HTTP_RPC> --ws-rpc-url <WS_RPC> \
  --keystore-uri <KEYSTORE> --data-dir <DATA>/bpm-data \
  --chain testnet --settings-file <DATA>/settings.env
# systemd SyslogIdentifier=blueprint-manager
```

Your operator config (the env in §6 / `.env.operator`) goes in `settings.env`,
which the manager passes to the instance it spawns. The full register → request →
approve → spawn flow is §8. `deploy/gen-resell-operator.sh` generates this unit +
settings file for a resell operator. Reference: `ai-trading-blueprint/deploy/go-live.sh`.

Once an instance is live, kick a quote cycle (or let the tick-keeper do it every ~5 min):

```bash
curl -X POST http://127.0.0.1:9100/mm-tick \
  -H 'content-type: application/json' \
  -d '{"instrumentId":"groq/llama-3.1-8b-instant:output"}'
```

You're live when `GET /book` shows your quotes and a buyer's `/rfq` returns a
signed order at your strike.

---

## 8. Join the on-chain blueprint (governance — multi-party)

To serve under the shared Tangle Blueprint service (so the app/router list you
as an approved operator), register and get approved. This is **not** a single
local command — it's the Tangle service lifecycle:

```bash
# Deploy/locate the blueprint (one-time, per network):
deploy/base-sepolia.sh                      # cargo tangle blueprint deploy tangle …

# Then, as the operator:
cargo tangle blueprint register   --blueprint-id <ID> --keystore-uri <KEYSTORE>
# A USER requests a service selecting registered operators:
cargo tangle blueprint request-service --blueprint-id <ID> …
# An approver (governance/Safe) approves on-chain; once approved, the Blueprint
# Manager you started in §7 SPAWNS your instance with the assigned SERVICE_ID.
# You never run the instance binary yourself — the manager does.
```

The production unit is the **Blueprint Manager** (§7; `deploy/gen-resell-operator.sh`
generates one). The older `deploy/hetzner/inference-bazaar-blueprint-runtime.service`
runs the instance binary directly with `TEST_MODE=true` + a hardcoded `SERVICE_ID`
— that is a **test/dev** config, not the production pattern.

---

## Troubleshooting

| Symptom | Cause → fix |
|---|---|
| panic: *"bonded issuer must serve its own model … router-proxy mode is forbidden"* | You set CLOB operators / a signing key but no backend. Set `INFERENCE_BAZAAR_VLLM_MODEL` or `INFERENCE_BAZAAR_INFERENCE_URL` (or `INFERENCE_BAZAAR_ATTESTER_ONLY=1` if you only co-sign). |
| `sidecar error` on every quote | The mm-sidecar isn't running / `INFERENCE_BAZAAR_SIDECAR_URL` is wrong (step 5). |
| *"insufficient on-chain funding to back this quote"* | Your `freeCollateral` is below the quote notional — deposit more collateral (step 3) or quote smaller (`INFERENCE_BAZAAR_MM_SIZE`). |
| Fills never settle / `settleFills` reverts | The signing key's address isn't in the book's attester set, or the submitter key has no gas. |
| `/credits` returns nothing for a holder who has lots | `INFERENCE_BAZAAR_FROM_BLOCK` is after the lots' fill block, or the lots were issued by a different operator. |
