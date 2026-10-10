---
name: tangle-inference-bazaar-setup
description: Set up Inference Bazaar for this agent end to end — as a buyer (fund a Tempo testnet key, deposit pathUSD, take a signed firm quote, verify a credit lot on-chain, spend it on a real completion) or as an operator (bond collateral, serve a model, quote). No account or signup; an Ethereum-style key is the identity.
---

# Set up Inference Bazaar

Inference Bazaar is an open market for AI inference. Buyers purchase prepaid, collateral-backed inference-token credit lots below list price; operators sell spare inference capacity; market-makers work the spread. Fills settle atomically on the `InferenceBazaarSettlement` contract — the buyer's payment, the seller's payout, and the credit lot mint happen in one transaction or not at all. A lot is a claim on a bonded issuer: the issuer's on-chain collateral covers the lot's refund value plus a 5% default penalty, so paid-but-unserved spend always comes back as cash.

Use it when:

- You hold (or can create) an Ethereum-style key and want to buy inference at market prices without a platform account — you pay the signed strike, never list price.
- You operate a host with spare inference capacity and want to sell it as collateral-backed credit.
- You want settlement guarantees enforced by a contract, not by a counterparty's promise: atomic fills, a serve deadline, and automatic refunds with penalty on default.

There is no signup, no account, and no API key issuance. Your Ethereum-style key is your identity; every action is a contract call or an EIP-712 signed message. (The payment pattern — deposit stablecoins once, then authorize spends with signatures instead of holding a platform key — is the same crypto-native lane the router documents at https://router.tangle.tools/for-agents-crypto.md.)

## Live deployment (Tempo testnet)

| What | Value |
| --- | --- |
| Chain | Tempo testnet (Moderato), chainId **42431** |
| RPC | `https://rpc.moderato.tempo.xyz` |
| Settlement contract | `0x83084C8cD2282F6126e25089f0FD26b145eCa597` (`InferenceBazaarSettlement`) |
| Payment token | pathUSD `0x20C0000000000000000000000000000000000000` (6 decimals) — gas is also paid in pathUSD |
| EIP-712 domain | `{ name: "InferenceBazaarSettlement", version: "1", chainId: 42431, verifyingContract: 0x83084C8c… }` |
| Market UI | https://inference-bazaar.blueprint.tangle.tools/ |
| Repository | https://github.com/tangle-network/inference-bazaar |

Prices are **micro-pathUSD per 1M tokens** (uint64): `15000000` = $15.00 per 1M tokens. Instruments are `<model>:<kind>`, e.g. `claude-sonnet-4-6:output` (`input` or `output`).

Complete every step in your chosen track in order and stop at the first failure; the error table at the end names the fix. Prerequisites for the buyer track: `curl`, `cast` (Foundry), and outbound HTTPS. One working directory for every step.

## Buyer track — from a key to a verified credit lot

### 1. Create and fund a key

```bash
mkdir bazaar-setup && cd bazaar-setup
cast wallet new --json > key.json   # or import an existing key
export KEY=$(jq -r '.[0].private_key' key.json) ME=$(jq -r '.[0].address' key.json)
export RPC=https://rpc.moderato.tempo.xyz
export SET=0x83084C8cD2282F6126e25089f0FD26b145eCa597 USD=0x20C0000000000000000000000000000000000000
cast rpc tempo_fundAddress $ME --rpc-url $RPC   # testnet faucet; funds pathUSD (which is also gas)
```

Expected: the faucet call returns without error. `chmod 600 key.json` and keep it out of version control (`echo 'key.json' >> .gitignore`). Never print, log, or commit the private key.

### 2. Deposit a buyer balance

```bash
cast send $USD "approve(address,uint256)" $SET 5000000 --rpc-url $RPC --private-key $KEY
cast send $SET "deposit(uint256)" 5000000      --rpc-url $RPC --private-key $KEY
cast call $SET "balances(address)(uint256)" $ME --rpc-url $RPC
```

Expected: `5000000` (5 pathUSD escrowed). `withdraw(uint256)` returns unused cash at any time.

### 3. Find a venue and get a firm quote

Venues are operator-run HTTP endpoints. The app discovers them from on-chain operator registry entries; any venue URL works the same. Ask your owner or the market UI for a live venue, then:

```bash
export VENUE=https://<operator-venue>           # e.g. from the app's Operators page
curl -fsS $VENUE/health
curl -fsS $VENUE/instruments
curl -fsS $VENUE/rfq -H 'content-type: application/json' \
  -d '{"instrumentId":"claude-sonnet-4-6:output","side":"buy","qtyTokens":100000}' > quote.json
```

Expected: `{"quoting":true,"instrumentId":…,"order":{…},"signature":"0x…","digest":"0x…","validUntil":<unix>}`. The `order` is the operator's signed EIP-712 sell order — price locked until `validUntil`. A venue never signs a quote its on-chain collateral cannot settle. Query several venues and take the better price; that is the whole market. If the response is `{"quoting":false,…}`, the operator's risk gate is off or it lacks funding — try another venue or a smaller `qtyTokens`.

### 4. Sign the matching buy order and fill

Sign a buy `Order` against the quote: same `instrument` hash, `side` 0, `priceMicroPerM` equal to the quote's (your limit), `qtyTokens` ≤ the quote's, `lotId` zero, `trader` = your address, `expiry` ≤ the quote's `validUntil`, fresh random `salt`:

```bash
# Fill in from quote.json:
INST=0x$(jq -r '.order.instrument' quote.json | sed 's/^0x//')
PRICE=$(jq -r '.order.priceMicroPerM' quote.json)
QTY=$(jq -r '.order.qtyTokens' quote.json)
EXP=$(jq -r '.validUntil' quote.json)
SALT=0x$(cast keccak $(date +%s%N))
SIG=$(cast wallet sign --private-key $KEY --data "{
  \"domain\": {\"name\":\"InferenceBazaarSettlement\",\"version\":\"1\",\"chainId\":42431,\"verifyingContract\":\"$SET\"},
  \"types\": {\"Order\":[
    {\"name\":\"instrument\",\"type\":\"bytes32\"},
    {\"name\":\"side\",\"type\":\"uint8\"},
    {\"name\":\"priceMicroPerM\",\"type\":\"uint64\"},
    {\"name\":\"qtyTokens\",\"type\":\"uint64\"},
    {\"name\":\"lotId\",\"type\":\"bytes32\"},
    {\"name\":\"trader\",\"type\":\"address\"},
    {\"name\":\"expiry\",\"type\":\"uint64\"},
    {\"name\":\"salt\",\"type\":\"bytes32\"}]},
  \"primaryType\": \"Order\",
  \"message\": {\"instrument\":\"$INST\",\"side\":0,\"priceMicroPerM\":$PRICE,\"qtyTokens\":$QTY,
    \"lotId\":\"0x0000000000000000000000000000000000000000000000000000000000000000\",
    \"trader\":\"$ME\",\"expiry\":$EXP,\"salt\":\"$SALT\"}
}")
```

Then post both orders (the maker verbatim from `quote.json`, your taker beside it) and flush settlement:

```bash
jq -n --arg sig "$SIG" --argjson q "$(cat quote.json)" --argjson order "$(jq -n \
  --arg inst "$INST" --argjson price "$PRICE" --argjson qty "$QTY" --arg trader "$ME" \
  --argjson exp "$EXP" --arg salt "$SALT" \
  '{instrument:$inst,side:0,priceMicroPerM:$price,qtyTokens:$qty,lotId:"0x0000000000000000000000000000000000000000000000000000000000000000",trader:$trader,expiry:$exp,salt:$salt}')" \
  '{maker:{instrumentId:$q.instrumentId,order:$q.order,signature:$q.signature},
    taker:{instrumentId:$q.instrumentId,order:$order,signature:$sig}}' \
| curl -fsS $VENUE/rfq/fill -H 'content-type: application/json' -d @-
curl -fsS -X POST $VENUE/settlement/flush
```

Expected from `/rfq/fill`: `{"filled":true,"qtyTokens":…,"execPriceMicroPerM":…,"costMicro":…,…}`. The flush submits `settleFills` on-chain: your deposit pays the issuer (minus the protocol fee) and a collateral-backed lot mints to you atomically. Get your lot id from the `FillSettled` event (field `lotId`) or from `GET $VENUE/credits?owner=$ME&model=claude-sonnet-4-6&kind=output`. The viem reference for this whole step is `scripts/e2e-firm-buy.mjs` in the repo.

### 5. Verify the lot (the finish line for setup)

```bash
export LOT=0x…   # your lotId from step 4
cast call $SET "lots(bytes32)(address,address,bytes32,uint64,uint64,uint64,uint128)" $LOT --rpc-url $RPC
```

Expected: the first field (`holder`) is your address, `qtyTokens` is what you bought, `notionalMicro` is your remaining refund value. This read is the verified first interaction: you hold a collateral-backed claim on the issuer, settled atomically, visible to anyone on-chain.

### 6. Spend the lot on real inference

Open a redemption (locks quota and starts the issuer's serve deadline — a missed deadline pays you from its collateral via `claimDefault`):

```bash
cast send $SET "requestRedemption(bytes32,uint64)" $LOT 50000 --rpc-url $RPC --private-key $KEY
RID=$(cast call $SET "openRedemptionOf(bytes32)(bytes32)" $LOT --rpc-url $RPC)
```

Serving is holder-gated: sign an EIP-712 `ServeRequest` (domain `InferenceBazaarServe/1`, same chainId and verifyingContract) over the redemption id, the exact messages bytes, a token cap, and an expiry — then POST it to the issuer's venue:

```bash
MSGS='[{"role":"user","content":"Reply with exactly: hello from the bazaar"}]'
MAX=100
SEXP=$(($(date +%s) + 300))
SSIG=$(cast wallet sign --private-key $KEY --data "{
  \"domain\": {\"name\":\"InferenceBazaarServe\",\"version\":\"1\",\"chainId\":42431,\"verifyingContract\":\"$SET\"},
  \"types\": {\"ServeRequest\":[
    {\"name\":\"redemptionId\",\"type\":\"bytes32\"},
    {\"name\":\"messagesHash\",\"type\":\"bytes32\"},
    {\"name\":\"maxTokens\",\"type\":\"uint64\"},
    {\"name\":\"expiry\",\"type\":\"uint64\"}]},
  \"primaryType\": \"ServeRequest\",
  \"message\": {\"redemptionId\":\"$RID\",\"messagesHash\":\"$(cast keccak "$MSGS")\",\"maxTokens\":$MAX,\"expiry\":$SEXP}
}")
curl -fsS $VENUE/redeem -H 'content-type: application/json' \
  -d "{\"redemptionId\":\"$RID\",\"messages\":$MSGS,\"maxTokens\":$MAX,\"auth\":{\"expiry\":$SEXP,\"signature\":\"$SSIG\"}}"
```

The `messages` bytes must be exactly the bytes you hashed. The response contains the completion, `servedTokens`, and `workCommitment`. Acknowledge service by signing `RedemptionReceipt(bytes32 redemptionId,uint64 servedTokens,bytes32 workCommitment)` under the settlement domain and posting it to `$VENUE/redeem/receipt` — or compute the digest yourself with the contract's `receiptDigest(bytes32,uint64,bytes32)` view. Verify the debit by re-reading `lots($LOT)`: quota down by exactly the served tokens. Full walkthrough: `docs/examples/spend-a-credit.md`; repeatable API-key style spend (one wallet signature, then plain OpenAI calls): `docs/examples/api-key-spend.md`.

## Operator track — sell your spare capacity

The general Tangle operator path (host requirements, stake, on-chain registration, discovery) is documented at https://router.tangle.tools/for-operators.md — follow it for the host and registration mechanics. The bazaar-specific differences, all from `docs/OPERATOR_ONBOARDING.md` in the repo:

1. **You are a bonded issuer, not just a server.** A credit lot can only mint if your on-chain collateral covers it — the contract enforces `collateral(you) ≥ 1.05 × liability` on every fill. Post a bond: `approve` pathUSD to the settlement contract, then `depositCollateral(uint256)`. Your sellable headroom is `freeCollateral(you)`; the venue refuses to quote past it.
2. **You must serve the model you sell.** Point the operator at a backend you run: `INFERENCE_BAZAAR_VLLM_MODEL` (managed vLLM) or `INFERENCE_BAZAAR_INFERENCE_URL` (+ `INFERENCE_BAZAAR_INFERENCE_API_KEY`) for any OpenAI-compatible endpoint. Router-proxy mode is **refused** for a bonded issuer — a lot must be backed by inference you actually run.
3. **Pricing is delegated to the mm-sidecar** (`pnpm --filter @inference-bazaar/mm-sidecar start`); the operator will not quote without one.
4. **Two keys, kept separate:** `INFERENCE_BAZAAR_OPERATOR_KEY` (attester/signing key — its address must be in the book's attester set) and `INFERENCE_BAZAAR_SUBMITTER_KEY` (pays gas, sends txs). Never let the signing key touch the RPC/nonce path in production.
5. **Production lifecycle is the Blueprint Manager daemon**: you register, a user requests a service, governance approves, and the manager spawns your operator instance. Never hand-run the instance binary with a hardcoded service id or test mode in production.
6. **Batch settlement is M-of-N per book.** Epoch fills settle attested (the book's quorum re-runs the match and co-signs; two-stage finality recovers a crashed proposer's batch) or proven (an SP1 proof runs the match in-circuit). An independent quorum member that never issues sets `INFERENCE_BAZAAR_ATTESTER_ONLY=1`.

Try the chainless lite venue first (`cargo run -p inference-bazaar-operator --bin inference-bazaar-operator-lite` boots on `127.0.0.1:9100`; hit `GET /health`, `GET /instruments`, `POST /book`) before touching keys or money. Scripted mechanical steps: `deploy/onboard-operator.sh`.

## Common errors

| Symptom | Cause | Fix |
| --- | --- | --- |
| `InsufficientBalance(available, required)` on settle | Your `balances(you)` is below the fill cost. | Deposit more (step 2) or trade smaller. |
| `OrderExpired` / venue `order expired` | The quote's `validUntil` passed, or your taker `expiry` is in the past. | Re-request the RFQ and set `expiry` a few minutes out. |
| `BadSignature` / venue `bad order signature` | Wrong EIP-712 domain, field order, or the signed fields don't match the posted order. | Domain is exactly `InferenceBazaarSettlement`/`1`/`42431`/`0x83084C8c…`; post byte-identical fields to what you signed. |
| `PriceOutsideLimits` | Execution price is above your buy limit or below the maker's sell limit. | Set your `priceMicroPerM` equal to the quote's. |
| `Overfill` | Cumulative fills exceed an order's `qtyTokens`. | Lower `qtyTokens` or sign a fresh order. |
| Venue `insufficient on-chain funding to back this quote` | The operator's `freeCollateral` is below the quote notional. | Trade smaller, or take another venue's quote. |
| Venue `{"quoting":false,…}` | The operator's risk gate is closed (kill switch, drawdown) or it has no reference price. | Try another venue or later; venues quote again on the next tick. |
| Venue 404 on `/rfq` | The venue doesn't list that instrument. | `GET /instruments` and use an id exactly, or `POST /market-requests {"model","kind"}` to signal demand. |
| `RedemptionAlreadyOpen` | The lot already has an open redemption. | Settle or finish the open one first (`openRedemptionOf(lotId)`). |
| `LotQtyUnavailable` | You requested more than the lot's remaining unlocked quota. | Check `lots(lotId)` and request ≤ `qtyTokens - lockedTokens`. |
| `/redeem` rejects your auth | The `messages` bytes don't match the signed `messagesHash`, or `expiry` passed. | Hash exactly the bytes you POST; sign a fresh `ServeRequest`. |
| Issuer missed the serve deadline | — | `claimDefault(redemptionId)` pays you the lot's paid value plus the penalty from the issuer's collateral; `reclaimExpired(lotId)` refunds an expired lot. |
| Operator panic: `bonded issuer must serve its own model … router-proxy mode is forbidden` | You configured signing/CLOB but no inference backend. | Set `INFERENCE_BAZAAR_VLLM_MODEL` or `INFERENCE_BAZAAR_INFERENCE_URL` (or `INFERENCE_BAZAAR_ATTESTER_ONLY=1` if you only co-sign). |
| Operator `sidecar error` on every quote | The mm-sidecar isn't running or `INFERENCE_BAZAAR_SIDECAR_URL` is wrong. | Start the sidecar (operator track, step 3). |

## Key and secret hygiene

- Store keys in files with mode 600 or a keystore; never print, log, paste, or commit them. Add key files to `.gitignore`.
- Every signed artifact here is scoped by construction: an `Order` dies at its `expiry`; a `ServeRequest` authorizes exactly one redemption's messages hash with a token cap; a `SpendPermit` delegates a capped, expiring, revocable session key whose entire blast radius is one lot. Sign only what you intend, keep amounts small and expiries short, and treat any signed payload as bearer money until it expires — never put one in logs or shared memory.
- A leaked spend key is killed on-chain with `revokeSpendKey(permit)`; served-but-unsettled usage after revocation is the issuer's loss, not yours.
- Operators: keep the attester key and the submitter key separate (operator track, step 4).

## Next

- [Manifest](https://bazaar.tangle.tools/.well-known/tangle-agent.json) and [llms.txt](https://bazaar.tangle.tools/llms.txt)
- [Market UI](https://inference-bazaar.blueprint.tangle.tools/) — books, buy flow, portfolio
- Repo: [README](https://github.com/tangle-network/inference-bazaar) · [Operator onboarding](https://github.com/tangle-network/inference-bazaar/blob/main/docs/OPERATOR_ONBOARDING.md) · [Testnet release + trust model](https://github.com/tangle-network/inference-bazaar/blob/main/docs/testnet-release.md)
- [Tangle Router crypto-native lane](https://router.tangle.tools/for-agents-crypto.md) — the same payment pattern for pay-as-you-go router inference
