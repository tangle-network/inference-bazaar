#!/usr/bin/env bash
# Local InferenceBazaar devnet: Anvil + Tangle protocol via cargo-tangle's harness, then
# the operator + mm-sidecar. Mirrors ai-trading-blueprint/scripts/deploy-local.sh
# but for the inference-token market. Run from the repo root.
#
# Prereqs: docker (for Anvil), the cargo-tangle CLI built at
# .cargo-tangle-target/release/cargo-tangle (see scripts/build-cargo-tangle.sh),
# and pnpm install done.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CARGO_TANGLE="${CARGO_TANGLE:-$ROOT/.cargo-tangle-target/release/cargo-tangle}"

echo "==> 1/4  Local Tangle devnet (Anvil + protocol, chain 31338)"
# Boots Anvil from the pre-deployed Tangle state snapshot and leaves it running.
"$CARGO_TANGLE" blueprint debug --help >/dev/null 2>&1 || true
echo "    cargo tangle harness up   # (run in a dedicated terminal; needs docker)"
echo "    HTTP http://127.0.0.1:8545   WS ws://127.0.0.1:8546   chainId 31338"

echo "==> 2/4  Deploy ShieldedCredits (shielded settlement rail)"
echo "    forge script ../shielded-payment-gateway/script/DeployShielded.s.sol \\"
echo "      --rpc-url http://127.0.0.1:8545 --broadcast --private-key \$DEPLOYER_KEY"
echo "    -> export INFERENCE_BAZAAR_SHIELDED_CREDITS_ADDRESS=0x..."

echo "==> 3/4  mm-sidecar (the quoting brain)"
INFERENCE_BAZAAR_MM_SIDECAR_PORT="${INFERENCE_BAZAAR_MM_SIDECAR_PORT:-9110}" \
  pnpm --filter @inference-bazaar/mm-sidecar start &
SIDECAR_PID=$!
sleep 1

echo "==> 4/4  inference-bazaar operator-lite (market API on :9100)"
INFERENCE_BAZAAR_SIDECAR_URL="http://127.0.0.1:${INFERENCE_BAZAAR_MM_SIDECAR_PORT:-9110}" \
INFERENCE_BAZAAR_ROUTER_URL="${INFERENCE_BAZAAR_ROUTER_URL:-https://router.tangle.tools}" \
  cargo run --manifest-path "$ROOT/operator/Cargo.toml" --bin inference-bazaar-operator-lite

kill "$SIDECAR_PID" 2>/dev/null || true
