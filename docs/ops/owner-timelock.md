# Owner custody — the timelock (audit C2)

`InferenceBazaarSettlement` is `Ownable2Step`. The owner can rotate a book's attesters
and set the SP1 verifier — both trust-critical. If the owner is a single EOA,
one key compromise rewrites the quorum and drains custody. The fix: the owner is
a `TimelockController`, so every privileged call must be **publicly scheduled and
wait out a delay** before it can execute. There is no EOA shortcut and no way to
shorten the delay except through the timelock itself.

## How a production deploy gets it, by construction

`Deploy.s.sol` with `USE_TIMELOCK=1` deploys the timelock, hands it ownership,
bootstraps the `Ownable2Step` accept and raises the delay inline, then renounces
the deployer's bootstrap admin role. The contract is owned by the timelock from
its first block. Pinned by `test/Timelock.t.sol` (CI-gated).

```bash
PRIVATE_KEY=<deployer> \
PAYMENT_TOKEN=<tsUSD> \
USE_TIMELOCK=1 \
TIMELOCK_DELAY=86400 \                # 24h reaction window (mainnet: 24–48h)
TIMELOCK_ADMIN=<gnosis-safe-address> \ # the multisig — proposer + executor
forge script script/Deploy.s.sol --rpc-url <rpc> --broadcast
```

Resulting state: `owner() == timelock`; the timelock's only proposer/executor is
the Safe; the deployer holds no roles; `getMinDelay() == TIMELOCK_DELAY`.

## Operating a timelock-owned contract

Every owner action is a three-step, publicly-visible operation from the Safe:

```bash
DATA=$(cast calldata "rotateAttesters(bytes32,address[],uint16)" $BOOK "[$A,$B,$C]" 2)
# 1. schedule (from the Safe)
cast send $TIMELOCK "schedule(address,uint256,bytes,bytes32,bytes32,uint256)" \
  $SETTLEMENT 0 $DATA 0x0 $SALT $DELAY
# 2. wait out $DELAY (anyone can watch the CallScheduled event)
# 3. execute (from the Safe)
cast send $TIMELOCK "execute(address,uint256,bytes,bytes32,bytes32)" \
  $SETTLEMENT 0 $DATA 0x0 $SALT
```

`registerBook` is owner-only, so a book is registered the same way — schedule it
through the timelock right after deploy.

## The one decision that is NOT code

`TIMELOCK_ADMIN` must be a **Gnosis Safe with independent signers** for the fix
to be real — a single-EOA proposer behind a timelock only adds delay, not
distributed control. Naming those signers (who, how many, threshold) is an
ownership decision, not an engineering one. Until a Safe exists, the mechanism
is proven and ready; the live testnet contract is deliberately NOT locked behind
a single-EOA timelock (it would add operational drag during active iteration for
no real custody gain). C2 closes at the first **value-bearing** deploy, where
`USE_TIMELOCK=1 TIMELOCK_ADMIN=<safe>` is mandatory.

## Status

- Mechanism: **proven** — `scripts/timelock-anvil.sh` (live ceremony on anvil),
  `test/Timelock.t.sol` (CI gate: delay enforced, EOA can't act, rotation only
  after the delay via the timelock).
- Deploy path: **ready** — `Deploy.s.sol USE_TIMELOCK=1`.
- Live: **gated on the Safe signer decision + the next value-bearing deploy.**
