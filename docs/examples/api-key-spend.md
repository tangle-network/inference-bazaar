# Spend a credit like a normal API key

You bought a lot. Here's how it becomes a drop-in OpenAI endpoint — one wallet
signature total, then zero crypto in the request path.

## 1. Mint the key (one signature)

In the app: **Portfolio → your lot → Create API key**. Your wallet signs one
EIP-712 `SpendKeyAuth { lotId, keyHash, maxTokens, expiry }`; the key is
generated in your browser and shown once — only its hash reaches the operator.

Or by hand: generate a secret, build
`sk-surplus-<base64url(lotId ‖ issuerAddress ‖ secret)>`, sign the auth over
`keccak256(keyBytes)` under the settlement contract's domain, and
`POST {operatorUrl}/v1/spend-keys { lotId, keyHash, maxTokens, expiry, signature }`.

## 2. Use it — any OpenAI client

```python
from openai import OpenAI
client = OpenAI(base_url="https://<issuer-venue>/v1", api_key="sk-surplus-…")
r = client.chat.completions.create(model="claude-sonnet-4-6",
                                   messages=[{"role": "user", "content": "hi"}])
```

The issuer venue serves you directly — the operator who owes you the tokens,
collateral-backed on-chain. No router, no intermediary. (The key embeds the
issuer, so anything that can read it — the app, or the Tangle Router as an
optional convenience proxy — can route it without you finding URLs.)

`GET /v1/models` lists what the venue serves. Streaming is not supported yet.

## 3. What happens underneath

Each completion meters your lot's token kind against the key. The operator
periodically settles the cumulative served amount on-chain
(`settleSpend(auth, servedCumulative, holderSig)`), which debits your lot and
releases its liability — visible on Basescan, reconcilable any time against
`spendSettled(authDigest)`.

## Trust model, plainly

Within the cap you signed, you trust the issuer's metering — the same trust
you extend on every served request today — backed by its 105% collateral and
slashable bond. Your levers:

- **`maxTokens`** caps total draw per key.
- **`revokeSpendKey(auth)`** on-chain kills a leaked key immediately;
  anything served-but-unsettled after revocation is the issuer's loss.
- **Reselling or transferring the lot invalidates every outstanding key**
  (settlement binds to the lot's *current* holder).
- The trustless per-request path (`/redeem` with per-message signatures)
  still exists if you want zero metering trust and don't mind the ceremony.
