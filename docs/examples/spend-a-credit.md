# Spend a credit — the full loop with curl + cast

This is the live deployment, end to end: buy discounted inference on the open
market, then spend it on a real completion through the Tangle Router, with
every step settling on Base Sepolia. Run it as written; every address below
is live.

```
Settlement   0x64867eacf2e4581d182c2Be634cfD7fF3D3d9f83   (SurplusSettlement, Base Sepolia — tsUSD rail)
tsUSD        0x14Ff9231D03Fd9AD75e553004585f13Ff51db630   (test payment token, open mint)
Venue 1      https://surplus.178.104.232.124.sslip.io      (operator 0x483f…, 12% policy)
Venue 2      https://surplus2.178.104.232.124.sslip.io     (operator 0x2420…, 9% policy)
App          https://inference-bazaar.blueprint.tangle.tools

REAL-MONEY RAIL (same contract, real Circle USDC — no mint; bring USDC):
Settlement   0xf6A64921b62E09c9646675BEe6A11Fcd533d6783   (SurplusSettlement, Base Sepolia)
USDC         0x036CbD53842c5426634e7929541eC2318f3dCF7e   (canonical Circle testnet USDC)
Venue        https://surplus-usdc.178.104.232.124.sslip.io
Live proof   fill 0x5faa5019… (20k tokens = 0.27092 USDC) → redemption
             0xbbf7c74e… (32 metered tokens debited at the locked strike)
```

Every step below works identically on either rail — swap `$SET`, the token
address, and the venue URL (skip `mint` on USDC; fund from a faucet).

You need: a key with a little Base Sepolia ETH for gas. `export KEY=0x…`,
`export ME=$(cast wallet address $KEY)`, `RPC=https://sepolia.base.org`.

## 1. Fund your settlement balance

```bash
USD=0x14Ff9231D03Fd9AD75e553004585f13Ff51db630
SET=0x64867eacf2e4581d182c2Be634cfD7fF3D3d9f83
cast send $USD "mint(address,uint256)" $ME 20000000      --rpc-url $RPC --private-key $KEY  # $20 test tsUSD
cast send $USD "approve(address,uint256)" $SET 20000000  --rpc-url $RPC --private-key $KEY
cast send $SET "deposit(uint256)" 20000000               --rpc-url $RPC --private-key $KEY
```

## 2. Get a firm quote (RFQ — the operator signs it)

```bash
curl -s https://surplus.178.104.232.124.sslip.io/rfq \
  -H 'content-type: application/json' \
  -d '{"instrumentId":"claude-sonnet-4-6:output","side":"buy","qtyTokens":1000000}'
```

The response is an EIP-712 **signed order** from the operator: price locked
(e.g. `13246000` = $13.25/M vs the router's $15.00 list), `validUntil` TTL,
operator signature. Query both venues and take the better price — that's the
whole market in two curls.

## 3. Sign the matching order and settle

Sign an `Order` (same fields, `side: 0`, your address as `trader`, fresh
`salt`) against the domain `SurplusSettlement / 1 / 84532 / 0x3fa62248…`,
POST both orders to `/rfq/fill`, then `/settlement/flush`. The easiest path
is the runnable script (uses viem):

```bash
cd app && FUNDER_KEY=$KEY node ../scripts/e2e-firm-buy.mjs
```

Output ends with the `settleFills` transaction and your **credit lot id**:
your deposited tsUSD paid the issuer (minus the 2% protocol fee) and a
collateral-backed lot was minted to you, atomically.
Example live proof: [`0x15a70fa6…`](https://sepolia.basescan.org/tx/0x15a70fa6f06798496dbfbbfd3155ec0524f860683fd12593b5d2d4903c256082).

## 4. Spend the credit on real inference

Open a redemption on your lot (locks quota, starts the issuer's serve
deadline — miss it and `claimDefault` pays you from their collateral):

```bash
LOT=0x…   # from step 3
cast send $SET "requestRedemption(bytes32,uint64)" $LOT 50000 --rpc-url $RPC --private-key $KEY
RID=$(cast call $SET "openRedemptionOf(bytes32)(bytes32)" $LOT --rpc-url $RPC)
```

Now ask the issuing operator to serve — this is a **real completion through
the Tangle Router**, metered against your quota at the locked price. Serving
is holder-gated: you sign an EIP-712 `ServeRequest` (domain `SurplusServe/1`,
bound to the settlement contract) over the redemption id, the exact messages
bytes, the token cap, and an expiry — so nobody who merely *sees* your
redemptionId on-chain can burn your quota or read your completions:

```bash
MSGS='[{"role":"user","content":"Say hello"}]'
MAX=100
EXP=$(($(date +%s) + 300))
SIG=$(cast wallet sign --private-key $KEY --data "{
  \"domain\": {\"name\":\"SurplusServe\",\"version\":\"1\",\"chainId\":84532,\"verifyingContract\":\"$SET\"},
  \"types\": {\"ServeRequest\":[
    {\"name\":\"redemptionId\",\"type\":\"bytes32\"},
    {\"name\":\"messagesHash\",\"type\":\"bytes32\"},
    {\"name\":\"maxTokens\",\"type\":\"uint64\"},
    {\"name\":\"expiry\",\"type\":\"uint64\"}]},
  \"primaryType\": \"ServeRequest\",
  \"message\": {
    \"redemptionId\": \"$RID\",
    \"messagesHash\": \"$(cast keccak "$MSGS")\",
    \"maxTokens\": $MAX,
    \"expiry\": $EXP }
}")

curl -s https://surplus.178.104.232.124.sslip.io/redeem \
  -H 'content-type: application/json' \
  -d "{\"redemptionId\":\"$RID\",\"messages\":$MSGS,\"maxTokens\":$MAX,\"auth\":{\"expiry\":$EXP,\"signature\":\"$SIG\"}}"
```

(The `messages` bytes in the body must be exactly the bytes you hashed —
keep `$MSGS` verbatim in both places. The Portfolio page does this whole
flow with two wallet signatures, no terminal needed.)

The response contains the completion, `servedTokens` (metered usage of your
lot's token kind), and `receiptDigest`. Acknowledge service by signing the
digest and let the operator settle:

```bash
RSIG=$(cast wallet sign --private-key $KEY --data "{
  \"domain\": {\"name\":\"SurplusSettlement\",\"version\":\"1\",\"chainId\":84532,\"verifyingContract\":\"$SET\"},
  \"types\": {\"RedemptionReceipt\":[
    {\"name\":\"redemptionId\",\"type\":\"bytes32\"},
    {\"name\":\"servedTokens\",\"type\":\"uint64\"}]},
  \"primaryType\": \"RedemptionReceipt\",
  \"message\": {\"redemptionId\": \"$RID\", \"servedTokens\": $SERVED}
}")
curl -s https://surplus.178.104.232.124.sslip.io/redeem/receipt \
  -H 'content-type: application/json' \
  -d "{\"redemptionId\":\"$RID\",\"servedTokens\":$SERVED,\"signature\":\"$RSIG\"}"
```

Verify the debit on-chain — quota down by exactly the served tokens, notional
released at your locked strike:

```bash
cast call $SET "lots(bytes32)(address,address,bytes32,uint64,uint64,uint64,uint128)" $LOT --rpc-url $RPC
```

Or run the whole step as one script:

```bash
cd app && BUYER_KEY=$KEY LOT_ID=$LOT node ../scripts/e2e-redeem.mjs
```

## What you just proved

- **Supply is real**: the lot could only exist because the issuer's on-chain
  collateral covers it (`collateral(issuer)` ≥ liability × 1.05, contract-enforced).
- **The discount is real**: you paid the signed strike, not the router list.
- **Consumption is real**: the completion came from the Tangle Router; the
  metered tokens debited your quota at the locked price, on-chain.
- **The guarantee is real**: an unserved redemption past its deadline pays
  you from issuer collateral, with penalty (`claimDefault`).

## SDK note

The same flow from TypeScript: `viem` for the wallet ops (both scripts in
`scripts/` are the reference), and the tcloud SDK exposes the buyer surface as
`ChatOptions.pricing` (market/limit + credits) — see tangle-network/tcloud#41.
