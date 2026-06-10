# Surplus Intelligence

**An open market for AI inference.** Buy discounted inference. Sell your surplus
inference. Operators make markets in inference tokens; the spread is the product.

This is the Tangle Blueprint that builds [surplusintelligence.ai](https://www.surplusintelligence.ai/) —
a two-sided marketplace for **prepaid inference token credits**, settled through
the Tangle Router. It is modeled on the **ai-trading-blueprint** (operator-run
autonomous agents, arena UI, validator-gated on-chain settlement) but trades
inference tokens instead of crypto assets, and it reuses the **llm-inference /
modal-inference** blueprints for the sell side.

## What's here

```
packages/
  market-core/     orderbook · A–S quoting · risk gate · ledger · seeded simulator
  mm-loop/         the market-making LOOP, on @tangle-network/agent-runtime/loops
  router-bridge/   Tangle Router client · ShieldedCredits SpendAuth · onion routing
```

The **market-making loop** is the centerpiece: one market-making session is one
`runLoop` run on the agent-runtime loops API. It runs in two modes through one
kernel — a deterministic Avellaneda–Stoikov quoter, or a sandboxed agent — both
gated by the same fail-closed risk desk.

The **onion routing** layer keeps sellers private: anti-sticky relay selection
plus layered x25519 / ChaCha20-Poly1305 envelopes, so redeeming surplus
inference doesn't repeatedly route a seller to the same operators (which would
let them correlate and de-anonymize the seller).

## Quick start

```bash
pnpm install
pnpm -r test           # 42 tests
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
(Stripe/platform credits and on-chain ShieldedCredits/x402), the onion-routing
privacy layer, and the blueprint migration map with exact source paths.
