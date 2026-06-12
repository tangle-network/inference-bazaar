#!/usr/bin/env bash
# Shared-CLOB e2e against anvil: two operator nodes, real contract, full loop —
# gossip a crossing pair entered at DIFFERENT operators, elected proposer
# matches the epoch, the peer independently re-verifies and co-signs, and the
# 2-of-2 quorum settles via settleBatchAttested on-chain. Requires foundry.
set -euo pipefail
cd "$(dirname "$0")/.."

ANVIL_PORT="${ANVIL_PORT:-8545}"
RPC="http://127.0.0.1:$ANVIL_PORT"

# anvil's default funded keys — test material only.
DEPLOYER_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" # 0 = operator A
OP_B_KEY="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"     # 1 = operator B
OP_A_ADDR="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
OP_B_ADDR="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"

PORT_A="${PORT_A:-9210}"
PORT_B="${PORT_B:-9211}"

cargo build -q -p surplus-operator --bin surplus-operator-lite --features chain

anvil --port "$ANVIL_PORT" --silent &
ANVIL_PID=$!
OP_PIDS=()
cleanup() {
  for p in "${OP_PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  kill $ANVIL_PID 2>/dev/null || true
}
trap cleanup EXIT
for _ in $(seq 1 50); do
  cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break
  sleep 0.1
done

OUT=$(cd contracts && PRIVATE_KEY="$DEPLOYER_KEY" forge script script/Deploy.s.sol \
  --rpc-url "$RPC" --broadcast 2>&1)
SETTLEMENT=$(grep -oP 'SurplusSettlement: \K0x\w+' <<<"$OUT")
USD=$(grep -oP 'MockUSD: \K0x\w+' <<<"$OUT")
echo "deployed: settlement=$SETTLEMENT usd=$USD"

# The on-chain quorum the epoch service's co-signatures must clear.
cast send "$SETTLEMENT" "setAttesters(address[],uint16)" "[$OP_A_ADDR,$OP_B_ADDR]" 2 \
  --private-key "$DEPLOYER_KEY" --rpc-url "$RPC" >/dev/null
echo "attesters set: 2-of-2 [$OP_A_ADDR, $OP_B_ADDR]"

CLOB_OPERATORS="$OP_A_ADDR=http://127.0.0.1:$PORT_A,$OP_B_ADDR=http://127.0.0.1:$PORT_B"
start_operator() { # port key
  SURPLUS_OPERATOR_ADDR="127.0.0.1:$1" \
  SURPLUS_OPERATOR_KEY="$2" \
  SURPLUS_CHAIN_ID=31337 \
  SURPLUS_SETTLEMENT_ADDR="$SETTLEMENT" \
  SURPLUS_RPC_URL="$RPC" \
  SURPLUS_INSTRUMENT="claude-sonnet-4-6:output" \
  SURPLUS_CLOB_OPERATORS="$CLOB_OPERATORS" \
  SURPLUS_CLOB_THRESHOLD=2 \
  SURPLUS_CLOB_EPOCH_SECS=5 \
  SURPLUS_RL_CAPACITY=100000 SURPLUS_RL_REFILL=10000 \
  SURPLUS_SIDECAR_URL="http://127.0.0.1:1" \
  ./target/debug/surplus-operator-lite &
  OP_PIDS+=($!)
}
start_operator "$PORT_A" "$DEPLOYER_KEY"
start_operator "$PORT_B" "$OP_B_KEY"
for port in "$PORT_A" "$PORT_B"; do
  for _ in $(seq 1 50); do
    curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1 && break
    sleep 0.1
  done
done
echo "operators up on :$PORT_A (A) and :$PORT_B (B)"

RPC="$RPC" SETTLEMENT="$SETTLEMENT" USD="$USD" \
NODE_A="http://127.0.0.1:$PORT_A" NODE_B="http://127.0.0.1:$PORT_B" \
node scripts/clob-e2e.mjs
