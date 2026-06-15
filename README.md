# Inference Bazaar

**An open market for AI inference.** Buy discounted inference. Sell your surplus
inference. Operators make markets in inference tokens; the spread is the product.

This is the Tangle Blueprint that builds [surplus-market.pages.dev](https://surplus-market.pages.dev/) —
a two-sided marketplace for **prepaid inference token credits**, settled through
the Tangle Router. It is modeled on the **ai-trading-blueprint** (operator-run
autonomous agents, arena UI, validator-gated on-chain settlement) but trades
inference tokens instead of crypto assets, and it reuses the **llm-inference /
modal-inference** blueprints for the sell side.

## What's here

```
contracts/         SurplusSettlement (custody, lots, attested/proven batches) + BSM — live on Base Sepolia
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
  mm-loop/         the market-making LOOP, on @tangle-network/agent-runtime/loops
  router-bridge/   Tangle Router client · ShieldedCredits SpendAuth · Tor (Arti) privacy
app/               the market UI (NBBO across venues, trading, lots) — Cloudflare Pages
```

Current state: two operators live on Base Sepolia settle cross-operator epoch
batches through a 2-of-2 attested quorum; credits redeem against real inference.
`ROADMAP.md` is the source of truth for what is proven vs open.

The **market-making loop** is the centerpiece: one market-making session is one
`runLoop` run on the agent-runtime loops API. It runs in two modes through one
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
cd contracts && forge test  # settlement contract suite
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

## Using the loop

```ts
import { runMarketMakingLoop, SimVenue } from '@surplus/mm-loop'
import { SimulatedMarket } from '@surplus/market-core'

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
