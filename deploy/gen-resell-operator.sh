#!/usr/bin/env bash
# Generate a full-blueprint "resell" operator for the Hetzner fleet: the
# Blueprint Manager systemd unit + the operator's settings.env. The operator
# resells the Tangle Router's centralized models at a discount.
#
# ⛔ PRODUCTION = THE BLUEPRINT MANAGER, NOT THE INSTANCE BINARY.
# This does NOT ExecStart `inference-bazaar-operator run` — that (with a hardcoded
# SERVICE_ID / TEST_MODE) is for LOCAL TESTING ONLY. The unit runs the Blueprint
# Manager daemon (`cargo-tangle blueprint run`); the manager watches the chain and
# SPAWNS the per-service instance itself when a user's service request is approved.
# See /home/drew/code/bazaar/CLAUDE.md and ai-trading-blueprint/deploy/go-live.sh.
#
# WHY the resell backend is valid (not the forbidden mode): the settings.env points
# INFERENCE_BAZAAR_INFERENCE_URL at the router with the operator's own key → backend
# mode="external", which passes the bonded-issuer check (operator/src/venue.rs). The
# naked ROUTER_URL fallback would be mode="router" and is refused for an issuer.
#
# What you must provide (NOT in the repo — human-gated):
#   OP_N            unique index for paths/unit name (e.g. 5; 3/4 already live)
#   OPERATOR_KEY    EVM attester/signing key, 0x-hex (settlement attester; the
#                   Tangle operator identity is imported into the keystore separately)
#   SUBMITTER_KEY   gas/submitter key, 0x-hex (keep distinct from OPERATOR_KEY)
#   ROUTER_API_KEY  this operator's OWN Tangle Router API key (the resell credential)
#   INSTRUMENT      market to make, e.g. anthropic/claude-opus-4-8:output
#
# Usage:
#   OP_N=5 OPERATOR_KEY=0x.. SUBMITTER_KEY=0x.. ROUTER_API_KEY=tngl-.. \
#   INSTRUMENT=anthropic/claude-opus-4-8:output deploy/gen-resell-operator.sh
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

: "${OP_N:?set OP_N -- unique operator index, e.g. 5}"
: "${OPERATOR_KEY:?set OPERATOR_KEY -- 0x-hex EVM attester key}"
: "${ROUTER_API_KEY:?set ROUTER_API_KEY -- this operator Tangle Router API key}"
SUBMITTER_KEY="${SUBMITTER_KEY:-$OPERATOR_KEY}"
INSTRUMENT="${INSTRUMENT:-anthropic/claude-opus-4-8:output}"
ROUTER_URL="${ROUTER_URL:-https://router.tangle.tools}"
SETTLEMENT_ADDR="${INFERENCE_BAZAAR_SETTLEMENT_ADDR:-0x64867eacf2e4581d182c2Be634cfD7fF3D3d9f83}"
BLUEPRINT_ID="${BLUEPRINT_ID:-17}"
HTTP_RPC="${HTTP_RPC_URL:-https://base-sepolia-rpc.publicnode.com/}"
WS_RPC="${WS_RPC_URL:-wss://base-sepolia.drpc.org/}"
ROOT="/opt/inference-bazaar${OP_N}"
SETTINGS="deploy/hetzner/inference-bazaar${OP_N}.settings.env"
UNIT="deploy/hetzner/inference-bazaar${OP_N}-blueprint-manager.service"

# ── the operator's settings.env — the env the manager hands the spawned instance.
#    NO SERVICE_ID here: the manager assigns it when the service request is approved.
cat > "$SETTINGS" <<EOF
# Inference Bazaar operator ${OP_N} — resell config. The Blueprint Manager passes
# this to the instance it spawns on an approved service request.
INFERENCE_BAZAAR_CHAIN_ID=${INFERENCE_BAZAAR_CHAIN_ID:-84532}
INFERENCE_BAZAAR_SETTLEMENT_ADDR=${SETTLEMENT_ADDR}
INFERENCE_BAZAAR_RPC_URL=${INFERENCE_BAZAAR_RPC_URL:-https://sepolia.base.org}
INFERENCE_BAZAAR_OPERATOR_KEY=${OPERATOR_KEY}
INFERENCE_BAZAAR_SUBMITTER_KEY=${SUBMITTER_KEY}
INFERENCE_BAZAAR_SIDECAR_URL=http://127.0.0.1:9310
INFERENCE_BAZAAR_ROUTER_URL=${ROUTER_URL}
# RESELL backend: serve inference via the Tangle Router with this operator's key.
# mode="external" (passes the bonded-issuer check) — NOT the forbidden router fallback.
INFERENCE_BAZAAR_INFERENCE_URL=${ROUTER_URL}/v1
INFERENCE_BAZAAR_INFERENCE_API_KEY=${ROUTER_API_KEY}
INFERENCE_BAZAAR_INSTRUMENT=${INSTRUMENT}
INFERENCE_BAZAAR_MM_SIZE=1000000
INFERENCE_BAZAAR_MM_LEVELS=3
EOF

# ── the Blueprint Manager systemd unit (the daemon — it spawns the instance).
cat > "$UNIT" <<EOF
[Unit]
Description=Inference Bazaar Blueprint Manager — operator ${OP_N} (blueprint ${BLUEPRINT_ID})
After=network-online.target inference-bazaar-mm-sidecar.service
Wants=network-online.target inference-bazaar-mm-sidecar.service

[Service]
Type=simple
User=root
WorkingDirectory=${ROOT}
Environment=PATH=/root/.cargo/bin:/usr/local/bin:/usr/bin:/bin
Environment=RUST_LOG=info,blueprint_manager=debug,inference_bazaar_operator=debug
EnvironmentFile=${ROOT}/settings.env
# The MANAGER. It watches the chain for approved service requests for blueprint
# ${BLUEPRINT_ID} and spawns the inference-bazaar-operator instance itself.
ExecStart=/root/.cargo/bin/cargo-tangle blueprint run --protocol tangle \\
  --http-rpc-url ${HTTP_RPC} --ws-rpc-url ${WS_RPC} \\
  --keystore-uri ${ROOT}/keystore --data-dir ${ROOT}/bpm-data \\
  --chain testnet --settings-file ${ROOT}/settings.env
Restart=always
RestartSec=10
SyslogIdentifier=blueprint-manager

[Install]
WantedBy=multi-user.target
EOF

OP_ADDR=$(command -v cast >/dev/null && cast wallet address --private-key "$OPERATOR_KEY" 2>/dev/null || echo "<cast wallet address --private-key \$OPERATOR_KEY>")

cat <<RUNBOOK

==> wrote ${UNIT}
==> wrote ${SETTINGS}   (operator ${OP_N}, reselling ${ROUTER_URL} as ${INSTRUMENT})
    operator address: ${OP_ADDR}

Runbook (⚠ = human-gated). The manager spawns the instance — you never run it by hand:

1. ⚠ Fund ${OP_ADDR} (gas + collateral token) and post collateral:
     COLLATERAL_AMOUNT=20000000 OPERATOR_KEY=${OPERATOR_KEY} deploy/onboard-operator.sh
2. Install on 178.104.232.124 (the manager + its keystore/settings):
     ssh root@178.104.232.124 'mkdir -p ${ROOT}/keystore ${ROOT}/bpm-data'
     scp ${SETTINGS} root@178.104.232.124:${ROOT}/settings.env
     scp ${UNIT} root@178.104.232.124:/etc/systemd/system/
3. ⚠ Import the operator's Tangle identity into the keystore + register for the blueprint:
     cargo tangle blueprint register --blueprint-id ${BLUEPRINT_ID} --keystore-uri ${ROOT}/keystore
4. Start the manager (it now waits for a service request):
     ssh root@178.104.232.124 'systemctl daemon-reload && systemctl enable --now inference-bazaar${OP_N}-blueprint-manager'
5. ⚠ A USER requests a service selecting these operators; operators APPROVE:
     cargo tangle blueprint request-service --blueprint-id ${BLUEPRINT_ID}   # the buyer/demand side
     # operators approve -> the running manager SPAWNS the instance with the assigned service id.

RUNBOOK
