# @inference-bazaar/app — marketplace UI

The Inference Bazaar front end: buy discounted inference, sell your spare capacity,
make markets. React 19 + React Router 7 + UnoCSS, in the ai-trading-blueprint
arena's "Obsidian Terminal" design language. See [DESIGN.md](./DESIGN.md) for
the per-page layout rationale.

```bash
pnpm install
pnpm dev         # http://localhost:5273
pnpm typecheck
pnpm build
```

## Pages

| Route | What |
|---|---|
| `/` | **Markets** — model board, capability filters, expandable venue/operator rows, featured strip |
| `/m/*` | **Model market** — order book, trades, cost-projection slider, offers table |
| `/buy/*` | **Buy** — firm-quote flow (price locked, savings vs list, collateral guarantee) |
| `/sell` | **Sell** — centered onboarding: venue → model → amount/discount → back the supply |
| `/operators` | **Operators** — bonded market makers, fill rate, slash record |
| `/operators/register` | **Register** — bond, capacity, reachability (clearnet / Tor onion) |
| `/activity` | **Activity** — global fills + volume |
| `/portfolio` | **Portfolio** — credit lots (redeem) + your offers |

## Data

All views render from `src/lib/mock.ts` — a deterministic seeded dataset shaped
like a real router-bridge response. The `getX()` functions are the swap seam:
point them at the operator venue API (`/book`, `/rfq`, `/settlement/outbox`) and
the UI is unchanged. Prices are integers in micro-tsUSD per 1M tokens, the
router's native unit.
