#!/usr/bin/env bash
# Layer-2 END-TO-END: one buy, split across two independent venues by the REAL
# SOR, BOTH legs settled on-chain. Two operators rest signed SELLs at different
# prices; the shipped fetchAggBook + planRoute split the order; the buyer crosses
# each leg's venue and flushes — two settleFills on the one global contract.
set -euo pipefail
cd "$(dirname "$0")/.."

ANVIL_PORT="${ANVIL_PORT:-8547}"
RPC="http://127.0.0.1:$ANVIL_PORT"
DEPLOYER_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" # acct0 = op A
OP_B_KEY="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"     # acct1 = op B
OP_A_ADDR="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
OP_B_ADDR="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
PORT_A="${PORT_A:-9240}"
PORT_B="${PORT_B:-9241}"
INSTRUMENT="claude-sonnet-4-6:output"

cargo build -q -p inference-bazaar-operator --bin inference-bazaar-operator-lite --features chain

anvil --port "$ANVIL_PORT" --silent &
ANVIL_PID=$!
OP_PIDS=()
cleanup() { for p in "${OP_PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; kill $ANVIL_PID 2>/dev/null || true; }
trap cleanup EXIT
for _ in $(seq 1 50); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.1; done

OUT=$(cd contracts && PRIVATE_KEY="$DEPLOYER_KEY" forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast 2>&1)
SETTLEMENT=$(grep -oP 'InferenceBazaarSettlement: \K0x\w+' <<<"$OUT")
USD=$(grep -oP 'MockUSD: \K0x\w+' <<<"$OUT")
echo "deployed: settlement=$SETTLEMENT"

start_venue() { # port key
  INFERENCE_BAZAAR_OPERATOR_ADDR="127.0.0.1:$1" INFERENCE_BAZAAR_OPERATOR_KEY="$2" \
  INFERENCE_BAZAAR_CHAIN_ID=31337 INFERENCE_BAZAAR_SETTLEMENT_ADDR="$SETTLEMENT" INFERENCE_BAZAAR_RPC_URL="$RPC" \
  INFERENCE_BAZAAR_INSTRUMENT="$INSTRUMENT" INFERENCE_BAZAAR_RL_CAPACITY=100000 INFERENCE_BAZAAR_RL_REFILL=10000 \
  INFERENCE_BAZAAR_INFERENCE_URL="http://127.0.0.1:1" INFERENCE_BAZAAR_SIDECAR_URL="http://127.0.0.1:1" \
  ./target/debug/inference-bazaar-operator-lite &
  OP_PIDS+=($!)
}
start_venue "$PORT_A" "$DEPLOYER_KEY"
start_venue "$PORT_B" "$OP_B_KEY"
for port in "$PORT_A" "$PORT_B"; do
  for _ in $(seq 1 50); do curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1 && break; sleep 0.1; done
done
echo "venues up: A :$PORT_A  ·  B :$PORT_B"

cd app
RPC="$RPC" SETTLEMENT="$SETTLEMENT" USD="$USD" \
NODE_A="http://127.0.0.1:$PORT_A" NODE_B="http://127.0.0.1:$PORT_B" \
OP_A_KEY="$DEPLOYER_KEY" OP_B_KEY="$OP_B_KEY" FUNDER_KEY="$DEPLOYER_KEY" \
INSTRUMENT="$INSTRUMENT" BUY_QTY=8000 \
  npx tsx src/lib/layer2-settle.check.ts
