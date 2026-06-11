#!/usr/bin/env bash
# Smoke the lite venue over HTTP. Needs surplus-operator-lite + mm-sidecar up
# (see scripts/devnet-up.sh). Exercises: ref push -> MM tick -> a buyer lifting
# the MM's ask -> book + settlement-outbox state.
set -euo pipefail
OP="${SURPLUS_OPERATOR_ADDR:-127.0.0.1:9100}"
INST="anthropic/claude-opus-4-8:output"

echo "health:";  curl -fsS "http://$OP/health"; echo
echo "set ref \$15/M:"; curl -fsS -X POST "http://$OP/ref" -H 'content-type: application/json' \
  -d "{\"instrumentId\":\"$INST\",\"refMid\":15000000}"; echo
echo "mm tick (quotes from sidecar):"; curl -fsS -X POST "http://$OP/mm-tick" -H 'content-type: application/json' \
  -d "{\"instrumentId\":\"$INST\"}"; echo
echo "buyer lifts 100k:"; curl -fsS -X POST "http://$OP/order" -H 'content-type: application/json' \
  -d "{\"instrumentId\":\"$INST\",\"side\":\"buy\",\"price\":15200000,\"qtyTokens\":100000,\"owner\":\"buyer-1\",\"rail\":\"router-credits\"}"; echo
echo "book:"; curl -fsS -X POST "http://$OP/book" -H 'content-type: application/json' \
  -d "{\"instrumentId\":\"$INST\"}"; echo
echo "settlement outbox (signed fills, if SURPLUS_OPERATOR_KEY configured):"
curl -fsS "http://$OP/settlement/outbox"; echo
