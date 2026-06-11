#!/usr/bin/env bash
# Surplus operator quoting loop: pull real list prices from the Tangle Router,
# set each instrument's reference at the operator's discount policy, and run a
# market-making tick so the venue book carries live two-sided quotes.
set -u
VENUE=http://127.0.0.1:9400
ROUTER=https://router.tangle.tools
DISCOUNT_BPS=${SURPLUS_DISCOUNT_BPS:-1200}

CATALOG=$(curl -sf --max-time 20 "$ROUTER/v1/models") || exit 0
INSTRUMENTS=$(curl -sf --max-time 10 "$VENUE/instruments") || exit 0

echo "$INSTRUMENTS" | python3 -c "
import json, sys
for i in json.load(sys.stdin):
    print(i['id'], i['model_id'], i['token_kind'])
" | while read -r IID MODEL KIND; do
  REF=$(echo "$CATALOG" | python3 -c "
import json, sys
model, kind, disc = '$MODEL', '$KIND', $DISCOUNT_BPS
for m in json.load(sys.stdin)['data']:
    if m['id'] == model:
        p = m.get('pricing') or {}
        key = 'completion' if kind == 'output' else 'prompt'
        try: usd = float(p.get(key) or 0)
        except: usd = 0
        if usd > 0:
            print(round(usd * 1e12 * (1 - disc / 10000)))
        break
")
  [ -n "$REF" ] || continue
  curl -sf --max-time 5 -X POST "$VENUE/ref" -H 'content-type: application/json' \
    -d "{\"instrumentId\":\"$IID\",\"refMid\":$REF}" >/dev/null
  curl -sf --max-time 15 -X POST "$VENUE/mm-tick" -H 'content-type: application/json' \
    -d "{\"instrumentId\":\"$IID\"}" >/dev/null
done

# Submit any paired signed fills on-chain (settleFills on SurplusSettlement).
curl -sf --max-time 30 -X POST "$VENUE/settlement/flush" >/dev/null || true
