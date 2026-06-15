# @inference-bazaar/mm-eval

Aggressive, deterministic evaluation of the market-maker's parameters against
the seeded simulator. Sweep a `QuoteParams` grid × seeds, aggregate
PnL/volatility/drawdown/fills, and rank by a risk-adjusted score that
**disqualifies** any config that trips the kill switch *or* fails to make a
market. Reproducible: same config → same ranking, so a tuning result is a fact.

```bash
pnpm --filter @inference-bazaar/mm-eval sweep   # run the default sweep, print a scorecard
pnpm --filter @inference-bazaar/mm-eval test
```

## Finding from the default sweep (180 sessions, fair-mid flow)

The pure Avellaneda–Stoikov **spread-capture** MM is marginally **unprofitable**
in this regime — every trading config loses a little:

| config | fills/session | realized (mean) | worst drawdown |
|---|---|---|---|
| γ=2.5e-6, size=30k (best) | 19 | **−$0.0039** | $0.0095 |
| γ=2.5e-6, size=50k | 28 | −$0.0053 | $0.0125 |
| γ=1.5e-6, size=30k | 80 | −$0.0137 | $0.0176 |
| γ=4e-6 (any) | 0 | $0.0000 | $0.0000 *(disqualified — no liquidity)* |

Three decision-relevant reads:

1. **Tighter/bigger quotes lose more.** More fills → more **adverse selection
   from stale quotes**: the MM quotes off last tick's reference, the reference
   then moves ~22,500 micro/tick (σ), and takers pick off the stale side. The
   ~45,000-micro half-spread only marginally covers one tick of vol.
2. **`k` is inert here.** At these γ, the `(1/γ)·ln(1+γ/k)` term is negligible —
   rows with the same γ/size but different `k` are identical. Don't tune `k` in
   this regime; tune γ and size.
3. **A wider spread doesn't fix it — it stops trading.** γ=4e-6 never fills, so
   it's "safe" with zero PnL. The scorer disqualifies it: a market maker that
   doesn't make a market is not a candidate.

## Implication: the edge is discount-to-list, not spread capture

This is the important part. Pure MM around a *fair* mid is structurally
~breakeven-minus against random flow — that's a known result, and the harness
confirms it for our params. **Inference Bazaar's real edge is not spread capture; it's
sourcing spare inference below the router's list price and reselling toward
it.** That discount-to-list / inventory arbitrage is what makes an operator
profitable, and the fair-mid sweep here deliberately does *not* model it — which
is why it shows the floor (what you earn from spread alone: roughly nothing).

**Next evaluator (parallelizable):** a discount-capture / cross-operator
arbitrage backtest — a seller lists spare capacity below reference, the operator buys
it cheap and reprices toward list; measure the captured discount. That isolates
the actual profit source and is where the self-improving/arbitrage agents earn
their keep.
