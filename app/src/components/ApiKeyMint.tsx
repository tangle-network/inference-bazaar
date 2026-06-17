import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useSignTypedData } from 'wagmi'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { CHAIN } from '~/lib/api'
import {
  EIP712_DOMAIN,
  SETTLEMENT,
  SPEND_PERMIT_TYPES,
  type CreditLot,
} from '~/lib/settlement'
import { saveSpendKey, spendKeyId, type StoredSpendKey } from '~/lib/spend-key'

/**
 * The headline consumption path (spend channel — see docs/specs/spend-rail.md).
 * ONE wallet signature delegates a fresh **session key** to draw down this lot.
 * The session key drives the inference-bazaar gateway, which signs per-request
 * vouchers invisibly — so it's a vanilla OpenAI client (base_url + api_key), no
 * wallet in the request path, and the operator can NEVER bill more than the
 * gateway signs. The session key is shown once; run the gateway with it
 * (locally for zero trust).
 */
export function ApiKeyMint({ lot, venueUrl }: { lot: CreditLot; venueUrl: string }) {
  const { signTypedDataAsync } = useSignTypedData()
  const [minted, setMinted] = useState<{ sessionPriv: string; key: StoredSpendKey } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  async function mint() {
    setBusy(true)
    setError(null)
    try {
      // Fresh ephemeral session keypair — capped, expiring, revocable; its whole
      // blast radius is this one lot. The gateway holds it; the wallet signs once.
      const sessionPriv = generatePrivateKey()
      const sessionKey = privateKeyToAccount(sessionPriv).address
      const maxTokens = BigInt(lot.qtyTokens - lot.lockedTokens)
      const expiry = BigInt(Math.min(Number(lot.expiry) - 300, Math.floor(Date.now() / 1000) + 30 * 86400))
      const holderSig = await signTypedDataAsync({
        domain: EIP712_DOMAIN,
        types: SPEND_PERMIT_TYPES,
        primaryType: 'SpendPermit',
        message: { lotId: lot.lotId, sessionKey, maxTokens, expiry },
      })
      const res = await fetch(`${venueUrl}/v1/spend-keys`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          lotId: lot.lotId,
          sessionKey,
          maxTokens: Number(maxTokens),
          expiry: Number(expiry),
          holderSig,
        }),
      })
      if (!res.ok) throw new Error(await res.text())
      const reg = (await res.json()) as {
        model?: string
        instrumentId?: string
        maxTokens?: number
        expiry?: number
      }
      const key = saveSpendKey({
        id: spendKeyId(lot.lotId, sessionKey),
        lotId: lot.lotId,
        sessionPriv,
        sessionKey,
        venueUrl,
        model: reg.model ?? '',
        instrumentId: reg.instrumentId ?? '',
        priceMicroPerM: Number(lot.filledTokens) > 0
          ? Math.round((Number(lot.notionalMicro) * 1_000_000) / Number(lot.filledTokens))
          : undefined,
        maxTokens: reg.maxTokens ?? Number(maxTokens),
        expiry: reg.expiry ?? Number(expiry),
        ackedTokens: 0,
        createdAt: Date.now(),
      })
      setMinted({ sessionPriv, key })
    } catch (e) {
      setError(e instanceof Error ? e.message.split('\n')[0]! : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (minted) {
    const run = [
      `INFERENCE_BAZAAR_SESSION_KEY=${minted.sessionPriv} \\`,
      `INFERENCE_BAZAAR_OPERATOR_URL=${venueUrl} \\`,
      `INFERENCE_BAZAAR_LOT_ID=${lot.lotId} \\`,
      `INFERENCE_BAZAAR_CHAIN_ID=${CHAIN.id} INFERENCE_BAZAAR_SETTLEMENT_ADDR=${SETTLEMENT.address} \\`,
      `inference-bazaar-gateway`,
    ].join('\n')
    const snippet = `client = OpenAI(base_url="http://127.0.0.1:8088/v1", api_key="sk-inference-bazaar")`
    const copyAll = `${run}\n\n# then:\n${snippet}`
    return (
      <div className="w-full rounded-[10px] border border-[var(--s-accent)]/30 bg-[var(--s-accent-soft)] px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="mono-label !text-[var(--s-accent)]">Loaded into chat</span>
          <div className="flex items-center gap-2">
            <Link to="/developer/chat" className="btn-primary h-8 whitespace-nowrap !px-3 !text-[13px]">
              <span className="i-ph:chat-circle-dots text-[15px]" /> Open chat
            </Link>
            <button
              onClick={() => { void navigator.clipboard.writeText(copyAll); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
              className="font-data text-[15px] font-semibold text-[var(--s-accent)] hover:underline"
            >
              {copied ? 'copied' : 'copy setup'}
            </button>
          </div>
        </div>
        <div className="mt-1 font-data text-[12px] text-[var(--s-text-muted)]">
          {minted.key.model || 'Model'} · stored locally for this browser
        </div>
        <div className="mt-2 font-data text-[15px] text-[var(--s-text-secondary)]">
          Run the gateway with your session key (locally = zero trust in us):
        </div>
        <div className="mt-1 overflow-x-auto whitespace-pre rounded-[6px] bg-[var(--s-bg)]/60 px-3 py-2 font-data text-[15px] text-[var(--s-text)]">
          {run}
        </div>
        <div className="mt-2 font-data text-[15px] text-[var(--s-text-secondary)]">
          Then point any OpenAI client at it — no wallet, no per-request signing:
        </div>
        <div className="mt-1 overflow-x-auto rounded-[6px] bg-[var(--s-bg)]/60 px-3 py-2 font-data text-[15px] text-[var(--s-text-muted)]">
          {snippet}
        </div>
        <div className="mt-2 font-data text-[12px] text-[var(--s-text-muted)]">
          The operator can never bill more than your gateway signs. Revoke anytime on-chain.
        </div>
      </div>
    )
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <button onClick={mint} disabled={busy} className="btn-primary h-9 whitespace-nowrap">
        {busy ? 'Sign in wallet…' : 'Create API key'}
      </button>
      {error && <span className="max-w-[260px] truncate font-data text-[12px] text-[var(--s-crimson)]" title={error}>{error}</span>}
    </div>
  )
}
