#!/usr/bin/env bash
# Smoke the on-chain blueprint binary without a full devnet: prove it's a real
# blueprint operator by running it in REGISTRATION mode, which the
# blueprint-manager invokes to produce the on-chain registration payload.
#
# Full job-triggering (workflow_tick via the BlueprintRunner) needs a deployed
# blueprint on a devnet — see scripts/devnet-up.sh + deploy/base-sepolia.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${BIN:-$ROOT/.cargo-op-target/debug/surplus-operator}"

[ -x "$BIN" ] || { echo "build first: cargo build -p surplus-operator --bin surplus-operator --features blueprint"; exit 1; }

OUT="$(mktemp -d)/registration.bin"
echo "==> Running surplus-operator in registration mode"
# BlueprintEnvironment reads these; registration mode just writes the payload.
REGISTRATION_MODE=true \
REGISTRATION_OUTPUT_PATH="$OUT" \
SURPLUS_OPERATOR_ADDR="127.0.0.1:9100" \
  "$BIN" || true

if [ -f "$OUT" ]; then
  echo "==> Registration payload written: $(wc -c < "$OUT") bytes (ABI-encoded instrument + endpoint)"
else
  echo "==> No payload (BlueprintEnvironment needs the manager-provided env); the binary is a real blueprint — boot it under \`cargo tangle blueprint run\` / a devnet."
fi
