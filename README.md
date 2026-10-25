# Inference Bazaar

**An open market for AI inference.** Buy discounted inference. Sell your spare
inference. Operators make markets in inference tokens; the spread is the product.

This is the Tangle Blueprint that builds [inference-bazaar.blueprint.tangle.tools](https://inference-bazaar.blueprint.tangle.tools/) —
a two-sided marketplace for **prepaid inference token credits**, settled through
the Tangle Router. It is modeled on the **ai-trading-blueprint** (operator-run
autonomous agents, arena UI, validator-gated on-chain settlement) but trades
inference tokens instead of crypto assets, and it reuses the **llm-inference /
modal-inference** blueprints for the sell side.

## What's here

```
contracts/         InferenceBazaarSettlement (custody, lots, attested/proven batches) + BSM — live on Base Sepolia
crates/
  orderbook/       the deterministic integer matching engine (NativeBook) + BookClient seam
  matcher/         set-deterministic epoch matcher + consensus (election, verification, quorum)
  settlement/      EIP-712 signing, SignedFill batching, alloy chain client
  settlement-core/ shared digest/types — byte-parity with the contract and the SP1 guest
operator/          the venue: HTTP + Tangle blueprint runner, shared-CLOB epoch service,
                   RFQ, redemption serving, inference backend seam
zk/                SP1 program re-executing the batch for settleBatchProven
packages/
  market-core/     orderbook · A–S quoting · risk gate · ledger · seeded simulator
  mm-loop/         the market-making LOOP, on @tangle-network/agent-runtime/kernel
  router-bridge/   Tangle Router client · ShieldedCredits SpendAuth · Tor (Arti) privacy
app/               the market UI (NBBO across venues, trading, lots) — Cloudflare Pages
```

Current state: two operators live on Base Sepolia settle cross-operator epoch
batches through a 2-of-2 attested quorum; credits redeem against real inference.
`ROADMAP.md` is the source of truth for what is proven vs open.

The **market-making loop** is the centerpiece: one market-making session is one
`runAgentRounds` run on the agent-runtime kernel API. It runs in two modes through one
kernel — a deterministic Avellaneda–Stoikov quoter, or a sandboxed agent — both
gated by the same fail-closed risk desk.

The **privacy** layer keeps sellers anonymous via **Tor** (through Arti, the Tor
Project's Rust implementation): requests tunnel through Arti's SOCKS proxy to
operators reached as `.onion` services, and anti-sticky operator selection stops
a seller's redemptions from concentrating on the same operators (which would let
them correlate and de-anonymize the seller). No hand-rolled crypto — Tor does the
anonymity; we only choose which operator fulfills.

## Quick start

```bash
pnpm install
pnpm -r test           # TS suites
cargo test --workspace # Rust: matcher, consensus, operator, clob e2e
cd contracts && forge soldeer install && forge test  # settlement contract suite
pnpm demo:mm           # market-making session against the simulator
```

Example `pnpm demo:mm` output (seed 42, 120 ticks, Opus-4.8 output tokens):

```
decision        done
instrument      anthropic/claude-opus-4-8:output
ticks           120 (rejected quote sets: 0)
fills           75
position        24673 tokens
equity          $-0.0088
realized        $-0.0087
max drawdown    $0.0127
kill switch     false
final ref mid   $15.1555 per 1M tokens
loop iterations 120, cost $0
```

## Run an operator

To sell inference on the market — build the operator, post collateral, point it
at your inference backend, and quote — follow **[docs/OPERATOR_ONBOARDING.md](docs/OPERATOR_ONBOARDING.md)**.
The mechanical steps are scripted:

```bash
source deploy/.env.deployed                 # contract coordinates from a deploy
OPERATOR_KEY=0x... INFERENCE_BAZAAR_INFERENCE_URL=https://your-backend/v1 \
  COLLATERAL_AMOUNT=20000000 deploy/onboard-operator.sh
```

## Using the loop

```ts
import { runMarketMakingLoop, SimVenue } from '@inference-bazaar/mm-loop'
import { SimulatedMarket } from '@inference-bazaar/market-core'

const venue = new SimVenue(new SimulatedMarket(instrument, simConfig))
const { decision, report } = await runMarketMakingLoop({
  venue, params, limits, horizonTicks: 120,
})
```

Point `venue` at the simulator to develop; implement the `MarketVenue` port
against the marketplace blueprint's HTTP API to make markets for real. Swap
`mode: 'agentic'` with a `@tangle-network/sandbox` client to let an agent quote.

## Design

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for the full system: what's traded,
the loop's control flow and why it's shaped that way, the two payment rails
(Stripe/platform credits and on-chain ShieldedCredits/x402), the Tor-via-Arti
privacy layer, and the blueprint migration map with exact source paths.

## For agents

The app ships the Tangle agent surfaces as static files under
[app/public](app/public): `llms.txt`, `.well-known/tangle-agent.json`, and
`agent-setup.md` — a complete setup prompt for both agent buyers (fund a Tempo
key, deposit, take a signed firm quote, verify a lot on-chain) and agent
operators (bond collateral, serve a model, quote). They serve at exact paths
alongside the SPA (Cloudflare Pages serves matching static assets before the
`/*` rewrite applies).

## Local qualification

Before merge, merge the fresh default branch into the working branch and run affected source checks and real integration checks through the admitted Beelink launcher. Workflow/docs-only changes use YAML, content, link, diff and static checks. Comprehensive commands below are references for the relevant full qualification, selected by the changed surface.

[rust-toolchain.toml](rust-toolchain.toml), the root/app package manifests and their locks own toolchain/dependency selection. The admitted host also needs Foundry, `protoc` and the maintained SP1 toolchain used by [scripts/prove-batch.sh](scripts/prove-batch.sh). The following comprehensive reference preserves the former Rust feature surfaces, Solidity suite, cross-stack parity, separate zk host/guest workspaces, Anvil integration paths and root/app TypeScript populations:

```bash
beelink-gate auto https://github.com/tangle-network/inference-bazaar.git "$(git rev-parse HEAD)" -- bash -c 'set -e; cargo fetch --locked; cargo fmt --all --check; cargo clippy -p inference-bazaar-orderbook -p inference-bazaar-settlement-core -p inference-bazaar-matcher -p inference-bazaar-settlement --all-targets -- -D warnings; cargo test --workspace; cargo build -p inference-bazaar-operator --features chain; cargo build -p inference-bazaar-operator --features mesh; cargo build -p inference-bazaar-matcher --no-default-features; (cd contracts && forge soldeer install && forge fmt --check && forge build --sizes && forge test -vvv); cargo test -p inference-bazaar-settlement --test parity; (cd contracts && forge test --match-path "test/Eip712Parity.t.sol" -vvv); (cd zk && SP1_SKIP_PROGRAM_BUILD=1 cargo build --release); bash scripts/prove-batch.sh execute; bash scripts/settlement-e2e.sh; pnpm install --frozen-lockfile; bash scripts/spend-e2e.sh; bash scripts/gateway-multilot-e2e.sh; pnpm -r typecheck; pnpm -r test; (cd app && pnpm install --frozen-lockfile && pnpm typecheck && pnpm test)'
```

These integration references use disposable local Anvil and the existing synthetic upstreams; circuit qualification uses `execute`, not the funded submit mode. The [operator publisher](.github/workflows/release.yml) and [Pages deploy](.github/workflows/deploy-app.yml) retain their independent builds and release authority. PR/push CI is retired; pre/post-deploy evidence in [the testnet release guide](docs/testnet-release.md) remains required.
