import { useSyncExternalStore } from 'react'

type Theme = 'light' | 'dark'
const KEY = 'surplus_theme'
const listeners = new Set<() => void>()

function current(): Theme {
  if (typeof document === 'undefined') return 'dark'
  return (document.documentElement.getAttribute('data-theme') as Theme) ?? 'dark'
}

export function toggleTheme() {
  const next: Theme = current() === 'dark' ? 'light' : 'dark'
  document.documentElement.setAttribute('data-theme', next)
  try {
    localStorage.setItem(KEY, next)
  } catch {
    // sandboxed iframe — ignore
  }
  listeners.forEach((l) => l())
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    current,
    () => 'dark',
  )
}
