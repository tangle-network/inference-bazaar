#!/usr/bin/env bash
# Generate a full-blueprint "resell" operator: a systemd unit + an install/register
# runbook for one operator whose inference backend IS the Tangle Router (it resells
# Tangle's centralized models at a discount). Run it once per operator (the live
# fleet already uses indices/ports 3=9500 and 4=9400, so start fresh ones at 5+).
#
# WHY this is a valid resell (not the forbidden mode): the operator points
# INFERENCE_BAZAAR_INFERENCE_URL at the router with its own key → backend
# mode="external" (operator/src/inference.rs), which PASSES the bonded-issuer
# fail-closed check (venue.rs:151). The naked ROUTER_URL fallback would be
# mode="router" and is refused for an issuer.
#
# What you must provide (NOT in the repo — human-gated):
#   OP_N            unique index for paths/unit name (e.g. 5)
#   PORT            unique local HTTP port (e.g. 9700)
#   SERVICE_ID      the on-chain service id (assigned at request-service/approve)
#   OPERATOR_KEY    attester/signing key, 0x-hex (its address must be a book attester)
#   SUBMITTER_KEY   gas/submitter key, 0x-hex (keep distinct from OPERATOR_KEY)
#   ROUTER_API_KEY  this operator's OWN Tangle Router API key (the resell credential)
#   INSTRUMENT      market to make, e.g. anthropic/claude-opus-4-8:output
#
# Usage:
#   OP_N=5 PORT=9700 SERVICE_ID=5 OPERATOR_KEY=0x.. SUBMITTER_KEY=0x.. \
#   ROUTER_API_KEY=tngl-.. INSTRUMENT=anthropic/claude-opus-4-8:output \
#     deploy/gen-resell-operator.sh
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

: "${OP_N:?set OP_N (unique operator index, e.g. 5)}"
: "${PORT:?set PORT (unique local HTTP port, e.g. 9700)}"
: "${OPERATOR_KEY:?set OPERATOR_KEY (0x-hex attester key)}"
: "${ROUTER_API_KEY:?set ROUTER_API_KEY -- this operator Tangle Router API key}"
SUBMITTER_KEY="${SUBMITTER_KEY:-$OPERATOR_KEY}"
INSTRUMENT="${INSTRUMENT:-anthropic/claude-opus-4-8:output}"
SERVICE_ID="${SERVICE_ID:-<set-after-approval>}"
ROUTER_URL="${ROUTER_URL:-https://router.tangle.tools}"
# Default to the tsUSD rail the live fleet uses; override for the USDC rail.
SETTLEMENT_ADDR="${INFERENCE_BAZAAR_SETTLEMENT_ADDR:-0x64867eacf2e4581d182c2Be634cfD7fF3D3d9f83}"
BLUEPRINT_ID="${BLUEPRINT_ID:-17}"
ROOT="/opt/inference-bazaar${OP_N}"
UNIT="deploy/hetzner/inference-bazaar${OP_N}-blueprint-runtime.service"

cat > "$UNIT" <<EOF
[Unit]
Description=InferenceBazaar resell operator ${OP_N} (Base Sepolia blueprint ${BLUEPRINT_ID} service ${SERVICE_ID})
After=network.target inference-bazaar-mm-sidecar.service
Wants=inference-bazaar-mm-sidecar.service

[Service]
Environment=RUST_LOG=info,inference_bazaar_operator=debug
Environment=HTTP_RPC_URL=https://base-sepolia-rpc.publicnode.com/
Environment=WS_RPC_URL=wss://base-sepolia.drpc.org/
Environment=KEYSTORE_URI=${ROOT}/keystore
Environment=DATA_DIR=${ROOT}/data
Environment=BLUEPRINT_ID=${BLUEPRINT_ID}
Environment=SERVICE_ID=${SERVICE_ID}
Environment=TANGLE_CONTRACT=0x8299d60f373f3a4a8c4878e335cb9d840e6e3730
Environment=STAKING_CONTRACT=0x91b1186f4f31d6e02e481c0af29c7244a3fe417d
Environment=STATUS_REGISTRY_CONTRACT=0x2a7ceb96a9b18721b5bbb0022b4d358b3c50bcb2
Environment=PROTOCOL=tangle
Environment=TEST_MODE=true
Environment=INFERENCE_BAZAAR_SIDECAR_URL=http://127.0.0.1:9310
Environment=INFERENCE_BAZAAR_ROUTER_URL=${ROUTER_URL}
# RESELL backend: serve inference by calling the Tangle Router with this
# operator's OWN key. This is mode="external" (a configured OpenAI-compat
# endpoint), which passes the bonded-issuer check — NOT the forbidden naked
# router-proxy fallback.
Environment=INFERENCE_BAZAAR_INFERENCE_URL=${ROUTER_URL}/v1
Environment=INFERENCE_BAZAAR_INFERENCE_API_KEY=${ROUTER_API_KEY}
Environment=INFERENCE_BAZAAR_OPERATOR_ADDR=127.0.0.1:${PORT}
Environment=INFERENCE_BAZAAR_INSTRUMENT=${INSTRUMENT}
Environment=INFERENCE_BAZAAR_MM_SIZE=1000000
Environment=INFERENCE_BAZAAR_MM_LEVELS=3
Environment=INFERENCE_BAZAAR_CHAIN_ID=${INFERENCE_BAZAAR_CHAIN_ID:-84532}
Environment=INFERENCE_BAZAAR_SETTLEMENT_ADDR=${SETTLEMENT_ADDR}
Environment=INFERENCE_BAZAAR_OPERATOR_KEY=${OPERATOR_KEY}
Environment=INFERENCE_BAZAAR_SUBMITTER_KEY=${SUBMITTER_KEY}
Environment=INFERENCE_BAZAAR_RPC_URL=${INFERENCE_BAZAAR_RPC_URL:-https://sepolia.base.org}
ExecStart=/opt/inference-bazaar/inference-bazaar-operator run
Restart=always
RestartSec=5
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF

OP_ADDR=$(command -v cast >/dev/null && cast wallet address --private-key "$OPERATOR_KEY" 2>/dev/null || echo "<derive with: cast wallet address --private-key \$OPERATOR_KEY>")

cat <<RUNBOOK

==> wrote ${UNIT}  (operator ${OP_N}, port ${PORT}, reselling ${ROUTER_URL} as ${INSTRUMENT})
    operator address: ${OP_ADDR}

Runbook to bring it live (human-gated steps marked ⚠):

1. ⚠ Fund the operator: send gas + the collateral token to ${OP_ADDR}, then post
   collateral:  COLLATERAL_AMOUNT=20000000 OPERATOR_KEY=${OPERATOR_KEY} \\
                  deploy/onboard-operator.sh
2. ⚠ Register + request the service on-chain (needs the funded key + cargo-tangle):
     cargo tangle blueprint register      --blueprint-id ${BLUEPRINT_ID}
     cargo tangle blueprint request-service --blueprint-id ${BLUEPRINT_ID}
   then a governance approver (Safe) approves the request → note the SERVICE_ID
   and re-run this generator with SERVICE_ID=<that id> to stamp the unit.
3. Install on the Hetzner box (178.104.232.124):
     ssh root@178.104.232.124 'mkdir -p ${ROOT}/keystore ${ROOT}/data'
     scp ${UNIT} root@178.104.232.124:/etc/systemd/system/
     ssh root@178.104.232.124 'systemctl daemon-reload && systemctl enable --now inference-bazaar${OP_N}-blueprint-runtime'
4. Add port ${PORT} to the quoter loop (deploy/hetzner/seed.sh PORTS) so it ticks.

RUNBOOK
