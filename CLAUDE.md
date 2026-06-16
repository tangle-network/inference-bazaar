# Inference Bazaar — agent rules

## ⛔ Deploy the Blueprint Manager, NOT the operator binary

This is the #1 recurring mistake. **Do not** run or `ExecStart` `inference-bazaar-operator run`
directly, with a hardcoded `SERVICE_ID` / `TEST_MODE=true`. That bypasses the entire
on-chain lifecycle and is a dev shortcut only.

A production operator box runs the **Blueprint Manager daemon**:

```
ExecStart=/root/.cargo/bin/cargo-tangle blueprint run -t --pretty \
  --http-rpc-url <HTTP_RPC> --ws-rpc-url <WS_RPC> \
  --keystore-uri <KEYSTORE> --data-dir <DATA>/bpm-data \
  --chain testnet --protocol tangle
# systemd: SyslogIdentifier=blueprint-manager
```

The manager watches the chain and **spawns the per-service `inference-bazaar-operator run`
instance itself** when a service request is approved. `inference-bazaar-operator run`
(`operator/src/bin/blueprint.rs`) is the INSTANCE the manager spawns — it reads `SERVICE_ID`
from the env the manager hands it; it is never launched by hand.

**The lifecycle is two-sided and on-chain — honor every step:**

1. Deploy the Blueprint Manager (the daemon above) on each operator box.
2. The operator **registers** for the blueprint on-chain (`cargo tangle blueprint register`).
3. A **user requests a service** selecting registered operators (`request-service`).
4. Operators **approve**.
5. The already-running Blueprint Manager **spawns the instance** with the assigned service id.

Reference that does this correctly: `~/code/ai-trading-blueprint/deploy/go-live.sh` +
`trading-blueprint.service`. When you write any deploy unit / script / doc, the `ExecStart`
MUST be `cargo-tangle blueprint run`, and the runbook MUST include register → request → approve.

`InferenceBazaarBSM.sol` (`[blueprint.manager]`) is the ON-CHAIN Blueprint Service Manager
(lifecycle hooks/slashing) — a different thing from the off-chain manager daemon. Don't conflate.

## Build / toolchain

- Rust is pinned to **1.91** (`rust-toolchain.toml`). The `--features blueprint` build needs
  **`protoc`** (a transitive dep): `PROTOC=/usr/bin/protoc cargo build … --features blueprint`.
- CI gates: `cargo fmt --all --check`, core-crate `clippy -- -D warnings`
  (`orderbook/settlement-core/matcher/settlement`), `cargo test --workspace`, `forge test`.

## Operator inference backend (the "resell Tangle models" flow)

To resell the Tangle Router's models, set `INFERENCE_BAZAAR_INFERENCE_URL=https://router.tangle.tools/v1`
+ `INFERENCE_BAZAAR_INFERENCE_API_KEY=<key>` → backend `mode="external"`, which passes the
bonded-issuer check. The naked `INFERENCE_BAZAAR_ROUTER_URL` fallback is `mode="router"` and is
**refused** for a bonded issuer (`operator/src/venue.rs`).

## Other gotchas

- **Local git branch refs go stale.** Always `git fetch` and check `origin/<default>` before
  claiming something is unmerged — this has produced wrong "not merged" conclusions repeatedly.
- The fleet is on Base **Sepolia**, not mainnet. The "USDC rail" RPC still points at testnet.
