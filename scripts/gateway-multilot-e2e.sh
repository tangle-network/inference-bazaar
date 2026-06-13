#!/usr/bin/env bash
# Multi-lot gateway e2e against anvil: ONE operator + a stub OpenAI upstream, TWO
# credit lots behind ONE surplus-gateway. Proves a vanilla OpenAI client drains
# lot 1, fails over to lot 2 seamlessly, and BOTH lots debit on-chain — the
# agentic-run developer experience (a wallet of lots behind one API key).
set -euo pipefail
cd "$(dirname "$0")/.."

ANVIL_PORT="${ANVIL_PORT:-8545}"
RPC="http://127.0.0.1:$ANVIL_PORT"
OPERATOR_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" # anvil #0
PORT="${PORT:-9210}"
STUB_PORT="${STUB_PORT:-9911}"
GW_PORT="${GW_PORT:-8088}"
DATA_DIR=$(mktemp -d)

cargo build -q -p surplus-operator --bin surplus-operator-lite --features chain
cargo build -q -p surplus-operator --bin surplus-gateway

anvil --port "$ANVIL_PORT" --silent &
ANVIL_PID=$!
PIDS=("$ANVIL_PID")
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done; rm -rf "$DATA_DIR"; }
trap cleanup EXIT
for _ in $(seq 1 50); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.1; done

OUT=$(cd contracts && PRIVATE_KEY="$OPERATOR_KEY" forge script script/Deploy.s.sol \
  --rpc-url "$RPC" --broadcast 2>&1)
SETTLEMENT=$(grep -oP 'SurplusSettlement: \K0x\w+' <<<"$OUT")
USD=$(grep -oP 'MockUSD: \K0x\w+' <<<"$OUT")
[[ -n "$SETTLEMENT" && -n "$USD" ]] || { echo "deploy parse failed"; exit 1; }
echo "deployed: settlement=$SETTLEMENT usd=$USD"

PORT=$STUB_PORT node scripts/stub-openai.mjs &
PIDS+=($!)

SURPLUS_OPERATOR_ADDR="127.0.0.1:$PORT" \
SURPLUS_OPERATOR_KEY="$OPERATOR_KEY" \
SURPLUS_CHAIN_ID=31337 \
SURPLUS_SETTLEMENT_ADDR="$SETTLEMENT" \
SURPLUS_RPC_URL="$RPC" \
SURPLUS_INSTRUMENT="claude-sonnet-4-6:output" \
SURPLUS_INFERENCE_URL="http://127.0.0.1:$STUB_PORT" \
DATA_DIR="$DATA_DIR" \
SURPLUS_RL_CAPACITY=100000 SURPLUS_RL_REFILL=10000 \
SURPLUS_SIDECAR_URL="http://127.0.0.1:1" \
./target/debug/surplus-operator-lite &
PIDS+=($!)
for _ in $(seq 1 50); do
  curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  sleep 0.1
done
echo "operator up on :$PORT (inference -> stub :$STUB_PORT)"

RPC="$RPC" SETTLEMENT="$SETTLEMENT" USD="$USD" VENUE="http://127.0.0.1:$PORT" \
GW_PORT="$GW_PORT" GATEWAY_BIN="./target/debug/surplus-gateway" \
node scripts/gateway-multilot-e2e.mjs
