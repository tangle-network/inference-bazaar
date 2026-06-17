const PREFIX = 'inference-bazaar:cache:v1:'

interface CacheEntry<T> {
  savedAt: number
  value: T
}

function storage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function cacheKey(...parts: Array<string | number | boolean | null | undefined>): string {
  return parts.map((part) => encodeURIComponent(String(part ?? ''))).join(':')
}

export function readBrowserCache<TStored, TValue = TStored>(
  key: string,
  options: {
    maxAgeMs?: number
    revive?: (value: TStored) => TValue
  } = {},
): TValue | undefined {
  const s = storage()
  if (!s) return undefined
  try {
    const raw = s.getItem(`${PREFIX}${key}`)
    if (!raw) return undefined
    const entry = JSON.parse(raw) as CacheEntry<TStored>
    if (!entry || typeof entry.savedAt !== 'number') return undefined
    if (options.maxAgeMs !== undefined && Date.now() - entry.savedAt > options.maxAgeMs) return undefined
    return options.revive ? options.revive(entry.value) : (entry.value as unknown as TValue)
  } catch {
    return undefined
  }
}

export function writeBrowserCache<TValue, TStored = TValue>(
  key: string,
  value: TValue,
  options: {
    serialize?: (value: TValue) => TStored
  } = {},
): void {
  const s = storage()
  if (!s) return
  try {
    const entry: CacheEntry<TStored> = {
      savedAt: Date.now(),
      value: options.serialize ? options.serialize(value) : (value as unknown as TStored),
    }
    s.setItem(`${PREFIX}${key}`, JSON.stringify(entry))
  } catch {
    // localStorage quota/privacy failures should never break live reads.
  }
}
