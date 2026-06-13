#!/usr/bin/env bash
# Copy Arti's generated onion hostname to a stable path the operator reads via
# SURPLUS_ONION_FILE. Arti writes the hostname under its state dir once the onion
# service bootstraps; the exact subpath varies by version, so locate it. Polls
# briefly because bootstrap is not instant after Arti starts.
set -u
STATE_DIR="${ARTI_STATE_DIR:-/opt/surplus/arti/state}"
OUT="${SURPLUS_ONION_FILE:-/opt/surplus/onion-hostname}"

for _ in $(seq 1 60); do
  # Arti stores the onion service's hostname in a `hostname` file under its
  # keystore/state tree; take the first one found.
  HOST_FILE=$(find "$STATE_DIR" -name hostname -type f 2>/dev/null | head -n1)
  if [ -n "${HOST_FILE:-}" ]; then
    HOST=$(tr -d '[:space:]' < "$HOST_FILE")
    if [ -n "$HOST" ]; then
      echo "$HOST" > "$OUT"
      echo "published onion: $HOST -> $OUT"
      exit 0
    fi
  fi
  sleep 5
done
echo "onion hostname not found under $STATE_DIR after 5m" >&2
exit 0  # non-fatal: the operator simply publishes no onion until it appears
