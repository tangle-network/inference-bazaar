import { useState, type ReactNode } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { cn } from '~/lib/cn'
import { toggleTheme, useTheme } from '~/lib/theme'
import { WalletButton } from '~/components/WalletButton'
import { CHAIN, useVenueHealth } from '~/lib/api'

/** Measured, not asserted: live venue health + latency. */
function VenueStatus() {
  const health = useVenueHealth()
  return (
    <a
      href={`${CHAIN.explorer}/address/${CHAIN.tangle}`}
      target="_blank"
      rel="noreferrer"
      className="hidden items-center gap-2 rounded-[8px] border border-[var(--s-border)] px-2.5 py-1.5 transition-colors hover:border-[var(--s-border-hover)] lg:flex"
      title="Surplus service 4 on Base Sepolia"
    >
      <span
        className={cn(
          'h-2 w-2 rounded-full',
          health.data?.ok ? 'bg-[var(--s-emerald)]' : health.isError ? 'bg-[var(--s-crimson)]' : 'bg-[var(--s-amber)] animate-pulse',
        )}
      />
      <span className="font-data text-[12px] tabular-nums text-[var(--s-text-muted)]">
        {health.data?.ok ? `venue ${health.data.latencyMs}ms` : health.isError ? 'venue down' : 'venue…'}
      </span>
    </a>
  )
}

const NAV = [
  { to: '/', label: 'Markets', icon: 'i-ph:chart-line-up', end: true },
  { to: '/buy', label: 'Buy', icon: 'i-ph:lightning' },
  { to: '/sell', label: 'Sell', icon: 'i-ph:storefront' },
  { to: '/operators', label: 'Operators', icon: 'i-ph:hard-drives' },
  { to: '/activity', label: 'Activity', icon: 'i-ph:pulse' },
  { to: '/portfolio', label: 'Portfolio', icon: 'i-ph:wallet' },
]

function BrandMark() {
  return (
    <div className="flex items-center gap-2.5">
      <div
        className="flex h-8 w-8 items-center justify-center rounded-[7px] font-display text-[18px] font-extrabold"
        style={{
          background: 'linear-gradient(140deg, var(--s-accent), var(--s-brand))',
          color: 'var(--s-accent-text)',
        }}
      >
        S
      </div>
      <div className="leading-none">
        <div className="font-display text-[15px] font-bold tracking-tight text-[var(--s-text)]">Surplus</div>
        <div className="mt-0.5 font-data text-[9px] uppercase tracking-[0.2em] text-[var(--s-text-muted)]">
          Inference Market
        </div>
      </div>
    </div>
  )
}

function ThemeButton() {
  const theme = useTheme()
  return (
    <button
      onClick={toggleTheme}
      className="flex h-9 w-9 items-center justify-center rounded-[6px] border border-[var(--s-border)] bg-[var(--s-panel)] text-[var(--s-text-muted)] transition-colors hover:border-[var(--s-border-hover)] hover:text-[var(--s-text)]"
      title="Toggle theme"
    >
      <span className={cn(theme === 'dark' ? 'i-ph:sun' : 'i-ph:moon', 'text-[16px]')} />
    </button>
  )
}

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col gap-0.5">
      {NAV.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              'group relative flex items-center gap-3 rounded-[8px] px-3 py-2.5 font-data text-[14px] font-medium transition-colors',
              isActive
                ? 'bg-[var(--s-accent-soft)] text-[var(--s-accent)]'
                : 'text-[var(--s-text-muted)] hover:bg-[var(--s-panel)] hover:text-[var(--s-text-secondary)]',
            )
          }
        >
          {({ isActive }) => (
            <>
              {isActive && (
                <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r bg-[var(--s-accent)]" />
              )}
              <span className={cn(item.icon, 'text-[19px]')} />
              {item.label}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  )
}

export function Shell({ children }: { children: ReactNode }) {
  const [mobileNav, setMobileNav] = useState(false)
  const loc = useLocation()

  return (
    <div className="flex h-[100dvh] overflow-hidden">
      {/* Sidebar — desktop */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-[var(--s-border)] bg-[color-mix(in_srgb,var(--s-surface)_70%,transparent)] px-3 py-4 lg:flex">
        <div className="px-1.5">
          <BrandMark />
        </div>
        <div className="mt-6 px-1">
          <div className="mono-label mb-2 px-2">Market</div>
          <NavItems />
        </div>
        <div className="mt-auto px-1">
          <a
            href={`${CHAIN.explorer}/address/${CHAIN.tangle}`}
            target="_blank"
            rel="noreferrer"
            className="panel panel-hover block px-3 py-3"
          >
            <div className="flex items-center gap-2">
              <span className="i-ph:shield-check-fill text-[16px] text-[var(--s-accent)]" />
              <span className="font-data text-[12px] font-semibold uppercase tracking-wider text-[var(--s-text-secondary)]">
                Base Sepolia
              </span>
            </div>
            <p className="mt-1.5 font-data text-[12px] leading-snug text-[var(--s-text-muted)]">
              Blueprint {CHAIN.blueprintId} · service {CHAIN.serviceId}
            </p>
          </a>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="flex h-[var(--header-h)] shrink-0 items-center justify-between gap-3 border-b border-[var(--s-border)] bg-[color-mix(in_srgb,var(--s-surface)_55%,transparent)] px-4 backdrop-blur-xl">
          <div className="flex items-center gap-3 lg:hidden">
            <button
              onClick={() => setMobileNav((v) => !v)}
              className="flex h-9 w-9 items-center justify-center rounded-[6px] border border-[var(--s-border)] text-[var(--s-text-secondary)]"
            >
              <span className="i-ph:list-dashes text-[18px]" />
            </button>
            <BrandMark />
          </div>
          <VenueStatus />
          <div className="flex items-center gap-2">
            <ThemeButton />
            <WalletButton />
          </div>
        </header>

        {/* Mobile nav drawer */}
        {mobileNav && (
          <div className="border-b border-[var(--s-border)] bg-[var(--s-surface)] px-3 py-3 lg:hidden">
            <NavItems onNavigate={() => setMobileNav(false)} />
          </div>
        )}

        <main key={loc.pathname} className="s-fade-up min-h-0 flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  )
}
