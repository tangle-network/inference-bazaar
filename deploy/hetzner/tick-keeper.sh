#!/usr/bin/env bash
# InferenceBazaar workflow_tick keeper — submits the blueprint job on-chain on a timer.
#
# Submits Services.submitJob(uint64 serviceId, uint8 job, bytes args) to the
# Tangle protocol contract on Base Sepolia. Encoding verified byte-for-byte
# against historical submission
# 0xdef6ebfae28b66e571e830b2c24f069d9597a502d5154a0b6728877ee02c26a2:
#   selector 0x3413e8ee = submitJob(uint64,uint8,bytes)
#   args     = abi.encode((bytes(instrumentId)))  # single-field tuple
# Success emits JobSubmitted(uint64 indexed serviceId, uint64 indexed callId,
# uint8 job, address caller, bytes args), topic0
# 0xde37cc48d21778e1c9a075c4e41c5aff6918c3ea6151221f0af3ce8121a29db5.
#
# Install (from repo root, BOX=your Hetzner host):
#   scp deploy/hetzner/tick-keeper.sh                  root@$BOX:/opt/inference-bazaar/tick-keeper.sh
#   scp deploy/hetzner/inference-bazaar-tick-keeper@.service    root@$BOX:/etc/systemd/system/
#   scp deploy/hetzner/inference-bazaar-tick-keeper@.timer      root@$BOX:/etc/systemd/system/
#   ssh root@$BOX 'chmod +x /opt/inference-bazaar/tick-keeper.sh && mkdir -p /etc/inference-bazaar'
#   # per-instance env (instance = on-chain service id):
#   #   /etc/inference-bazaar/tick-keeper-3.env  e.g.  TICK_KEY_FILE=/tmp/inference-bazaar-op2.key
#   #   /etc/inference-bazaar/tick-keeper-4.env  e.g.  TICK_KEY_FILE=/tmp/inference-bazaar-op2.key
#   ssh root@$BOX 'systemctl daemon-reload && systemctl enable --now inference-bazaar-tick-keeper@3.timer inference-bazaar-tick-keeper@4.timer'
# Verify:
#   systemctl list-timers 'inference-bazaar-tick-keeper@*'
#   journalctl -u inference-bazaar-tick-keeper@3.service -n 20
#
# Exit codes: 0 = submitted OK, or deliberately skipped (low balance, lock
# held, transient RPC error). 1 = on-chain revert or hard config error, so
# systemd OnFailure only fires when the chain actually rejected the job.
set -euo pipefail

TICK_RPC="${TICK_RPC:-https://sepolia.base.org}"
TANGLE_CONTRACT="${TANGLE_CONTRACT:-0x8299d60f373f3a4a8c4878e335cb9d840e6e3730}"
TICK_KEY_FILE="${TICK_KEY_FILE:-/tmp/inference-bazaar-op2.key}"
TICK_JOB_INDEX="${TICK_JOB_INDEX:-5}"
# KNOWN LIMITATION: submitJob is owner-gated on-chain, so this keeper shares
# the operator key with the blueprint runtime's result consumer. If the
# consumer's cached nonce goes stale from a keeper submission, its result tx
# fails ("replacement transaction underpriced") and the runner exits; systemd
# restarts it and the producer re-delivers the job — self-healing, verified.
# workflow_tick takes one field: the instrument id. It must be a market the
# venue actually quotes (live router reference) or the tick errors with
# NoReference and no result lands. Override in /etc/inference-bazaar/tick-keeper-<id>.env.
TICK_INSTRUMENT="${TICK_INSTRUMENT:-claude-sonnet-4-6:output}"
# Historical submission used gasLimit 234211 (gasUsed 0x3635d = 222045);
# 400k gives headroom without risking a huge burn on revert.
TICK_GAS_LIMIT="${TICK_GAS_LIMIT:-400000}"
MIN_BALANCE_WEI=500000000000000  # 0.0005 ETH

JOB_SUBMITTED_TOPIC0=0xde37cc48d21778e1c9a075c4e41c5aff6918c3ea6151221f0af3ce8121a29db5

log() { echo "tick-keeper: $*"; }
die() { log "FATAL: $*"; exit 1; }

[ -n "${TICK_SERVICE_ID:-}" ] || die "TICK_SERVICE_ID is required (on-chain service id, e.g. 3 or 4)"
[ -r "$TICK_KEY_FILE" ] || die "key file $TICK_KEY_FILE missing or unreadable"

KEY=$(tr -d '[:space:]' < "$TICK_KEY_FILE")
case "$KEY" in
  0x[0-9a-fA-F]*) [ ${#KEY} -eq 66 ] || die "key in $TICK_KEY_FILE is not 32 bytes of 0x-hex" ;;
  *) die "key in $TICK_KEY_FILE must be 0x-prefixed hex" ;;
esac

KEEPER_ADDR=$(cast wallet address --private-key "$KEY")

BALANCE_WEI=$(cast balance "$KEEPER_ADDR" --rpc-url "$TICK_RPC") || {
  log "balance check failed (RPC error), skipping this tick"
  exit 0
}
# Decimal string compare avoids 64-bit overflow on balances > 9.2 ETH.
wei_lt() {
  [ ${#1} -lt ${#2} ] || { [ ${#1} -eq ${#2} ] && [ "$1" \< "$2" ]; }
}
if wei_lt "$BALANCE_WEI" "$MIN_BALANCE_WEI"; then
  log "LOW BALANCE — keeper $KEEPER_ADDR has ${BALANCE_WEI} wei (< 0.0005 ETH) on chain 84532; REFUSING to submit. Top up to resume ticks."
  exit 0
fi

# Job args: ABI tuple of the job's fields — one bytes field (instrument id).
INSTRUMENT_HEX=$(cast from-utf8 "$TICK_INSTRUMENT")
JOB_ARGS=$(cast abi-encode "f((bytes))" "($INSTRUMENT_HEX)")

# Serialize sends per service id so overlapping timer fires can't nonce-race.
LOCK_FILE="/run/lock/inference-bazaar-tick-keeper-${TICK_SERVICE_ID}.lock"
exec 200>"$LOCK_FILE"
if ! flock -n 200; then
  log "previous tick for service $TICK_SERVICE_ID still in flight (lock $LOCK_FILE held), skipping"
  exit 0
fi

log "submitting workflow_tick: service=$TICK_SERVICE_ID job=$TICK_JOB_INDEX instrument=$TICK_INSTRUMENT keeper=$KEEPER_ADDR balance=${BALANCE_WEI}wei"

set +e
RECEIPT=$(cast send "$TANGLE_CONTRACT" \
  "submitJob(uint64,uint8,bytes)" "$TICK_SERVICE_ID" "$TICK_JOB_INDEX" "$JOB_ARGS" \
  --rpc-url "$TICK_RPC" \
  --private-key "$KEY" \
  --gas-limit "$TICK_GAS_LIMIT" \
  --json 2>&1)
SEND_RC=$?
set -e

if [ "$SEND_RC" -ne 0 ]; then
  if echo "$RECEIPT" | grep -qi 'revert'; then
    log "SUBMISSION REVERTED: $RECEIPT"
    exit 1
  fi
  log "send failed before inclusion (transient RPC/nonce error), skipping this tick: $RECEIPT"
  exit 0
fi

# Pull status, tx hash, and the JobSubmitted callId out of the receipt.
PARSED=$(echo "$RECEIPT" | python3 -c "
import json, sys
r = json.load(sys.stdin)
call_id = ''
for lg in r.get('logs', []):
    t = lg.get('topics', [])
    if lg.get('address', '').lower() == '$TANGLE_CONTRACT'.lower() \
       and len(t) >= 3 and t[0].lower() == '$JOB_SUBMITTED_TOPIC0':
        call_id = int(t[2], 16)
print(r.get('status', ''), r.get('transactionHash', ''), call_id)
") || PARSED=""
read -r TX_STATUS TX_HASH CALL_ID <<<"${PARSED:-unknown unknown unknown}"

if [ "$TX_STATUS" = "0x0" ]; then
  log "SUBMISSION REVERTED on-chain: tx=$TX_HASH service=$TICK_SERVICE_ID job=$TICK_JOB_INDEX"
  exit 1
fi

log "tick submitted: tx=$TX_HASH callId=${CALL_ID:-?} service=$TICK_SERVICE_ID job=$TICK_JOB_INDEX status=$TX_STATUS"
exit 0
