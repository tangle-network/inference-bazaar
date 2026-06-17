import { type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { EIP712_DOMAIN, SPEND_VOUCHER_TYPES } from './settlement'

const STORE_KEY = 'inference-bazaar:spend-keys:v1'
const ACTIVE_KEY = 'inference-bazaar:active-spend-key:v1'

export const SPEND_KEY_EVENT = 'inference-bazaar:spend-key'

export interface StoredSpendKey {
  id: string
  lotId: Hex
  sessionPriv: Hex
  sessionKey: Address
  venueUrl: string
  model: string
  instrumentId: string
  maxTokens: number
  expiry: number
  ackedTokens: number
  createdAt: number
}

function storage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function emitSpendKeyChange(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(SPEND_KEY_EVENT))
}

function cleanVenueUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

function isStoredSpendKey(value: unknown): value is StoredSpendKey {
  const key = value as Partial<StoredSpendKey> | null
  return (
    !!key &&
    typeof key.id === 'string' &&
    typeof key.lotId === 'string' &&
    typeof key.sessionPriv === 'string' &&
    typeof key.sessionKey === 'string' &&
    typeof key.venueUrl === 'string' &&
    typeof key.model === 'string' &&
    typeof key.instrumentId === 'string' &&
    typeof key.maxTokens === 'number' &&
    typeof key.expiry === 'number' &&
    typeof key.ackedTokens === 'number' &&
    typeof key.createdAt === 'number'
  )
}

export function spendKeyId(lotId: Hex, sessionKey: Address): string {
  return `${lotId}:${sessionKey.toLowerCase()}`
}

export function listSpendKeys(): StoredSpendKey[] {
  const s = storage()
  if (!s) return []
  try {
    const parsed = JSON.parse(s.getItem(STORE_KEY) ?? '[]') as unknown
    return Array.isArray(parsed)
      ? parsed.filter(isStoredSpendKey).sort((a, b) => b.createdAt - a.createdAt)
      : []
  } catch {
    return []
  }
}

function writeSpendKeys(keys: StoredSpendKey[]): void {
  const s = storage()
  if (!s) return
  try {
    s.setItem(STORE_KEY, JSON.stringify(keys))
  } catch {
    // A failed local write should not break key creation; the key is still shown.
  }
}

export function isSpendKeyUsable(key: StoredSpendKey, now = Date.now()): boolean {
  return key.expiry * 1000 > now + 120_000 && key.ackedTokens < key.maxTokens
}

export function saveSpendKey(key: StoredSpendKey): StoredSpendKey {
  const normalized = { ...key, venueUrl: cleanVenueUrl(key.venueUrl) }
  const next = [normalized, ...listSpendKeys().filter((k) => k.id !== normalized.id)]
  writeSpendKeys(next)
  setActiveSpendKey(normalized.id)
  return normalized
}

export function updateSpendKey(id: string, patch: Partial<StoredSpendKey>): StoredSpendKey | null {
  let updated: StoredSpendKey | null = null
  const next = listSpendKeys().map((key) => {
    if (key.id !== id) return key
    updated = { ...key, ...patch, id: key.id }
    return updated
  })
  writeSpendKeys(next)
  emitSpendKeyChange()
  return updated
}

export function setActiveSpendKey(id: string): void {
  const s = storage()
  if (!s) return
  try {
    s.setItem(ACTIVE_KEY, id)
  } catch {
    // Ignore private-mode/quota failures; the key list still holds the value.
  }
  emitSpendKeyChange()
}

export function getActiveSpendKey(): StoredSpendKey | null {
  const keys = listSpendKeys()
  if (keys.length === 0) return null
  const s = storage()
  const activeId = s?.getItem(ACTIVE_KEY) ?? null
  const active = activeId ? keys.find((key) => key.id === activeId) : null
  if (active && isSpendKeyUsable(active)) return active
  return keys.find((key) => isSpendKeyUsable(key)) ?? null
}

export function spendKeyLabel(key: StoredSpendKey): string {
  return `${key.sessionKey.slice(0, 6)}...${key.sessionKey.slice(-4)}`
}

export async function spendVoucherHeaders(
  key: StoredSpendKey,
  servedCumulative: number,
): Promise<Record<string, string>> {
  const account = privateKeyToAccount(key.sessionPriv)
  const cumulative = Math.max(0, Math.floor(servedCumulative))
  const signature = await account.signTypedData({
    domain: EIP712_DOMAIN,
    types: SPEND_VOUCHER_TYPES,
    primaryType: 'SpendVoucher',
    message: {
      lotId: key.lotId,
      sessionKey: key.sessionKey,
      servedCumulative: BigInt(cumulative),
    },
  })
  return {
    'x-inference-bazaar-session': key.sessionKey,
    'x-inference-bazaar-voucher-cum': String(cumulative),
    'x-inference-bazaar-voucher-sig': signature,
  }
}
