#!/usr/bin/env bash
# Live settlement-spine e2e against anvil: deploy InferenceBazaarSettlement + dev
# mocks, then run the full guarantee loop (atomic fill -> receipt redemption ->
# collateral default -> attested batch -> proven batch) through the Rust chain
# client. Requires foundry; builds with --features chain.
set -euo pipefail
cd "$(dirname "$0")/.."

ANVIL_PORT="${ANVIL_PORT:-8545}"
DEPLOYER_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

anvil --port "$ANVIL_PORT" --silent &
ANVIL_PID=$!
trap 'kill $ANVIL_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do
  cast chain-id --rpc-url "http://127.0.0.1:$ANVIL_PORT" >/dev/null 2>&1 && break
  sleep 0.1
done

OUT=$(cd contracts && PRIVATE_KEY="$DEPLOYER_KEY" DEPLOY_DEV_VERIFIER=1 \
  forge script script/Deploy.s.sol --rpc-url "http://127.0.0.1:$ANVIL_PORT" --broadcast 2>&1)
SETTLEMENT=$(grep -oP 'InferenceBazaarSettlement: \K0x\w+' <<<"$OUT")
USD=$(grep -oP 'MockUSD: \K0x\w+' <<<"$OUT")
VERIFIER=$(grep -oP 'SP1MockVerifierStrict: \K0x\w+' <<<"$OUT")
echo "deployed: settlement=$SETTLEMENT usd=$USD verifier=$VERIFIER"

cargo run -q -p inference-bazaar-settlement --features chain --example e2e_anvil -- \
  "$SETTLEMENT" "$USD" "$VERIFIER"
