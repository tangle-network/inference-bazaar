#!/usr/bin/env bash
# Real-router resell smoke: local chain + real Tangle Router upstream.
#
# Proves the path that was previously stub-only:
# buyer lot -> session key -> operator /v1/chat/completions -> router.tangle.tools
# -> real completion -> local on-chain spend settlement.
set -euo pipefail
cd "$(dirname "$0")/.."

ROUTER_API_KEY="${ROUTER_API_KEY:-${TANGLE_ROUTER_API_KEY:-}}"
: "${ROUTER_API_KEY:?set ROUTER_API_KEY or TANGLE_ROUTER_API_KEY}"

ANVIL_PORT="${ANVIL_PORT:-8546}"
RPC="http://127.0.0.1:$ANVIL_PORT"
OPERATOR_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" # anvil #0
PORT="${PORT:-9211}"
DATA_DIR=$(mktemp -d)
INSTRUMENT="${INSTRUMENT:-groq/llama-3.1-8b-instant:output}"
MODEL="${INSTRUMENT%:*}"
ROUTER_URL="${ROUTER_URL:-https://router.tangle.tools}"
INFERENCE_URL="${INFERENCE_URL:-${ROUTER_URL%/}/v1}"

PIDS=()
cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  rm -rf "$DATA_DIR"
}
trap cleanup EXIT

echo "checking router catalog + direct completion for $MODEL"
MODEL="$MODEL" ROUTER_URL="$ROUTER_URL" ROUTER_API_KEY="$ROUTER_API_KEY" node --input-type=module - <<'NODE'
const { MODEL, ROUTER_URL, ROUTER_API_KEY } = process.env
const base = ROUTER_URL.replace(/\/$/, '')
const catalog = await fetch(`${base}/v1/models`, {
  headers: { authorization: `Bearer ${ROUTER_API_KEY}` },
})
if (!catalog.ok) throw new Error(`/v1/models -> ${catalog.status}: ${await catalog.text()}`)
const models = (await catalog.json()).data ?? []
if (!models.some((m) => m.id === MODEL)) throw new Error(`${MODEL} is not in the live router catalog`)
const t0 = Date.now()
const completion = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${ROUTER_API_KEY}`,
    'content-type': 'application/json',
    'x-tangle-source': 'inference-bazaar-resell-smoke',
  },
  body: JSON.stringify({
    model: MODEL,
    messages: [{ role: 'user', content: 'Return one short sentence.' }],
    max_tokens: 32,
  }),
})
const text = await completion.text()
if (!completion.ok) throw new Error(`/v1/chat/completions -> ${completion.status}: ${text}`)
const out = JSON.parse(text)
console.log(JSON.stringify({
  model: MODEL,
  status: completion.status,
  ms: Date.now() - t0,
  totalTokens: out.usage?.total_tokens,
  content: out.choices?.[0]?.message?.content?.trim(),
}, null, 2))
NODE

cargo build -q -p inference-bazaar-operator --bin inference-bazaar-operator-lite --features chain

anvil --port "$ANVIL_PORT" --silent &
PIDS+=($!)
for _ in $(seq 1 50); do
  cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break
  sleep 0.1
done

OUT=$(cd contracts && PRIVATE_KEY="$OPERATOR_KEY" forge script script/Deploy.s.sol \
  --rpc-url "$RPC" --broadcast 2>&1)
SETTLEMENT=$(grep -oP 'InferenceBazaarSettlement: \K0x\w+' <<<"$OUT")
USD=$(grep -oP 'MockUSD: \K0x\w+' <<<"$OUT")
[[ -n "$SETTLEMENT" && -n "$USD" ]] || { echo "deploy parse failed"; exit 1; }
echo "deployed local settlement=$SETTLEMENT usd=$USD"

INFERENCE_BAZAAR_OPERATOR_ADDR="127.0.0.1:$PORT" \
INFERENCE_BAZAAR_OPERATOR_KEY="$OPERATOR_KEY" \
INFERENCE_BAZAAR_CHAIN_ID=31337 \
INFERENCE_BAZAAR_SETTLEMENT_ADDR="$SETTLEMENT" \
INFERENCE_BAZAAR_RPC_URL="$RPC" \
INFERENCE_BAZAAR_INSTRUMENT="$INSTRUMENT" \
INFERENCE_BAZAAR_INFERENCE_URL="$INFERENCE_URL" \
INFERENCE_BAZAAR_INFERENCE_API_KEY="$ROUTER_API_KEY" \
DATA_DIR="$DATA_DIR" \
INFERENCE_BAZAAR_RL_CAPACITY=100000 INFERENCE_BAZAAR_RL_REFILL=10000 \
INFERENCE_BAZAAR_SIDECAR_URL="http://127.0.0.1:1" \
./target/debug/inference-bazaar-operator-lite &
PIDS+=($!)
for _ in $(seq 1 50); do
  curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  sleep 0.1
done
echo "operator up on :$PORT (inference -> $INFERENCE_URL, instrument $INSTRUMENT)"

RPC="$RPC" SETTLEMENT="$SETTLEMENT" USD="$USD" VENUE="http://127.0.0.1:$PORT" \
INSTRUMENT="$INSTRUMENT" STREAM_MUST_INCLUDE="" \
node scripts/spend-e2e.mjs
