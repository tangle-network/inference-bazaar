#!/usr/bin/env bash
# Reproducible SP1 batch-proving runbook for settleBatchProven.
#
# The proving HALF is validated locally end to end: the guest runs match_epoch
# IN-CIRCUIT over the signed order set and commits abi.encode(domainSeparator,
# bookId, batchNonce, ordersCommitment, fillsHash) — exactly what the contract
# recomputes. So "proven" attests the fills are the canonical match of the set,
# not merely that some chosen fills were signed. What remains is FUNDED on-chain
# ops: register the vkey against the real SP1 gateway and submit one real proof.
# Both are spelled out at the bottom; this script does everything that does NOT
# need a funded Base Sepolia owner key.
#
# Usage:
#   scripts/prove-batch.sh execute              # validate the guest (no proof)
#   scripts/prove-batch.sh groth16              # produce a real proof (heavy; docker)
#   scripts/prove-batch.sh submit               # produce a proof AND settle it on-chain
#                                               #   (needs SURPLUS_RPC_URL + SURPLUS_SUBMITTER_KEY)
#   scripts/prove-batch.sh vkey                 # print the program verification key
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-execute}"
CHAIN_ID="${SURPLUS_CHAIN_ID:-84532}"
CONTRACT="${SURPLUS_SETTLEMENT_ADDR:-0x64867eacf2e4581d182c2Be634cfD7fF3D3d9f83}"
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
  execute|groth16|submit)
    BOOK_ID="${SURPLUS_CLOB_BOOK:-0x0000000000000000000000000000000000000000000000000000000000000000}"
    INSTRUMENT="${SURPLUS_INSTRUMENT:-anthropic/claude-opus-4-8:output}"
    PROVE_MODE="$MODE"
    SUBMIT_ARGS=()
    if [[ "$MODE" == "submit" ]]; then
      PROVE_MODE="groth16"
      : "${SURPLUS_RPC_URL:?submit needs SURPLUS_RPC_URL}"
      : "${SURPLUS_SUBMITTER_KEY:?submit needs SURPLUS_SUBMITTER_KEY}"
      SUBMIT_ARGS=(--submit --rpc "$SURPLUS_RPC_URL" --key "$SURPLUS_SUBMITTER_KEY")
    fi
    echo "→ generating a real mutually-signed crossing order set…"
    cargo run -q -p surplus-settlement --example sign_fixture -- \
      --chain-id "$CHAIN_ID" --contract "$CONTRACT" > /tmp/surplus-orders.json
    echo "→ $MODE (guest matches the set in-circuit)…"
    SP1_PROVER=cpu "$PROVE" --orders /tmp/surplus-orders.json \
      --instrument "$INSTRUMENT" --tick 1 --min-qty 1 \
      --chain-id "$CHAIN_ID" --contract "$CONTRACT" --book-id "$BOOK_ID" \
      --mode "$PROVE_MODE" --out /tmp/surplus-proof.json "${SUBMIT_ARGS[@]}"
    [[ "$MODE" == "submit" ]] && { echo "submitted ✓"; exit 0; }
    ;;
  *) echo "unknown mode: $MODE (execute|groth16|submit|vkey)"; exit 1 ;;
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
