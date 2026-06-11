# Surplus blueprint — operator + open orderbook

The Tangle blueprint that runs the inference-token market. It is a Rust operator
that hosts an **open orderbook** off-chain and clears fills on-chain — the SOTA
hybrid (off-chain matching, on-chain settlement; cf. 0x, dYdX v3).

```
crates/orderbook/   MatchingEngine trait + NativeBook (price-time priority)
operator/           the operator binary (HTTP venue; on-chain runner behind a feature)
blueprint.toml      manifest for `cargo tangle blueprint deploy`
```

## The matching engine is a swappable seam

`MatchingEngine` (`crates/orderbook/src/engine.rs`) is the only thing the
operator depends on. The default is `NativeBook` — a price-time-priority engine
with **no third-party dependency**, ported from the tested `@surplus/market-core`
orderbook (match-on-insert, partial fills, self-match prevention, tick/min-qty
validation, depth snapshots). Swapping the engine never touches operator code:

- **`orderbook-rs`** (joaquinbejar/OrderBook-rs, crates.io `orderbook-rs` v0.8):
  a richer lock-free engine (iceberg/post-only/FOK/IOC orders, STP modes, kill
  switch, snapshot/restore). The trait doc maps each method onto its API; it
  becomes an optional adapter behind the `orderbook-rs` feature. **Not load-
  bearing** — the native engine stands alone if that crate goes unmaintained.
- A future **zk-settled** engine plugs in at the same trait (see below).

## The operator is the venue

`operator/` (binary `surplus-operator-lite`) hosts one book per instrument and
exposes the market over HTTP:

| Route | What |
|---|---|
| `POST /order` | place a limit order (seller lists surplus, buyer lifts, anyone rests) → fills + settlement intents |
| `POST /cancel` | cancel a resting order |
| `POST /book` | depth snapshot + reference price + operator inventory |
| `POST /mm-tick` | pull risk-gated quotes from the **mm-sidecar**, cancel-replace the operator's quotes |
| `POST /ref` | push a reference price (driven by the live router feed in a full build) |

Quoting is delegated to the **mm-sidecar** (the swappable brain — deterministic
Avellaneda–Stoikov today, an agent later); the sidecar's risk verdict, not the
operator, is the safety boundary. Fills attribute inventory to the operator and
emit a **settlement intent per fill** on the rail the order named — both rails
are first-class (`router-credits` and `shielded`), cleared by the settlement
layer in `@surplus/router-bridge`.

Proven live end to end: seller lists surplus → MM ticks and crosses → buyers
lift the seller and the MM → inventory tracks correctly → settlement intents emit
on the chosen rail.

## On-chain runner (built)

The venue runs INSIDE a real Tangle `BlueprintRunner`. `operator/src/bin/blueprint.rs`
(bin `surplus-operator`, `--features blueprint`) mirrors the llm-inference-blueprint
operator:

- The venue starts as a `BackgroundService` (the market is live before the
  runner polls jobs).
- On-chain jobs drive it, wired via `Router::new().route(JOB, handler.layer(TangleLayer))`:
  - **`workflow_tick` (job 30)** — the main thing the runner triggers: runs an
    `mm_tick` (pull risk-gated quotes, cancel-replace the operator's quotes).
  - `list_instrument` (0), `status` (4).
- Job arg/result types are `sol!` ABI structs; `main()` loads `BlueprintEnvironment`,
  handles registration mode, and runs `BlueprintRunner::builder(TangleConfig, env)
  .router(router()).producer(TangleProducer).consumer(TangleConsumer)
  .background_service(venue).run()`.

Verified: compiles against the full alpha SDK (rustc 1.91, `core2` patched like
the reference repos — see `rust-toolchain.toml` and the root `[patch.crates-io]`),
and the binary boots the real blueprint CLI (`surplus-operator run --data-dir …
--http-rpc-url …`).

**Next:** trigger `workflow_tick` through an actual on-chain job — `cargo tangle
harness up` (local devnet), deploy via `cargo tangle blueprint deploy`, register +
request + approve the service, then submit the job (`cargo tangle blueprint jobs`).
See `scripts/` and `deploy/`.

## Future tracks (documented seams, not built)

- **zkVM settlement (SuccinctVM).** For trust-minimized off-chain matching, the
  operator would prove each match batch (book state transition + fills) in a
  zkVM and post the proof + new root on-chain, so settlement is verified, not
  trusted. This is a new `MatchingEngine` impl that wraps `NativeBook` and emits
  a proof alongside `PlaceOutcome` — the trait already isolates it from the
  operator. Worth it only if operator trust is the bottleneck; the validator-set
  model may suffice first.
- **On-chain AMM, off-chain orderbook (hybrid).** An on-chain constant-product
  AMM for inference credits sitting beside the off-chain book, with the operator
  routing/arbitraging between them (the 0x-style split). The AMM gives always-on
  liquidity and a price floor; the book gives tight spreads. This is an adapter +
  an arbitrage strategy in the sidecar, not a change to the matching trait.
