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
import { SURPLUS_CHAIN } from '~/providers/web3'

function truncate(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

export function WalletButton() {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const { address, chainId, isConnected, status } = useAccount()
  const { disconnect } = useDisconnect()
  const { switchChain } = useSwitchChain()
  const { data: balance } = useBalance({ address, chainId: SURPLUS_CHAIN.id })

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const wrongChain = isConnected && chainId !== SURPLUS_CHAIN.id

  return (
    <ConnectKitButton.Custom>
      {({ show }) => {
        if (!isConnected || !address) {
          return (
            <button onClick={show} className="btn-primary h-10" disabled={status === 'reconnecting'}>
              <span className="i-ph:wallet text-[16px]" />
              {status === 'reconnecting' ? 'Reconnecting…' : 'Connect'}
            </button>
          )
        }
        return (
          <div ref={menuRef} className="relative">
            <button
              onClick={() => setOpen((v) => !v)}
              className="relative flex h-10 items-center gap-2.5 rounded-[8px] border border-[var(--s-border)] bg-[var(--s-glass)] pl-1.5 pr-3 backdrop-blur-[8px] transition-colors hover:border-[var(--s-accent)]/40"
            >
              <span className="overflow-hidden rounded-full ring-1 ring-[var(--s-border)]">
                <Identicon address={address as Address} size={28} />
              </span>
              <span className="hidden font-data text-[13px] font-semibold text-[var(--s-text)] sm:inline">
                {truncate(address)}
              </span>
              {wrongChain ? (
                <span className="h-2 w-2 animate-pulse rounded-full bg-[var(--s-amber)]" title="Wrong network" />
              ) : (
                <span className="h-2 w-2 rounded-full bg-[var(--s-emerald)]" />
              )}
            </button>

            {open && (
              <div className="panel-strong absolute right-0 top-full z-50 mt-2 w-76 p-4 shadow-[var(--s-shadow-pop)]">
                <div className="flex items-center gap-3">
                  <span className="overflow-hidden rounded-full ring-1 ring-[var(--s-border)]">
                    <Identicon address={address as Address} size={36} />
                  </span>
                  <div className="min-w-0">
                    <div className="font-data text-[14px] font-semibold text-[var(--s-text)]">
                      {truncate(address)}
                    </div>
                    <div className="font-data text-[12px] text-[var(--s-text-muted)]">
                      {balance
                        ? `${(Number(balance.value) / 10 ** balance.decimals).toFixed(4)} ${balance.symbol}`
                        : '—'}{' '}
                      · {SURPLUS_CHAIN.name}
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
                  <span className="font-data text-[12px] text-[var(--s-text-secondary)]">
                    {wrongChain ? `Wrong network (chain ${chainId})` : `Connected to ${SURPLUS_CHAIN.name}`}
                  </span>
                </div>

                <div className="mt-3 grid gap-1.5">
                  {wrongChain && (
                    <button
                      onClick={() => switchChain({ chainId: SURPLUS_CHAIN.id })}
                      className="btn-primary h-9 w-full"
                    >
                      <span className="i-ph:plugs-connected text-[15px]" />
                      Switch to {SURPLUS_CHAIN.name}
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
                    href={`${SURPLUS_CHAIN.blockExplorers.default.url}/address/${address}`}
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
                    className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-[8px] border border-[var(--s-crimson)]/25 bg-[var(--s-crimson-soft)] font-data text-[13px] font-semibold uppercase tracking-wide text-[var(--s-crimson)] transition-colors hover:bg-[var(--s-crimson)]/20"
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
