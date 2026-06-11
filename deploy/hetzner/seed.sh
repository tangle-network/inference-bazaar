#!/usr/bin/env bash
# Quoting loop for both Surplus venues. Each venue is an independent operator
# with its own discount policy — the NBBO competition is real.
set -u
ROUTER=https://router.tangle.tools
CATALOG=$(curl -sf --max-time 20 "$ROUTER/v1/models") || exit 0

tick_venue() {
  local VENUE=$1 DISC=$2
  local INSTRUMENTS
  INSTRUMENTS=$(curl -sf --max-time 10 "$VENUE/instruments") || return 0
  echo "$INSTRUMENTS" | python3 -c "
import json, sys
for i in json.load(sys.stdin):
    print(i['id'], i['model_id'], i['token_kind'])
" | while read -r IID MODEL KIND; do
    REF=$(echo "$CATALOG" | python3 -c "
import json, sys
model, kind, disc = '$MODEL', '$KIND', $DISC
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
  curl -sf --max-time 30 -X POST "$VENUE/settlement/flush" >/dev/null || true
}

tick_venue http://127.0.0.1:9400 "${SURPLUS_DISCOUNT_BPS:-1200}"
tick_venue http://127.0.0.1:9500 "${SURPLUS2_DISCOUNT_BPS:-900}"
