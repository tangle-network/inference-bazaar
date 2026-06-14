import { useEffect, useState, type ReactNode } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { cn } from '~/lib/cn'
import { toggleTheme, useTheme } from '~/lib/theme'
import { privacyOn, setPrivacy } from '~/lib/privacy'
import { WalletButton } from '~/components/WalletButton'
import { SurplusBrand } from '~/components/TangleLogo'
import { CHAIN, useVenueHealth } from '~/lib/api'
import { useVenueRegistry } from '~/lib/venues'

/** Measured, not asserted: live venue health + latency. */
function VenueStatus() {
  const health = useVenueHealth()
  return (
    <a
      href={`${CHAIN.explorer}/address/${CHAIN.tangle}`}
      target="_blank"
      rel="noreferrer"
      className="hidden items-center gap-2 rounded-[8px] border border-[var(--s-border)] px-2.5 py-1.5 transition-colors hover:border-[var(--s-border-hover)] lg:flex"
      title="Home venue health · Surplus on Base Sepolia (Blueprint 17)"
    >
      <span
        className={cn(
          'h-2 w-2 rounded-full',
          health.data?.ok ? 'bg-[var(--s-emerald)]' : health.isError ? 'bg-[var(--s-crimson)]' : 'bg-[var(--s-amber)] animate-pulse',
        )}
      />
      <span className="font-data text-[15px] tabular-nums text-[var(--s-text-muted)]">
        {health.data?.ok ? `venue ${health.data.latencyMs}ms` : health.isError ? 'venue down' : 'venue…'}
      </span>
    </a>
  )
}

// Outcome-led: the buyer's two verbs first (get cheaper inference, hold it),
// then the engine room (books, sellers, operators, the on-chain trail).
const NAV = [
  { to: '/', label: 'Buy inference', icon: 'i-ph:lightning', end: true },
  { to: '/portfolio', label: 'Portfolio', icon: 'i-ph:wallet' },
  { to: '/markets', label: 'Order books', icon: 'i-ph:chart-line-up' },
  { to: '/sell', label: 'Sell', icon: 'i-ph:storefront' },
  { to: '/operators', label: 'Operators', icon: 'i-ph:hard-drives' },
  { to: '/activity', label: 'Activity', icon: 'i-ph:pulse' },
]

function ThemeButton() {
  const theme = useTheme()
  return (
    <button
      onClick={toggleTheme}
      className="flex h-9 w-9 items-center justify-center rounded-[6px] border border-[var(--s-border)] bg-[var(--s-panel)] text-[var(--s-text-muted)] transition-colors hover:border-[var(--s-border-hover)] hover:text-[var(--s-text)]"
      title="Toggle theme"
    >
      <span className={cn(theme === 'dark' ? 'i-ph:sun' : 'i-ph:moon', 'text-[18px]')} />
    </button>
  )
}

/** Toggle Tor privacy: dial operators at their .onion and spread acquisitions
 * anti-stickily. Effective network anonymity needs a Tor-enabled browser. */
function PrivacyButton() {
  const [on, setOn] = useState(privacyOn)
  return (
    <button
      onClick={() => {
        const next = !on
        setPrivacy(next)
        setOn(next)
      }}
      aria-pressed={on}
      className={cn(
        'relative flex h-9 w-9 items-center justify-center rounded-[6px] border transition-colors',
        on
          ? 'border-[var(--s-accent)]/40 bg-[var(--s-accent-soft)] text-[var(--s-accent)]'
          : 'border-[var(--s-border)] bg-[var(--s-panel)] text-[var(--s-text-muted)] hover:border-[var(--s-border-hover)] hover:text-[var(--s-text)]',
      )}
      title={
        on
          ? 'Tor privacy ON — dialing operator .onions + anti-sticky acquisition (use a Tor browser for full anonymity). Click to turn off.'
          : 'Tor privacy OFF — clearnet. Click to route via operator .onions.'
      }
    >
      <span className={cn(on ? 'i-ph:shield-check-fill' : 'i-ph:shield', 'text-[18px]')} />
      {on && (
        <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-[var(--s-accent)] ring-2 ring-[var(--s-bg)]" />
      )}
    </button>
  )
}

function NavItems({ collapsed = false, onNavigate }: { collapsed?: boolean; onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col gap-0.5">
      {NAV.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          onClick={onNavigate}
          // Collapsed: native tooltip carries the label the text span drops.
          title={collapsed ? item.label : undefined}
          aria-label={collapsed ? item.label : undefined}
          className={({ isActive }) =>
            cn(
              'group relative flex items-center rounded-[8px] font-data text-[15px] font-medium transition-colors',
              collapsed ? 'h-10 w-11 justify-center px-0' : 'gap-3 px-3 py-2.5',
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
              <span className={cn(item.icon, 'shrink-0 text-[18px]')} />
              {!collapsed && item.label}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  )
}

const SIDEBAR_KEY = 'surplus:sidebar-collapsed'

export function Shell({ children }: { children: ReactNode }) {
  const [mobileNav, setMobileNav] = useState(false)
  const [collapsed, setCollapsed] = useState(
    () => typeof window !== 'undefined' && window.localStorage.getItem(SIDEBAR_KEY) === 'true',
  )
  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_KEY, collapsed ? 'true' : 'false')
  }, [collapsed])
  // Multi-instance: how many operators are live across ALL blueprint-17 instances
  // (the registry union), not a single pinned service.
  const registry = useVenueRegistry()
  const liveOps = (registry.data ?? []).filter((v) => v.healthy).length
  const liveLabel = registry.data ? `${liveOps} operator${liveOps === 1 ? '' : 's'} live` : 'live on-chain'
  const loc = useLocation()

  return (
    <div className="flex h-[100dvh] overflow-hidden">
      {/* Sidebar — desktop. Collapsible to an icon rail (persisted). */}
      <aside
        className={cn(
          // relative z-30 so the account dock's upward menu paints ABOVE the main
          // content (which has its own stacking context from the fade transform).
          'relative z-30 hidden shrink-0 flex-col border-r border-[var(--s-border)] bg-[color-mix(in_srgb,var(--s-surface)_70%,transparent)] py-4 transition-[width] duration-200 lg:flex',
          collapsed ? 'w-16 px-2' : 'w-60 px-3',
        )}
      >
        {/* Brand row + collapse control */}
        {collapsed ? (
          <div className="group/brand relative mx-auto h-10 w-10">
            <NavLink
              to="/"
              aria-label="Surplus home"
              className="flex h-10 w-10 items-center justify-center rounded-[8px] transition-colors hover:bg-[var(--s-panel)]"
            >
              <SurplusBrand compact />
            </NavLink>
            <button
              onClick={() => setCollapsed(false)}
              aria-label="Expand sidebar"
              title="Expand sidebar"
              className="pointer-events-none absolute inset-0 flex h-10 w-10 items-center justify-center rounded-[8px] border border-[var(--s-border-hover)] bg-[var(--s-panel)] text-[var(--s-text-secondary)] opacity-0 shadow-[var(--s-shadow-pop)] transition-opacity duration-150 hover:text-[var(--s-text)] focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/brand:pointer-events-auto group-hover/brand:opacity-100"
            >
              <span className="i-ph:caret-right-bold text-[18px]" />
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2 pl-1.5">
            <NavLink to="/" aria-label="Surplus home" className="min-w-0">
              <SurplusBrand />
            </NavLink>
            <button
              onClick={() => setCollapsed(true)}
              aria-label="Collapse sidebar"
              title="Collapse sidebar"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] text-[var(--s-text-muted)] transition-colors hover:bg-[var(--s-panel)] hover:text-[var(--s-text)]"
            >
              <span className="i-ph:caret-left-bold text-[18px]" />
            </button>
          </div>
        )}

        <div className={cn('mt-6', !collapsed && 'px-1')}>
          {!collapsed && <div className="mono-label mb-2 px-2">Market</div>}
          <NavItems collapsed={collapsed} />
        </div>

        {/* Account dock — bottom-left, mirroring the arena shell: a recessed tray
         * holding the account control + a clean network pill (no blueprint chrome). */}
        <div className={cn('mt-auto', collapsed ? 'flex flex-col items-center gap-1.5' : 'px-1')}>
          {collapsed ? (
            <>
              <WalletButton variant="sidebar" collapsed />
              <NavLink
                to="/operators"
                title={`Base Sepolia · ${liveLabel} — view operators`}
                className="relative flex h-10 w-11 items-center justify-center rounded-[8px] border border-[var(--s-border)] bg-[var(--s-panel)] text-[var(--s-text-muted)] transition-colors hover:border-[var(--s-border-hover)] hover:text-[var(--s-text)]"
              >
                <span className="i-ph:globe-hemisphere-west text-[18px]" />
                <span
                  className={cn(
                    'absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full ring-2 ring-[var(--s-surface)]',
                    liveOps > 0 ? 'bg-[var(--s-emerald)]' : 'bg-[var(--s-amber)]',
                  )}
                />
              </NavLink>
            </>
          ) : (
            <div className="rounded-[10px] border border-[var(--s-border)] bg-[var(--s-surface)] p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
              <WalletButton variant="sidebar" />
              <NavLink
                to="/operators"
                title={`Base Sepolia · ${liveLabel} — view operators`}
                className="mt-1.5 flex h-10 w-full items-center gap-2 rounded-[8px] border border-[var(--s-border)] bg-[var(--s-panel)] px-2.5 text-[var(--s-text-secondary)] transition-colors hover:border-[var(--s-border-hover)] hover:text-[var(--s-text)]"
              >
                <span className="i-ph:globe-hemisphere-west shrink-0 text-[18px] text-[var(--s-text-muted)]" />
                <span className="truncate font-data text-[15px] font-medium">Base Sepolia</span>
                <span
                  className={cn(
                    'ml-auto h-2 w-2 shrink-0 rounded-full',
                    liveOps > 0 ? 'bg-[var(--s-emerald)]' : 'bg-[var(--s-amber)]',
                  )}
                />
              </NavLink>
            </div>
          )}
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="relative z-30 flex h-[var(--header-h)] shrink-0 items-center justify-between gap-3 border-b border-[var(--s-border)] bg-[color-mix(in_srgb,var(--s-surface)_55%,transparent)] px-4 backdrop-blur-xl">
          <div className="flex items-center gap-3 lg:hidden">
            <button
              onClick={() => setMobileNav((v) => !v)}
              className="flex h-9 w-9 items-center justify-center rounded-[6px] border border-[var(--s-border)] text-[var(--s-text-secondary)]"
            >
              <span className="i-ph:list-dashes text-[18px]" />
            </button>
            <SurplusBrand />
          </div>
          <VenueStatus />
          <div className="flex items-center gap-2">
            <PrivacyButton />
            <ThemeButton />
            {/* Desktop docks the wallet in the sidebar; the top bar carries it only
             * on mobile, where the sidebar is hidden. */}
            <div className="lg:hidden">
              <WalletButton />
            </div>
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
