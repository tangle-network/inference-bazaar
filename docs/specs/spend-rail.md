# Spend rail — metered inference as a one-way payment channel

> Status: design + implementation spec. Supersedes the cap-signed bearer rail.
> The consumption path for a credit lot through a plain OpenAI-compatible API,
> with **over-billing impossible by construction** and **zero per-request wallet
> friction**.

## The problem, precisely

A credit lot is prepaid value: the right to consume `qtyTokens` of a model's
inference, redeemable against the issuing operator. We want a developer to spend
it like a normal hosted API key — `OpenAI(base_url=…, api_key=…)`, no wallet in
the request path — while being safe in a setting where the operator is an
arbitrary bonded party, not a trusted company.

Metered inference has an irreducible truth: **the cost of a request is unknown
until after it runs**, and **the operator is the one who meters it**. So the
whole design question is: how does the consumer pay for "whatever was actually
used" without trusting the operator to self-report the amount?

The previous rail (cap-signed `SpendKeyAuth`) got this wrong: the holder signed
only a *cap*, and `settleSpend(auth, servedCumulative, sig)` took
`servedCumulative` as an **issuer-supplied** number bounded only by that cap. The
holder's signature did not bind the served amount, so the issuer could settle the
full cap having served nothing — a structural rug. This is the well-known weak
end of the [x402 `upto`](https://www.x402.org/x402-whitepaper.pdf) pattern:
"no cryptographic enforcement, only the cap."

## How the field solves it (and what we adopt)

| Approach | Who they are | Over-billing defense | UX |
|---|---|---|---|
| Sell capacity, not usage | Venice (VVV/DIEM) | N/A — buy a daily slice | stake → API access |
| Prepaid credits, server meters | OpenRouter | none (trusted aggregator) | one API key (gold standard) |
| Protocol emissions + validator sampling | Bittensor | validator re-scoring | app-layer |
| Pay-up-to-cap | x402 `upto` | the cap only (server self-reports) | one HTTP cycle |
| **Cumulative signed vouchers** | **x402 MPP Sessions, L402/Lightning** | **client signs the running total; server can't exceed it** | streaming, gateway-mediated |
| Settle-then-prove + re-execute | Atoma (Sampling Consensus), Hyperbolic PoSP | challenge window + slashing | prepaid "Stack" |
| TEE-attested inference | Atoma, Phala, Marlin | enclave signs output; attestation proves the model | transparent |

We adopt the **cumulative-voucher channel** for *payment* (the x402 "MPP
Sessions" / Lightning model — the trust-minimized one), keep the **challenge +
slashing** layer we already built for *correctness disputes* (the Atoma/PoSP
model), and put **TEE attestation** on the roadmap for *authenticity* (proving
the operator served the model it claimed — the one thing payment vouchers cannot
prove). This is layered so each layer removes a distinct trust, and the consumer
never depends on Surplus's own servers for either funds or access.

## The mechanism: a one-way payment channel per lot

Two EIP-712 structs under the `SurplusSettlement` domain:

```
SpendPermit  { bytes32 lotId, address sessionKey, uint64 maxTokens, uint64 expiry }
SpendVoucher { bytes32 lotId, address sessionKey, uint64 servedCumulative }
```

1. **Open (one wallet signature).** The consumer generates an ephemeral
   **session keypair** and the lot holder signs ONE `SpendPermit` delegating that
   session key to draw down the lot up to `maxTokens` until `expiry`. The session
   key is a capped, expiring, revocable hot key — its entire blast radius is one
   lot. The holder's main wallet is never used again for this lot.

2. **Spend (no signatures the dev sees).** The consumer's **gateway** (below)
   holds the session key. After each served request it signs a `SpendVoucher`
   acknowledging the new cumulative tokens served, and hands it to the operator.
   The operator serves request *N+1* only once it holds a voucher covering
   everything served through *N* (tit-for-tat): the operator's worst-case
   exposure is a single unacknowledged request.

3. **Settle (anyone, keeper-friendly).** The operator presents
   `settleSpend(permit, holderSig, servedCumulative, voucherSig)`. The contract
   verifies the holder authorized the session key (`holderSig → lot.holder`,
   current holder, so resale kills outstanding keys) **and** the session key
   acknowledged exactly `servedCumulative` (`voucherSig → permit.sessionKey`),
   bounded by `maxTokens`, strictly monotone, within lot availability. It debits
   the lot proportionally.

The load-bearing property: **the operator can only ever settle an amount the
consumer's session key cryptographically signed.** The operator does not hold
that key, so it **cannot over-bill** — not "we detect it," it is impossible.
Settlement can be permissionless because a higher amount is unforgeable.

### Why this is safe in both directions and offline-robust

- **Issuer over-bill:** impossible (needs `voucherSig`, which it can't forge).
- **Consumer take-and-don't-pay:** bounded to ~one request (operator stops
  serving when the voucher stops advancing).
- **Resale / revocation / expiry:** `settleSpend` reverts on a stale holder,
  `revokeSpend`, or expiry — so the holder is always protected. The operator
  mirrors these so it does not serve into a settlement it cannot land: expiry is
  checked per request in `authorize`; revocation/resale are reconciled each flush
  cycle (`reconcile_revocations` drops any channel the holder revoked or whose lot
  changed hands). Any unbillable service is bounded to one flush interval — the
  operator's risk, by design.
- **Operator down:** the lot is still the consumer's; unspent value returns as
  cash via `reclaimExpired` / `claimDefault` — **permissionless on-chain calls,
  no dependency on Surplus.**
- **Surplus down:** see the gateway — a self-hostable local gateway means the
  consumer needs only the chain + the operator, never us.

## The gateway — where the seamless UX lives

A small **OpenAI-compatible proxy** that holds the session key and does the
voucher dance invisibly:

```
your OpenAI code ──► gateway /v1/chat/completions ──► operator /v1/chat/completions
                       (signs SpendVoucher,            (verifies voucher covers
                        attaches to next request)        prior usage, serves, meters)
```

The developer experience is exactly a hosted API key:

```python
client = OpenAI(base_url="http://localhost:8088/v1", api_key="sk-surplus-…")
client.chat.completions.create(model="anthropic/claude-opus-4-8", messages=[…])
```

Two deployment modes, same UX:
- **Local gateway** (`surplus-gateway`): the consumer runs it; it holds the
  session key; **zero trust in Surplus** — they depend only on the chain + the
  operator.
- **Hosted gateway** (ours): we hold the session key for convenience. Blast
  radius is one lot, capped and revocable — never the consumer's wallet.

A vanilla OpenAI client pointed straight at an operator (no gateway) still works
but degrades to "trust the meter within the cap" (the old model); the gateway is
the default and the only fully-safe path. The gateway is the single thing that
turns a payment channel into "just an API key."

## What this does NOT prove yet (and the roadmap)

The voucher proves **how many tokens** were served and that the consumer
acknowledged them. It does **not** prove **which model** actually produced them —
an operator could serve a cheaper model and meter it as the expensive one
([model substitution is a studied attack](https://arxiv.org/pdf/2504.04715)).
Today that is bounded by: the lot is a claim on a *bonded* issuer, the
challenge/slash layer, and reputation. The durable fix is **TEE-attested
inference** (Atoma/Phala/Marlin; ~99% efficiency on H100/H200 confidential
compute): the enclave signs the completion with a measurement-bound key, so a
verifier confirms the right model ran on the input even if the operator is
unknown. The voucher and the receipt both carry a `modelOutput`/attestation
field today as the seam; binding a real enclave attestation into settlement is
the authenticity endgame and slots in without changing the payment channel.

## Migration

Greenfield: the cap-signed `settleSpend` is replaced, not versioned. The
redemption path (work-committed receipt + holder-challenge window) is unchanged
and remains the fully-trustless single-shot consumption option; the spend rail is
the streaming, API-key-shaped option layered on the same lot + collateral +
refund spine.
