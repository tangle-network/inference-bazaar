/**
 * Chain switcher — the arena's NetworkButton pattern, scoped to the chains
 * InferenceBazaar actually runs on (INFERENCE_BAZAAR_CHAINS). Switches the connected wallet's
 * network; chains not yet live show disabled ("soon"). Menu is solid + opens
 * upward (it lives in the sidebar dock).
 */
import { useEffect, useRef, useState } from 'react'
import { useAccount, useSwitchChain } from 'wagmi'
import { cn } from '~/lib/cn'
import { INFERENCE_BAZAAR_CHAIN, INFERENCE_BAZAAR_CHAINS } from '~/providers/web3'

export function NetworkSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const { chainId, isConnected } = useAccount()
  const { switchChain } = useSwitchChain()

  // Active = the wallet's chain when connected, else the app's default chain.
  const activeId = chainId ?? INFERENCE_BAZAAR_CHAIN.id
  const active = INFERENCE_BAZAAR_CHAINS.find((c) => c.id === activeId) ??
    INFERENCE_BAZAAR_CHAINS[0] ?? { id: activeId, name: 'Network', short: 'Network', live: false }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Switch network"
        aria-expanded={open}
        title={collapsed ? `Network: ${active.name}` : undefined}
        className={cn(
          'flex h-10 items-center gap-2 rounded-[8px] border border-[var(--s-border)] bg-[var(--s-panel)] text-[var(--s-text-secondary)] transition-colors hover:border-[var(--s-border-hover)] hover:text-[var(--s-text)]',
          collapsed ? 'w-11 justify-center' : 'w-full px-2.5',
        )}
      >
        <span className="i-ph:globe-hemisphere-west shrink-0 text-[18px] text-[var(--s-text-muted)]" />
        {!collapsed && (
          <span className="min-w-0 flex-1 truncate text-left font-data text-[15px] font-medium">
            {active.short}
          </span>
        )}
        {!collapsed && <span className="i-ph:caret-down shrink-0 text-[14px] text-[var(--s-text-subtle)]" />}
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-[60] mb-2 w-56 rounded-[10px] border border-[var(--s-border)] bg-[var(--s-pop)] p-1.5 shadow-[var(--s-shadow-pop)]">
          <div className="mono-label px-2 py-1.5">Network</div>
          {INFERENCE_BAZAAR_CHAINS.map((c) => {
            const sel = c.id === activeId
            return (
              <button
                key={c.id}
                disabled={!c.live}
                onClick={() => {
                  if (!c.live) return
                  if (isConnected && c.id !== activeId) switchChain({ chainId: c.id })
                  setOpen(false)
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-[8px] px-2 py-2 text-left font-data text-[15px] transition-colors',
                  !c.live && 'cursor-not-allowed opacity-50',
                  sel
                    ? 'bg-[var(--s-accent-soft)] text-[var(--s-accent)]'
                    : c.live && 'text-[var(--s-text-secondary)] hover:bg-[var(--s-panel-strong)]',
                )}
              >
                <span
                  className={cn(
                    'h-2 w-2 shrink-0 rounded-full',
                    sel ? 'bg-[var(--s-accent)]' : 'bg-[var(--s-text-subtle)]',
                  )}
                />
                <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
                {!c.live && (
                  <span className="shrink-0 rounded-[5px] border border-[var(--s-border)] px-1.5 py-0.5 text-[12px] uppercase tracking-wide text-[var(--s-text-muted)]">
                    soon
                  </span>
                )}
                {sel && c.live && <span className="i-ph:check shrink-0 text-[15px]" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
