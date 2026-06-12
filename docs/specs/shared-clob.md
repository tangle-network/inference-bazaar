# Spec — Blueprint-wide market: venue discovery, NBBO aggregation, and the shared CLOB

**The end-game market structure for Surplus.** Today's app trades against one
operator's venue on one service instance. The protocol underneath is already
plural — many service instances per blueprint, many operators per instance,
one global settlement contract. This spec defines the three phases that take
the product from "one operator's shop" to a top-tier aggregated market with a
shared, verifiable order book.

Status: Phase A live (registry + NBBO + SOR in the app). Phase C live on the
attested path — see §3 for exactly what is proven vs open.

---

## 0. The structural facts this design stands on

1. **Blueprint ≠ deployment.** Blueprint 17 is the template. A *service
   instance* is an activated operator-set agreement under it. Anyone can
   request a new instance; operators join by bonding restake. There will be
   many instances.
2. **Every operator's venue endpoint is on-chain.**
   `registerOperator(blueprintId, ecdsaPublicKey, rpcAddress)` stores
   `OperatorPreferences { ecdsaPublicKey, rpcAddress }`, readable via
   `getOperatorPreferences(blueprintId, operator)`. Discovery is protocol
   data, never app config.
3. **Settlement is global and order formats are uniform.** One
   `SurplusSettlement` per chain. Every order on every venue is the same
   EIP-712 `Order` under the same domain; every issuer's lots are backed by
   the same collateral rule (collateral ≥ liability × (1 + penalty), checked
   at mint). Quotes from different operators are therefore *directly
   comparable and identically settleable*. This is what makes aggregation
   safe and what makes a shared book possible at all.
4. **One venue serves many instruments** (21 today), and one operator may run
   multiple venues: an operator address has one `rpcAddress` per blueprint,
   but an *entity* can run several operator addresses, and one endpoint can
   front several internal books. "Venue" in this spec = one (operator,
   rpcAddress) pair; multiplicity comes from operators, not from config.

## 1. Phase A — Venue registry + NBBO + competitive RFQ *(build now)*

The market becomes the union of every live venue, with the buyer always
seeing and hitting the best firm price.

**Discovery (client-side, on-chain only):**
- Enumerate service instances: `getService(id)` for id 0..N (global sequential
  ids; filter `blueprintId == 17` and status Active). N is small; a multicall
  sweep is cheap. (Indexer later; not required.)
- Union the operator sets (`getServiceOperators(id)`); for each operator read
  `getOperatorPreferences(17, op).rpcAddress`.
- Health-probe each endpoint (`/health`, latency). The registry is
  `{ operator, serviceId, venueUrl, healthy, latencyMs }[]`, refreshed on an
  interval. Operators with no live endpoint appear in the operator set but
  hold no quotes.

**Aggregation (NBBO):**
- Per instrument: fetch every healthy venue's `/book`; merge levels into one
  ladder, each level tagged with its operator. Best ask/bid across venues is
  the displayed top of book. Depth charts render the merged ladder; rows
  attribute levels to operators (identicon = who you'd trade with).
- List price still comes from the router catalog; discount = 1 − NBBO ask/list.

**Competitive RFQ (the auction):**
- A firm buy fans `/rfq` to every healthy venue quoting the instrument,
  collects signed maker orders, and selects best price (ties → lowest
  latency). The buyer signs against the winner only. Settlement is unchanged
  — the winning order clears on the global contract exactly as today.
- The losing quotes are dropped (they expire by TTL; no cancel needed).

**Invariant:** aggregation introduces no new trust. Every displayed level is
an operator's signed-quotable price; every executed trade is the same
two-signature atomic settlement as a single-venue trade.

**Acceptance (Phase A):**
- [ ] Registry derives venues purely from chain state; adding an operator
  on-chain makes it appear in the app with zero app changes.
- [ ] Two live venues with different discount policies; the markets board
  shows the tighter quote winning the NBBO, attributed per operator.
- [ ] A firm buy RFQs all venues and settles against the best quote
  (observable: settlement tx's sell order signer = best quoter).

## 2. Phase B — Smart routing + lot portability

- **Split routing:** a size larger than the best venue's top level splits
  across venues (walk the merged ladder, one RFQ per contributing operator,
  N settlements). UI shows the split plan before signing.
- **Resale routing:** selling a held lot RFQs every venue's bid — including
  operators other than the issuer. The lot is issuer-backed regardless of
  who buys it back; `lotId`-bearing sell orders are already supported by the
  contract.
- **Operator quoting policy surface:** per-instrument discount/size policy in
  the operator config (today env-global), so venues differentiate and the
  auction has texture.
- **Acceptance:** a buy larger than any single venue's depth fills across ≥2
  operators in one user flow; a lot bought from operator A is sold to
  operator B with A still the issuer of record.

## 3. Phase C — The shared CLOB (sequenced matching, verifiable batches)

Phases A/B are quote-driven (dealer market). The end-game adds a *shared
limit order book* per instrument — resting orders from anyone, matched by
price-time priority, with the match itself verifiable. The settlement spine
already contains the hard half: `settleBatchAttested` (m-of-n attester
quorum over `(batchNonce, fillsHash)`) and `settleBatchProven` (SP1 proof of
the matching circuit, sharing digest code with `crates/settlement-core`).
What's missing is the matcher role and its protocol:

- **Sequencer-of-the-epoch:** per instrument (or shard of instruments), one
  operator in the service instance is the matcher for an epoch (rotation by
  on-chain schedule — e.g. round-robin over the bonded set by block number).
  The matcher's bond is slashable for provable misconduct.
- **Order flow:** traders submit signed `Order`s (the existing EIP-712 type —
  unchanged) to the matcher's venue; the matcher gossips them to peer
  operators (the ecdsa gossip keys registered on-chain are for exactly this).
  Resting orders are cancellable by signed cancel (already on-chain:
  `cancelled` mapping honors `OrderCancelled`).
- **Matching:** price-time priority inside the epoch; the epoch's fills form
  a batch: `fillsHash = keccak(abi.encode(domainSeparator, fills))`.
- **Settlement paths, in order of maturity:**
  1. *Attested:* peer operators re-execute the match against the gossiped
     order set and co-sign the batch → `settleBatchAttested`. A rogue quorum
     can at most vouch for signatures never made — balance/collateral/cap
     invariants are still enforced on-chain (already true in the contract).
  2. *Proven:* the SP1 program (zk/program) executes the same fills and
     commits `(domainSeparator, fillsHash)` → `settleBatchProven`. The
     matcher cannot misreport a match; an invalid batch is uncommittable.
- **Misconduct & liveness:** censorship/reordering inside an epoch is
  detectable by peers holding the gossiped order set; a co-signed fraud claim
  routes to the BSM slashing path (same `proposeSlash` rail as redemption
  default). Liveness: if the matcher misses its epoch deadline, the next
  operator in rotation assumes the epoch.
- **UI:** the book stops being per-operator: one shared ladder per
  instrument; user limit orders rest in it; the dealer RFQ path remains as
  the take-liquidity fast path.

**Status (2026-06-11):** LIVE on the attested path. The matcher kernel
(`crates/matcher`, set-deterministic — a pure function of the order set, so
peers recompute the batch bit-for-bit), the consensus layer (election,
`verify_proposal` checking trader-signature authenticity + match recomputation
+ censorship, attestation quorum), and the epoch service (`operator/src/clob.rs`:
HTTP gossip, epoch driver, co-sign round, `settleBatchAttested` submit) are
deployed on services 3 + 4. One refinement over the spec sketch: matching is
**set-deterministic, not price-time** — intra-epoch priority is price then
order-digest, never arrival order, so the proposer has zero sequencing
discretion and "peers re-execute" is exact rather than trust-the-claimed-order.
Transport is a seam (`ClobNet`): the HTTP peer list (`SURPLUS_CLOB_OPERATORS`,
what the live fleet runs), or — built with `--features mesh` and
`SURPLUS_MESH_ADDR` — blueprint-networking's PKI-gated gossip, where the
handshake whitelist IS the bonded attester set (`AllowedKeys::EvmAddresses`,
EVM-recovery handshakes, topic scoped per chain+contract), proven by a 3-node
in-process e2e (`operator/tests/mesh_clob.rs`). Settled orders are final at
admission: replaying a settled order can no longer re-enter pools and grief the
next batch. Upstream caveat: blueprint-networking 0.2.0-alpha.7's
`handle.send()` encodes fixint while its receivers decode varint — broken both
ways; `mesh.rs` encodes the envelope itself with matching varint options until
that's fixed upstream. BSM fraud-claim wiring remains open.

**Acceptance (Phase C):**
- [x] Two operators run the matcher rotation; a third-party wallet's limit
  order fills against flow entered at a DIFFERENT operator in an epoch batch
  (live 2026-06-11: batchNonce 0→1 on `0x3fa62248…`, tx
  `0x388f4408a4cd25de682facf15826e2c170397dc8ed5c93446a930d60435eed96`).
- [x] A batch settles via quorum attestation on Base Sepolia (same tx);
  tampered batches are rejected — on-chain by `_verifyQuorum` (Batch.t.sol),
  off-chain by peers (forged order / wrong fillsHash / impersonated proposer
  all refused, operator/tests/clob_e2e.rs).
- [ ] The same batch settles via `settleBatchProven` with a real SP1 proof
  (Succinct prover network), and a forged proof is rejected.

## 4. Non-goals

- Off-chain custody or netting outside SurplusSettlement.
- A privileged "official" venue: the registry treats every bonded operator
  identically; the reference deployment is just the first entry.
- Bearer credit tokens (unchanged from the redemption spec — transfer happens
  through settlement, preserving issuer backing).
