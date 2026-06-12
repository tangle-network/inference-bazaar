#!/usr/bin/env bash
# Reproducible SP1 batch-proving runbook for settleBatchProven.
#
# The proving HALF is validated locally end to end (the guest commits exactly
# abi.encode(domainSeparator, fillsHash) — what the contract recomputes). What
# remains to satisfy shared-clob.md Phase-C acceptance #3 is FUNDED on-chain ops:
# register the vkey against the real SP1 gateway and submit one real proof. Both
# are spelled out at the bottom; this script does everything that does NOT need
# a funded Base Sepolia owner key.
#
# Usage:
#   scripts/prove-batch.sh execute              # validate the guest (no proof)
#   scripts/prove-batch.sh groth16              # produce a real proof (heavy; docker)
#   scripts/prove-batch.sh vkey                 # print the program verification key
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-execute}"
CHAIN_ID="${SURPLUS_CHAIN_ID:-84532}"
CONTRACT="${SURPLUS_SETTLEMENT_ADDR:-0x1cD49739e9CF48C4906aDb44021dd8cE0d8aBa64}"
# Canonical SP1 Groth16 verifier gateway, live on Base Sepolia.
GATEWAY="${SP1_VERIFIER_GATEWAY:-0x397A5f7f3dBd538f23DE225B51f532c34448dA9B}"
export PATH="$HOME/.sp1/bin:$PATH"

echo "→ building prover (compiles the guest ELF via the succinct toolchain)…"
( cd zk && cargo build --release -p surplus-batch-prover )
PROVE=zk/target/release/prove

case "$MODE" in
  vkey)
    ( cd zk && cargo run -q --release -p surplus-batch-prover --bin vkey )
    exit 0
    ;;
  execute|groth16)
    echo "→ generating a real mutually-signed crossing pair…"
    cargo run -q -p surplus-settlement --example sign_fixture -- \
      --chain-id "$CHAIN_ID" --contract "$CONTRACT" > /tmp/surplus-fills.json
    echo "→ $MODE…"
    SP1_PROVER=cpu "$PROVE" --fills /tmp/surplus-fills.json \
      --chain-id "$CHAIN_ID" --contract "$CONTRACT" --mode "$MODE" --out /tmp/surplus-proof.json
    ;;
  *) echo "unknown mode: $MODE (execute|groth16|vkey)"; exit 1 ;;
esac

VKEY="$( cd zk && cargo run -q --release -p surplus-batch-prover --bin vkey )"
cat <<EOF

────────────────────────────────────────────────────────────────────────────
Validated locally. Remaining FUNDED on-chain steps (owner key for $CONTRACT):

  # 1. Wire the REAL SP1 gateway + this program's vkey (enables the proven path):
  cast send $CONTRACT 'setSp1Verifier(address,bytes32)' \\
      $GATEWAY $VKEY --rpc-url \$SURPLUS_RPC_URL --private-key \$OWNER_KEY

  # 2. Produce a real proof (this script, mode groth16) → /tmp/surplus-proof.json,
  #    then submit its proofBytes with the matching BatchFill[] via
  #    SettlementClient::settle_batch_proven (crates/settlement/src/chain.rs).

A forged/malformed proof is rejected by the gateway on-chain; the wrong-public-
values case is already covered off the real verifier by Batch.t.sol.
────────────────────────────────────────────────────────────────────────────
EOF
