# BSM fraud → slash: making CLOB attesters accountable

Status: **design** (2026-06-13). The redemption-default slash rail is live
(`InferenceBazaarBSM.challengeDefault` → `proposeSlash`). This spec covers the missing
half: turning **CLOB attester misconduct** into an on-chain slash. It is a
design to react to, not yet implemented — the core change touches consensus, so
it needs sign-off before code.

## 1. What "bonded, slashable attesters" requires

The pitch is that a quorum can't cheat because its bond is slashable. Today that
is **aspirational for the CLOB path**: peers detect misconduct off-chain
(`verify_proposal` → `Verdict::Forged` / `Censored`), but there is no on-chain
path from that detection to a slash. The redemption rail works because a default
is an **on-chain fact** (`getDefault`); CLOB misconduct is an **off-chain
observation**, and you cannot slash on an observation — you need objective,
on-chain-verifiable evidence.

So the question for each failure mode is the same: **is there a self-contained
proof the chain can check?**

| Misconduct | Objective on-chain proof? | Resolution |
|---|---|---|
| **Forgery** — quorum vouched for an order no trader signed | **Yes, after a binding change** (§3) | `challengeForgedBatch` → slash the quorum |
| **Wrong match** — fills don't follow from the order set | **Yes** — the SP1 *proven* path (`settleBatchProven`) | a proof of the real match contradicts the settled fills |
| **Censorship** — a valid resting order was excluded | **No** — cannot prove a negative without a DA layer | liveness, not safety: proposer rotation (§5), not slashing |
| **Double-settle / replay** | already impossible | `batchNonce` + `filled` cap (contract invariants) |

The honest scope: **forgery is the one new slashable condition this spec adds**;
wrong-match is the proven path's job; censorship is deliberately *not* slashable
and is handled by rotation.

## 2. Why the attested path is un-challengeable today

`settleBatchAttested` has the quorum sign

```
digest = H(bookId, batchNonce, fillsHash)            // fillsHash = keccak(abi.encode(fills))
```

and `BatchFill { Order buy; Order sell; uint64 qty; uint64 execPrice }` carries
the orders' **terms** (`trader`, price, qty, …) but **no signatures**. So:

- The quorum vouches that *these fills are valid* — including, implicitly, that
  the named traders really signed orders with these terms. That trader-signature
  check is exactly what the quorum does off-chain and the contract does **not**
  redo (the comment in `settleBatchAttested` says so explicitly).
- A forgery is "the quorum signed a batch whose `buy.trader = X`, but X never
  signed such an order." You **cannot prove that on-chain**: there is no
  signature in the fill to invalidate, and "X never signed" is a negative.

This is a real, intentional tradeoff — compression buys it. To make forgery
provable we must put a **checkable signature** inside what the quorum commits to.

## 3. The mechanism — bind the signed order set, then forgery is self-contained

### 3a. Consensus change (the load-bearing part)

Bind an `ordersCommitment` **over signed orders** into the attested digest, the
same field the proven path already carries:

```
digest = H(bookId, batchNonce, fillsHash, ordersCommitment)
ordersCommitment = keccak256(abi.encode([ keccak256(order_i ‖ sig_i) for i in matched set ]))
```

- `ordersCommitment` commits the **(order, signature)** pairs the proposer
  matched — not bare orders. The signature is now inside the commitment, so it
  is checkable later.
- This is a wire/consensus change: every node computes and signs the new digest;
  `settleBatchAttested` gains an `ordersCommitment` parameter and folds it into
  the digest. A mixed fleet would fail quorum, so it ships fleet-wide together
  (same discipline as the proposer-sig change already deployed).
- The matcher kernel already canonicalizes the order set (set-deterministic), so
  `ordersCommitment` is deterministic across peers with zero new discretion.

### 3b. The challenge (self-contained — no new batch storage)

The signed batch is public (gossiped). The quorum sigs were *passed to*
`settleBatchAttested` and not stored, but a challenger holds them. So the proof
carries everything:

```solidity
function challengeForgedBatch(
    uint64  serviceId,
    bytes32 bookId,
    uint64  batchNonce,
    bytes32 fillsHash,
    bytes32 ordersCommitment,
    bytes[] calldata quorumSigs,      // the attesters that co-signed this batch
    SignedOrder calldata forged,      // an (order, sig) from the committed set
    bytes32[] calldata membershipProof // forged ∈ ordersCommitment
) external returns (uint64 slashId)
```

Contract checks, all objective:
1. **Quorum really vouched for this set.** Re-derive
   `digest = H(bookId, batchNonce, fillsHash, ordersCommitment)`; verify `quorumSigs`
   are ≥ `book.threshold` distinct `book` attesters over `digest` (reuse
   `_verifyQuorum`). This binds the slash to attesters who provably signed *this
   order commitment*.
2. **The forged order is in the committed set.** Verify `membershipProof` against
   `ordersCommitment` for `keccak256(forged.order ‖ forged.sig)`.
3. **The signature is actually invalid.** `ecrecover(orderDigest(forged.order), forged.sig) != forged.order.trader`.
4. **Not already slashed.** `batchChallenged[digest]` guard (one slash per batch).

If 1–4 hold, the quorum co-signed a batch committing to an order whose trader
signature does not verify — an objective forgery. Route it:

```solidity
for each signer in quorumSigs:
    if (_services[serviceId].operators.contains(signer))
        ITangleSlashing(tangleCore).proposeSlash(serviceId, signer, FORGERY_SLASH_BPS, evidence);
```

`evidence = keccak256(abi.encode("inference_bazaar_clob_forgery", bookId, batchNonce, ordersCommitment, forged.order.trader))`.
Tangle core runs its dispute window before the slash finalizes, exactly like
`challengeDefault`.

### 3c. Who gets slashed

Every co-signer, not just the proposer. The proposer constructed the forgery, but
each co-signer **independently re-ran `verify_proposal`** and is supposed to have
caught the bad signature (`Verdict::Forged`); vouching anyway is the slashable
act. Slashing the whole quorum is what makes "peers re-verify" load-bearing
rather than theater. (A softer variant — slash the proposer at
`FORGERY_SLASH_BPS`, co-signers at a smaller `NEGLIGENCE_BPS` — is a parameter
choice, below.)

## 4. Wrong-match → the proven path, not a new challenge

A quorum that vouches for fills that don't follow from the order set (e.g.
matched a non-crossing pair, or wrong price/priority) is **wrong-match**, not
forgery. The objective proof is the SP1 *proven* path: `settleBatchProven` runs
the matcher in-circuit and commits `(domainSeparator, bookId, batchNonce,
ordersCommitment, fillsHash)`; an honest party re-proves the same input set and
gets a different `fillsHash`, contradicting the attested settlement. The slash
hook is the same `proposeSlash`, gated on a verified proof whose `ordersCommitment`
matches the attested batch's but whose `fillsHash` differs. This rides the proven
path's on-chain registration (separate, funded work) — listed here so the threat
model is complete, not because it's new design.

## 5. Censorship is not slashable — rotation handles it

Excluding a valid resting order is impossible to prove on-chain: the chain never
saw the order (it lived in gossip), so "it should have been included" has no
on-chain witness without a data-availability commitment for the whole mempool —
which the design explicitly avoids (it would re-introduce a global ordering
layer). Censorship is therefore a **liveness** concern, bounded structurally:

- Matching is **set-deterministic** — the proposer has zero sequencing
  discretion, so the only censorship is *omission*, and an omitted order simply
  rests and is matched in a later epoch by a (rotated) proposer.
- A peer that holds the order refuses to co-sign (`Verdict::Censored`), so a
  censoring proposer **fails to reach quorum** — censorship costs the proposer
  its epoch, not the trader its fill.

Slashing censorship would require a DA layer (post every gossiped order to a
commitment a challenge can reference). That is a much larger design and is out of
scope unless omission-griefing is observed in practice.

## 6. Rollout

1. Land the digest binding (`ordersCommitment` in the attested digest +
   `settleBatchAttested` param) behind a new book version, with a forge test that
   a forged-order batch is slashable and an honest batch is not.
2. Deploy the new operator binary fleet-wide (homogeneous — like the proposer-sig
   change), repoint to a v-next settlement, register the books.
3. `challengeForgedBatch` is permissionless from day one (like `challengeDefault`).

## 7. Decisions for Drew

- **Slash split**: whole-quorum at one rate, or proposer-heavy + co-signer-light?
  (Recommend whole-quorum equal — it's what makes independent re-verification
  real; revisit if it deters honest co-signing.)
- **`FORGERY_SLASH_BPS`**: redemption default is `DEFAULT_SLASH_BPS`; forgery is
  arguably more severe (it's an attack, not a service failure). A higher rate?
- **Bounty**: pay the challenger a cut of the slashed stake to incentivize
  watchers? (The redemption path is altruistic/permissionless today.)
- **Proven-path priority**: wrong-match slashing depends on the SP1 on-chain
  registration. Sequence it before or after forgery?

Nothing here changes compensation — a defaulted holder is always made whole from
issuer collateral regardless of slash routing (the existing invariant). Slashing
is **deterrence on top**, and this spec extends that deterrence from redemption
defaults to consensus forgery.
