#!/usr/bin/env bash
# Cross-instance (Layer-2) e2e: TWO INDEPENDENT venues (separate operators, no
# shared CLOB — two distinct instances) each rest an ask at a DIFFERENT price for
# the same instrument. The app's REAL fetchAggBook merges both /book endpoints
# into one NBBO ladder and the REAL planRoute splits one buy across both venues.
# Proves the "one market" thesis end-to-end over real venue processes — the
# Layer-2 claim that until now only ran at N=1. Requires foundry + tsx.
set -euo pipefail
cd "$(dirname "$0")/.."

ANVIL_PORT="${ANVIL_PORT:-8546}"
RPC="http://127.0.0.1:$ANVIL_PORT"

# anvil default funded keys — test material only.
DEPLOYER_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
OP_B_KEY="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
OP_A_ADDR="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
OP_B_ADDR="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"

PORT_A="${PORT_A:-9230}"   # venue A — the DEARER instance
PORT_B="${PORT_B:-9231}"   # venue B — the CHEAPER instance
INSTRUMENT="claude-sonnet-4-6:output"

cargo build -q -p surplus-operator --bin surplus-operator-lite --features chain

anvil --port "$ANVIL_PORT" --silent &
ANVIL_PID=$!
OP_PIDS=()
cleanup() { for p in "${OP_PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; kill $ANVIL_PID 2>/dev/null || true; }
trap cleanup EXIT
for _ in $(seq 1 50); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.1; done

OUT=$(cd contracts && PRIVATE_KEY="$DEPLOYER_KEY" forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast 2>&1)
SETTLEMENT=$(grep -oP 'SurplusSettlement: \K0x\w+' <<<"$OUT")
USD=$(grep -oP 'MockUSD: \K0x\w+' <<<"$OUT")
echo "deployed: settlement=$SETTLEMENT"

# Two INDEPENDENT venues: no SURPLUS_CLOB_OPERATORS, so each is its own instance
# (its own dealer book). This is the cross-instance setup the NBBO aggregates.
start_venue() { # port key
  SURPLUS_OPERATOR_ADDR="127.0.0.1:$1" \
  SURPLUS_OPERATOR_KEY="$2" \
  SURPLUS_CHAIN_ID=31337 \
  SURPLUS_SETTLEMENT_ADDR="$SETTLEMENT" \
  SURPLUS_RPC_URL="$RPC" \
  SURPLUS_INSTRUMENT="$INSTRUMENT" \
  SURPLUS_RL_CAPACITY=100000 SURPLUS_RL_REFILL=10000 \
  SURPLUS_INFERENCE_URL="http://127.0.0.1:1" \
  SURPLUS_SIDECAR_URL="http://127.0.0.1:1" \
  ./target/debug/surplus-operator-lite &
  OP_PIDS+=($!)
}
start_venue "$PORT_A" "$DEPLOYER_KEY"
start_venue "$PORT_B" "$OP_B_KEY"
for port in "$PORT_A" "$PORT_B"; do
  for _ in $(seq 1 50); do curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1 && break; sleep 0.1; done
done
echo "venues up: A(dearer) :$PORT_A  ·  B(cheaper) :$PORT_B"

place() { # port side price qty owner
  curl -fsS -X POST "http://127.0.0.1:$1/order" -H 'content-type: application/json' \
    -d "{\"instrumentId\":\"$INSTRUMENT\",\"side\":\"$2\",\"price\":$3,\"qtyTokens\":$4,\"owner\":\"$5\"}" >/dev/null
}
# Venue B rests the cheaper ask (14.0), venue A the dearer (15.0). A buy of 8000
# must lift all 5000 of B then roll 3000 onto A — a split across both instances.
place "$PORT_B" sell 14000000 5000  "$OP_B_ADDR"
place "$PORT_A" sell 15000000 10000 "$OP_A_ADDR"
echo "rested: B 5000@14.0  ·  A 10000@15.0"

cd app
NODE_A="http://127.0.0.1:$PORT_A" NODE_B="http://127.0.0.1:$PORT_B" \
OP_A="$OP_A_ADDR" OP_B="$OP_B_ADDR" INSTRUMENT="$INSTRUMENT" BUY_QTY=8000 \
  npx tsx src/lib/nbbo-sor.check.ts
