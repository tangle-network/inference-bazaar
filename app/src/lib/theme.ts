import { useSyncExternalStore } from 'react'

type Theme = 'light' | 'dark'
const KEY = 'inference_bazaar_theme'
const listeners = new Set<() => void>()

function current(): Theme {
  if (typeof document === 'undefined') return 'dark'
  const theme = document.documentElement.getAttribute('data-theme')
  return theme === 'light' || theme === 'aubergine-light' ? 'light' : 'dark'
}

export function toggleTheme() {
  const next: Theme = current() === 'dark' ? 'light' : 'dark'
  document.documentElement.setAttribute('data-theme', next === 'light' ? 'aubergine-light' : 'aubergine')
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
