#!/usr/bin/env bash
# End-to-end smoke of the product loop against a running operator-lite + sidecar:
#   push reference price -> operator quotes via sidecar -> buyer fills -> re-skew.
# Proves the operator <-> sidecar <-> risk-gate path before on-chain wiring.
set -euo pipefail
OP="${SURPLUS_OPERATOR_ADDR:-127.0.0.1:9100}"
INST="anthropic/claude-opus-4-8:output"

echo "health:";       curl -fsS "http://$OP/health"; echo
echo "set ref \$15/M:"; curl -fsS -X POST "http://$OP/ref"  -H 'content-type: application/json' \
  -d "{\"instrumentId\":\"$INST\",\"refMid\":15000000}"; echo
echo "quote:";        curl -fsS -X POST "http://$OP/quote" -H 'content-type: application/json' \
  -d "{\"instrumentId\":\"$INST\"}"; echo
echo "buy 100k:";     curl -fsS -X POST "http://$OP/buy"   -H 'content-type: application/json' \
  -d "{\"instrumentId\":\"$INST\",\"side\":\"buy\",\"qtyTokens\":100000}"; echo
echo "re-quote (inventory-skewed):"; curl -fsS -X POST "http://$OP/quote" -H 'content-type: application/json' \
  -d "{\"instrumentId\":\"$INST\"}"; echo
