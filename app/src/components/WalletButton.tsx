/**
 * Real wallet button — the arena's pattern: ConnectKitButton.Custom render
 * prop, blo Identicon avatar, dropdown with balance, chain state, copy,
 * explorer link, and disconnect. Wrong-chain shows an amber pulse and a
 * one-click switch to Base Sepolia.
 */
import { useEffect, useRef, useState } from 'react'
import { ConnectKitButton } from 'connectkit'
import { useAccount, useBalance, useDisconnect, useSwitchChain } from 'wagmi'
import { Identicon } from '@tangle-network/blueprint-ui/components'
import type { Address } from 'viem'
import { cn } from '~/lib/cn'
import { INFERENCE_BAZAAR_CHAIN } from '~/providers/web3'

function truncate(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

export function WalletButton({
  variant = 'header',
  collapsed = false,
}: {
  /** 'header' = compact pill, menu opens down-right. 'sidebar' = bottom dock,
   * menu opens up (full-width row, or avatar-only when `collapsed`). */
  variant?: 'header' | 'sidebar'
  collapsed?: boolean
} = {}) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const { address, chainId, isConnected, status } = useAccount()
  const { disconnect } = useDisconnect()
  const { switchChain } = useSwitchChain()
  const { data: balance } = useBalance({ address, chainId: INFERENCE_BAZAAR_CHAIN.id })

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const wrongChain = isConnected && chainId !== INFERENCE_BAZAAR_CHAIN.id
  const sidebar = variant === 'sidebar'
  const bal = balance
    ? `${(Number(balance.value) / 10 ** balance.decimals).toFixed(3)} ${balance.symbol}`
    : null

  return (
    <ConnectKitButton.Custom>
      {({ show }) => {
        if (!isConnected || !address) {
          if (sidebar) {
            return collapsed ? (
              <button
                onClick={show}
                title="Connect wallet"
                className="btn-primary mx-auto flex h-10 w-11 items-center justify-center p-0"
              >
                <span className="i-ph:wallet text-[18px]" />
              </button>
            ) : (
              <button onClick={show} className="btn-primary h-10 w-full" disabled={status === 'reconnecting'}>
                <span className="i-ph:wallet text-[18px]" />
                {status === 'reconnecting' ? 'Reconnecting…' : 'Connect wallet'}
              </button>
            )
          }
          return (
            <button
              onClick={show}
              className="btn-primary h-10 w-10 !px-0 sm:w-auto sm:!px-4"
              disabled={status === 'reconnecting'}
              title="Connect wallet"
            >
              <span className="i-ph:wallet text-[18px]" />
              <span className="hidden sm:inline">{status === 'reconnecting' ? 'Reconnecting…' : 'Connect'}</span>
            </button>
          )
        }
        return (
          <div ref={menuRef} className="relative">
            {sidebar && collapsed ? (
              <button
                onClick={() => setOpen((v) => !v)}
                title={truncate(address)}
                className="relative mx-auto flex h-10 w-11 items-center justify-center rounded-[8px] border border-[var(--s-border)] bg-[var(--s-panel)] transition-colors hover:border-[var(--s-accent)]/40"
              >
                <span className="overflow-hidden rounded-full ring-1 ring-[var(--s-border)]">
                  <Identicon address={address as Address} size={26} />
                </span>
                <span
                  className={cn(
                    'absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full ring-2 ring-[var(--s-surface)]',
                    wrongChain ? 'bg-[var(--s-amber)] animate-pulse' : 'bg-[var(--s-emerald)]',
                  )}
                />
              </button>
            ) : sidebar ? (
              <button
                onClick={() => setOpen((v) => !v)}
                className="flex w-full items-center gap-2.5 rounded-[8px] border border-[var(--s-border)] bg-[var(--s-panel)] px-2.5 py-2 text-left transition-colors hover:border-[var(--s-accent)]/40"
              >
                <span className="overflow-hidden rounded-full ring-1 ring-[var(--s-border)]">
                  <Identicon address={address as Address} size={30} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-data text-[15px] font-semibold text-[var(--s-text)]">
                    {truncate(address)}
                  </div>
                  <div className="truncate font-data text-[12px] text-[var(--s-text-muted)]">
                    {bal ?? INFERENCE_BAZAAR_CHAIN.name}
                  </div>
                </div>
                <span
                  className={cn(
                    'h-2 w-2 shrink-0 rounded-full',
                    wrongChain ? 'bg-[var(--s-amber)] animate-pulse' : 'bg-[var(--s-emerald)]',
                  )}
                />
              </button>
            ) : (
              <button
                onClick={() => setOpen((v) => !v)}
                className="relative flex h-10 items-center gap-2.5 rounded-[8px] border border-[var(--s-border)] bg-[var(--s-glass)] pl-1.5 pr-3 backdrop-blur-[8px] transition-colors hover:border-[var(--s-accent)]/40"
              >
                <span className="overflow-hidden rounded-full ring-1 ring-[var(--s-border)]">
                  <Identicon address={address as Address} size={28} />
                </span>
                <span className="hidden font-data text-[15px] font-semibold text-[var(--s-text)] sm:inline">
                  {truncate(address)}
                </span>
                {wrongChain ? (
                  <span className="h-2 w-2 animate-pulse rounded-full bg-[var(--s-amber)]" title="Wrong network" />
                ) : (
                  <span className="h-2 w-2 rounded-full bg-[var(--s-emerald)]" />
                )}
              </button>
            )}

            {open && (
              <div
                className={cn(
                  // SOLID, opaque, elevated menu — never see-through, always above
                  // page content (z-60). Opens upward in the sidebar dock.
                  'absolute z-[60] w-72 rounded-[10px] border border-[var(--s-border)] bg-[var(--s-pop)] p-4 shadow-[var(--s-shadow-pop)]',
                  sidebar ? 'bottom-full left-0 mb-2' : 'right-0 top-full mt-2',
                )}
              >
                <div className="flex items-center gap-3">
                  <span className="overflow-hidden rounded-full ring-1 ring-[var(--s-border)]">
                    <Identicon address={address as Address} size={36} />
                  </span>
                  <div className="min-w-0">
                    <div className="font-data text-[15px] font-semibold text-[var(--s-text)]">
                      {truncate(address)}
                    </div>
                    <div className="font-data text-[15px] text-[var(--s-text-muted)]">
                      {balance
                        ? `${(Number(balance.value) / 10 ** balance.decimals).toFixed(4)} ${balance.symbol}`
                        : '—'}{' '}
                      · {INFERENCE_BAZAAR_CHAIN.name}
                    </div>
                  </div>
                </div>

                <div className="mt-3 flex items-center gap-2 rounded-[8px] border border-[var(--s-border)] px-2.5 py-2">
                  <span
                    className={cn(
                      'h-2 w-2 rounded-full',
                      wrongChain ? 'bg-[var(--s-amber)] animate-pulse' : 'bg-[var(--s-emerald)]',
                    )}
                  />
                  <span className="font-data text-[15px] text-[var(--s-text-secondary)]">
                    {wrongChain ? `Wrong network (chain ${chainId})` : `Connected to ${INFERENCE_BAZAAR_CHAIN.name}`}
                  </span>
                </div>

                <div className="mt-3 grid gap-1.5">
                  {wrongChain && (
                    <button
                      onClick={() => switchChain({ chainId: INFERENCE_BAZAAR_CHAIN.id })}
                      className="btn-primary h-9 w-full"
                    >
                      <span className="i-ph:plugs-connected text-[15px]" />
                      Switch to {INFERENCE_BAZAAR_CHAIN.name}
                    </button>
                  )}
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(address)
                      setCopied(true)
                      setTimeout(() => setCopied(false), 1200)
                    }}
                    className="btn-secondary h-9 w-full"
                  >
                    <span className={cn(copied ? 'i-ph:check' : 'i-ph:link-simple', 'text-[15px]')} />
                    {copied ? 'Copied' : 'Copy address'}
                  </button>
                  <a
                    href={`${INFERENCE_BAZAAR_CHAIN.blockExplorers.default.url}/address/${address}`}
                    target="_blank"
                    rel="noreferrer"
                    className="btn-secondary h-9 w-full"
                  >
                    <span className="i-ph:arrow-up-right text-[15px]" />
                    View on explorer
                  </a>
                  <button
                    onClick={() => {
                      disconnect()
                      setOpen(false)
                    }}
                    className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-[8px] border border-[var(--s-crimson)]/25 bg-[var(--s-crimson-soft)] font-data text-[15px] font-semibold uppercase tracking-wide text-[var(--s-crimson)] transition-colors hover:bg-[var(--s-crimson)]/20"
                  >
                    <span className="i-ph:x text-[15px]" />
                    Disconnect
                  </button>
                </div>
              </div>
            )}
          </div>
        )
      }}
    </ConnectKitButton.Custom>
  )
}
