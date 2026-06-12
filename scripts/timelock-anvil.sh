#!/usr/bin/env bash
# Prove the owner-timelock ceremony on anvil before touching the live contract:
# deploy settlement + a TimelockController, hand ownership to the timelock, and
# show that a privileged action (rotateAttesters) now MUST go schedule -> wait
# -> execute, and that the old EOA owner can no longer act directly.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${ANVIL_PORT:-8546}"
RPC="http://127.0.0.1:$PORT"
K=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 # anvil #0 = deployer/proposer
DEPLOYER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
DELAY=3600
ZERO=0x0000000000000000000000000000000000000000

anvil --port "$PORT" --silent & APID=$!
trap 'kill $APID 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.1; done

OUT=$(cd contracts && PRIVATE_KEY="$K" forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast 2>&1)
S=$(grep -oP 'SurplusSettlement: \K0x\w+' <<<"$OUT")
echo "settlement=$S owner=$(cast call $S 'owner()(address)' --rpc-url $RPC)"
B32_0=0x0000000000000000000000000000000000000000000000000000000000000000
cast send "$S" "registerBook(bytes32,address[],uint16,uint16,address)" $B32_0 "[$DEPLOYER]" 1 0 $ZERO --private-key "$K" --rpc-url "$RPC" >/dev/null
echo "book 0x0 registered (1-of-1 [$DEPLOYER])"

# Deploy TimelockController(minDelay, proposers[], executors[], admin).
# Proposer + executor = the deployer EOA here (a Gnosis Safe in production).
TL=$(cast send --private-key "$K" --rpc-url "$RPC" --json \
  $(cd contracts && forge create dependencies/@openzeppelin-contracts-5.1.0/governance/TimelockController.sol:TimelockController \
    --private-key "$K" --rpc-url "$RPC" --broadcast \
    --constructor-args $DELAY "[$DEPLOYER]" "[$DEPLOYER]" $ZERO 2>/dev/null | grep -oP 'Deployed to: \K0x\w+')) >/dev/null 2>&1 || true
TL=$(cd contracts && forge create dependencies/@openzeppelin-contracts-5.1.0/governance/TimelockController.sol:TimelockController \
  --private-key "$K" --rpc-url "$RPC" --broadcast \
  --constructor-args $DELAY "[$DEPLOYER]" "[$DEPLOYER]" $ZERO 2>/dev/null | grep -oP 'Deployed to: \K0x\w+')
echo "timelock=$TL delay=${DELAY}s"

# Hand ownership over: transferOwnership(timelock), then the timelock must
# acceptOwnership() — scheduled through itself.
cast send "$S" "transferOwnership(address)" "$TL" --private-key "$K" --rpc-url "$RPC" >/dev/null
ACCEPT=$(cast calldata "acceptOwnership()")
B32=0x0000000000000000000000000000000000000000000000000000000000000000
SALT=$B32
cast send "$TL" "schedule(address,uint256,bytes,bytes32,bytes32,uint256)" "$S" 0 "$ACCEPT" $B32 $SALT $DELAY --private-key "$K" --rpc-url "$RPC" >/dev/null
echo "accept scheduled; executing before delay should REVERT:"
if cast send "$TL" "execute(address,uint256,bytes,bytes32,bytes32)" "$S" 0 "$ACCEPT" $B32 $SALT --private-key "$K" --rpc-url "$RPC" >/dev/null 2>&1; then
  echo "  ✗ executed early (delay NOT enforced)"; exit 1
else echo "  ✓ reverted (delay enforced)"; fi
cast rpc evm_increaseTime $((DELAY + 1)) --rpc-url "$RPC" >/dev/null && cast rpc evm_mine --rpc-url "$RPC" >/dev/null
cast send "$TL" "execute(address,uint256,bytes,bytes32,bytes32)" "$S" 0 "$ACCEPT" $B32 $SALT --private-key "$K" --rpc-url "$RPC" >/dev/null
echo "owner after accept: $(cast call $S 'owner()(address)' --rpc-url $RPC) (timelock=$TL)"

# The old EOA can no longer rotate attesters directly.
echo "direct rotateAttesters from old EOA should REVERT:"
if cast send "$S" "rotateAttesters(bytes32,address[],uint16)" $B32_0 "[$DEPLOYER]" 1 --private-key "$K" --rpc-url "$RPC" >/dev/null 2>&1; then
  echo "  ✗ EOA still privileged"; exit 1
else echo "  ✓ reverted (EOA no longer owner)"; fi

# Through the timelock it works, but only after the delay.
ROT=$(cast calldata "rotateAttesters(bytes32,address[],uint16)" $B32_0 "[$DEPLOYER]" 1)
SALT2=0x0000000000000000000000000000000000000000000000000000000000000001
cast send "$TL" "schedule(address,uint256,bytes,bytes32,bytes32,uint256)" "$S" 0 "$ROT" $B32 $SALT2 $DELAY --private-key "$K" --rpc-url "$RPC" >/dev/null
cast rpc evm_increaseTime $((DELAY + 1)) --rpc-url "$RPC" >/dev/null && cast rpc evm_mine --rpc-url "$RPC" >/dev/null
cast send "$TL" "execute(address,uint256,bytes,bytes32,bytes32)" "$S" 0 "$ROT" $B32 $SALT2 --private-key "$K" --rpc-url "$RPC" >/dev/null
echo "attesters via timelock: $(cast call $S 'bookAttesters(bytes32)(address[])' $B32_0 --rpc-url $RPC)"
echo ""
echo "=== TIMELOCK CEREMONY PROVEN ==="
