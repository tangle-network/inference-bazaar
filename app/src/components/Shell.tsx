import { useEffect, useState, type ReactNode } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { cn } from '~/lib/cn'
import { toggleTheme, useTheme } from '~/lib/theme'
import { privacyOn, setPrivacy } from '~/lib/privacy'
import { WalletButton } from '~/components/WalletButton'
import { NetworkSwitcher } from '~/components/NetworkSwitcher'
import { InferenceBazaarBrand } from '~/components/TangleLogo'

interface NavItem {
  to: string
  label: string
  icon: string
  end?: boolean
}

const MARKET_NAV: NavItem[] = [
  { to: '/', label: 'Buy inference', icon: 'i-ph:lightning', end: true },
  { to: '/portfolio', label: 'Portfolio', icon: 'i-ph:wallet' },
  { to: '/markets', label: 'Order books', icon: 'i-ph:chart-line-up' },
  { to: '/sell', label: 'Sell', icon: 'i-ph:storefront' },
  { to: '/operators', label: 'Operators', icon: 'i-ph:hard-drives' },
  { to: '/activity', label: 'Activity', icon: 'i-ph:pulse' },
]

const DEVELOPER_NAV: NavItem[] = [
  { to: '/developer', label: 'Developer', icon: 'i-ph:code', end: true },
  { to: '/developer/chat', label: 'Chat', icon: 'i-ph:chat-circle-dots' },
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

function NavItems({
  items,
  collapsed = false,
  onNavigate,
}: {
  items: NavItem[]
  collapsed?: boolean
  onNavigate?: () => void
}) {
  return (
    <nav className="flex flex-col gap-0.5">
      {items.map((item) => (
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

function NavSection({
  label,
  items,
  collapsed,
  onNavigate,
  className,
}: {
  label: string
  items: NavItem[]
  collapsed?: boolean
  onNavigate?: () => void
  className?: string
}) {
  return (
    <div className={cn(!collapsed && 'px-1', className)}>
      {collapsed ? <div className="mx-auto mb-2 h-px w-8 bg-[var(--s-divider)]" /> : <div className="mono-label mb-2 px-2">{label}</div>}
      <NavItems items={items} collapsed={collapsed} onNavigate={onNavigate} />
    </div>
  )
}

const SIDEBAR_KEY = 'inference-bazaar:sidebar-collapsed'

export function Shell({ children }: { children: ReactNode }) {
  const [mobileNav, setMobileNav] = useState(false)
  const [collapsed, setCollapsed] = useState(
    () => typeof window !== 'undefined' && window.localStorage.getItem(SIDEBAR_KEY) === 'true',
  )
  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_KEY, collapsed ? 'true' : 'false')
  }, [collapsed])
  // Embedded as a Tangle Cloud iframe blueprint: the host supplies the blueprint
  // identity/chrome, so drop our own brand lockup to avoid double identity.
  const embedded =
    typeof window !== 'undefined' &&
    (window.self !== window.top ||
      new URLSearchParams(window.location.search).get('embed') === '1')
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
        {/* Brand row + collapse control (hidden when embedded — host owns identity) */}
        {embedded ? null : collapsed ? (
          <div className="group/brand relative mx-auto h-10 w-10">
            <NavLink
              to="/"
              aria-label="Inference Bazaar home"
              className="flex h-10 w-10 items-center justify-center rounded-[8px] transition-colors hover:bg-[var(--s-panel)]"
            >
              <InferenceBazaarBrand compact />
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
            <NavLink to="/" aria-label="Inference Bazaar home" className="min-w-0">
              <InferenceBazaarBrand />
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

        <NavSection label="Market" items={MARKET_NAV} collapsed={collapsed} className="mt-6" />
        <NavSection label="Developer" items={DEVELOPER_NAV} collapsed={collapsed} className="mt-5" />

        {/* Controls dock — bottom-left (arena pattern). The top bar is killed on
         * desktop, so theme + privacy, the account, and the network switcher all
         * live here. */}
        <div className={cn('mt-auto', collapsed ? 'flex flex-col items-center gap-1.5' : 'space-y-2 px-1')}>
          {collapsed ? (
            <>
              <ThemeButton />
              <PrivacyButton />
              <WalletButton variant="sidebar" collapsed />
              <NetworkSwitcher collapsed />
            </>
          ) : (
            <>
              <div className="flex items-center gap-1.5">
                <ThemeButton />
                <PrivacyButton />
              </div>
              <div className="rounded-[10px] border border-[var(--s-border)] bg-[var(--s-surface)] p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
                <WalletButton variant="sidebar" />
                <div className="mt-1.5">
                  <NetworkSwitcher />
                </div>
              </div>
            </>
          )}
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* No desktop top bar — all controls live in the sidebar, so the content
         * gets the full height. A slim bar appears only on mobile, where the
         * sidebar is hidden. */}
        <header className="relative z-30 flex h-[var(--header-h)] shrink-0 items-center justify-between gap-3 border-b border-[var(--s-border)] bg-[color-mix(in_srgb,var(--s-surface)_55%,transparent)] px-4 backdrop-blur-xl lg:hidden">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setMobileNav((v) => !v)}
              className="flex h-9 w-9 items-center justify-center rounded-[6px] border border-[var(--s-border)] text-[var(--s-text-secondary)]"
            >
              <span className="i-ph:list-dashes text-[18px]" />
            </button>
            <InferenceBazaarBrand />
          </div>
          <div className="flex items-center gap-2">
            <PrivacyButton />
            <ThemeButton />
            <WalletButton />
          </div>
        </header>

        {/* Mobile nav drawer */}
        {mobileNav && (
          <div className="border-b border-[var(--s-border)] bg-[var(--s-surface)] px-3 py-3 lg:hidden">
            <NavSection label="Market" items={MARKET_NAV} onNavigate={() => setMobileNav(false)} />
            <NavSection label="Developer" items={DEVELOPER_NAV} onNavigate={() => setMobileNav(false)} className="mt-4" />
          </div>
        )}

        <main key={loc.pathname} className="s-fade-up min-h-0 flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  )
}
