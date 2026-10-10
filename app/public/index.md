# Inference Bazaar

Inference Bazaar is an open market for AI inference. Buyers purchase prepaid, collateral-backed inference-token credit lots below list price; operators sell spare inference capacity; market-makers work the spread. Fills settle atomically on the InferenceBazaarSettlement contract on Tempo testnet (chainId 42431) — payment, seller payout, and credit mint in one transaction. Every lot is a claim on a bonded issuer whose on-chain collateral covers its refund value plus a default penalty.

## Use it when

- You want to buy inference at market prices without a platform account — an Ethereum-style key is your identity, and you pay the signed strike, never list price.
- You operate a host with spare inference capacity and want to sell it as collateral-backed credit.
- You want settlement guarantees enforced by a contract: atomic fills, a serve deadline, and refunds with penalty on issuer default.

## Hand this to your agent

An AI agent can set Inference Bazaar up by itself — as a buyer or as an operator: fetch https://bazaar.tangle.tools/agent-setup.md and follow it. There is no signup or account approval; the agent funds a Tempo testnet key and every step after that is contract calls and signed messages. A human is needed only to fund or hand over a key.

## Pricing

There is no list price on the bazaar: every trade clears at a signed firm quote (micro-pathUSD per 1M tokens), requested free and credential-free from any operator venue (`POST /rfq`). No-credential reference prices (router list, the baseline the market discounts against): https://router.tangle.tools/v1/models

## Machine-readable surfaces

- https://bazaar.tangle.tools/llms.txt
- https://bazaar.tangle.tools/.well-known/tangle-agent.json
- https://bazaar.tangle.tools/agent-setup.md
- Repository: https://github.com/tangle-network/inference-bazaar
