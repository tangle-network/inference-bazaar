#!/usr/bin/env bash
# Deploy the Surplus blueprint to Base Sepolia (chain 84532) via cargo-tangle.
# Mirrors ai-trading-blueprint/deploy/go-live-base-sepolia.sh. Run after a clean
# local devnet e2e. Requires the operator built with --features blueprint.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CARGO_TANGLE="${CARGO_TANGLE:-$ROOT/.cargo-tangle-target/release/cargo-tangle}"

export HTTP_RPC_URL="${HTTP_RPC_URL:-https://sepolia.base.org}"
export WS_RPC_URL="${WS_RPC_URL:-wss://base-sepolia-rpc.publicnode.com}"
export CHAIN_ID=84532
# Tangle protocol contracts on Base Sepolia (from ai-trading-blueprint manifest).
export TANGLE_CONTRACT="${TANGLE_CONTRACT:-0x8299d60f373f3a4a8c4878e335cb9d840e6e3730}"
export STAKING_CONTRACT="${STAKING_CONTRACT:-0x91b1186f4f31d6e02e481c0af29c7244a3fe417d}"
export STATUS_REGISTRY_CONTRACT="${STATUS_REGISTRY_CONTRACT:-0x2a7ceb96a9b18721b5bbb0022b4d358b3c50bcb2}"

: "${DEPLOYER_KEY:?set DEPLOYER_KEY (operator signing key)}"
: "${SURPLUS_SHIELDED_CREDITS_ADDRESS:?deploy ShieldedCredits first, then set its address}"

echo "==> Deploy blueprint to Base Sepolia (chain $CHAIN_ID)"
"$CARGO_TANGLE" blueprint deploy tangle \
  --network testnet \
  --definition "$ROOT/blueprint.toml" \
  --http-rpc-url "$HTTP_RPC_URL" \
  --ws-rpc-url "$WS_RPC_URL" \
  --keystore-path "${KEYSTORE_PATH:-$ROOT/.keystore}"

echo "==> Next: register operator, request+approve service, then run:"
echo "    cargo run --manifest-path operator/Cargo.toml --bin surplus-operator --features blueprint"
