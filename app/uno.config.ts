import { icons as phIcons } from '@iconify-json/ph'
import { defineConfig, presetIcons, transformerDirectives } from 'unocss'
import { presetWind4 } from 'unocss/preset-wind4'

/*
 * OBSIDIAN TERMINAL — Surplus
 * Bloomberg terminal meets luxury crypto, ported from the ai-trading-blueprint
 * arena. Deep teal-green obsidian base, electric teal for the live market,
 * violet for brand/actions, emerald gains / crimson losses, amber for highlights.
 * Numbers are mono (IBM Plex Mono, tabular). Surfaces are flat panels with
 * hairline borders and inset accent bars — almost no drop shadow except popovers.
 */

export default defineConfig({
  presets: [
    presetWind4({
      dark: { light: '[data-theme="light"]', dark: '[data-theme="dark"]' },
    }),
    presetIcons({ warn: true, collections: { ph: () => phIcons } }),
  ],
  transformers: [transformerDirectives()],
  shortcuts: {
    // The canonical panel: flat surface, hairline border, subtle hover.
    panel: 'bg-[var(--s-panel)] border border-[var(--s-border)] rounded-[6px]',
    'panel-hover':
      'transition-[background-color,border-color] duration-150 hover:bg-[var(--s-panel-strong)] hover:border-[var(--s-border-hover)]',
    'panel-strong': 'bg-[var(--s-panel-strong)] border border-[var(--s-border)] rounded-[6px]',
    // Micro-label: the uppercase tracked mono caption used on every stat.
    'mono-label':
      'font-data text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--s-text-muted)]',
    'mono-num': 'font-data tabular-nums text-[var(--s-text)]',
    // Primary action: solid teal. Secondary: panel. Danger: crimson text.
    'btn-primary':
      'inline-flex items-center justify-center gap-1.5 rounded-[6px] bg-[var(--s-accent)] px-3.5 font-data text-[13px] font-semibold uppercase tracking-wide text-[var(--s-accent-text)] transition-colors hover:bg-[var(--s-accent-strong)] disabled:opacity-40 disabled:cursor-not-allowed',
    'btn-secondary':
      'inline-flex items-center justify-center gap-1.5 rounded-[6px] border border-[var(--s-border)] bg-[var(--s-panel)] px-3.5 font-data text-[13px] font-semibold uppercase tracking-wide text-[var(--s-text-secondary)] transition-colors hover:border-[var(--s-border-hover)] hover:text-[var(--s-text)] disabled:opacity-40 disabled:cursor-not-allowed',
    'btn-brand':
      'inline-flex items-center justify-center gap-1.5 rounded-[6px] bg-[var(--s-brand)] px-3.5 font-data text-[13px] font-semibold uppercase tracking-wide text-white transition-colors hover:bg-[var(--s-brand-strong)] disabled:opacity-40 disabled:cursor-not-allowed',
    'focus-ring':
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--s-accent)]/60',
  },
  rules: [
    [/^font-display$/, () => ({ 'font-family': "'Outfit', system-ui, sans-serif" })],
    [/^font-body$/, () => ({ 'font-family': "'DM Sans', system-ui, sans-serif" })],
    [/^font-data$/, () => ({ 'font-family': "'IBM Plex Mono', 'JetBrains Mono', monospace" })],
  ],
  theme: {
    colors: {
      // Stable accents usable directly (e.g. text-emerald, text-crimson).
      emerald: { DEFAULT: '#3ddc97', soft: '#143c30' },
      crimson: { DEFAULT: '#ff5d6c', soft: '#3a1620' },
      amber: { DEFAULT: '#f2c066', soft: '#3a2f10' },
      accent: { DEFAULT: '#50d2c1' },
      brand: { DEFAULT: '#9b7cff' },
    },
  },
  preflights: [
    {
      getCSS: () => `
        @media (prefers-reduced-motion: reduce) {
          *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }
        }
      `,
    },
  ],
  safelist: [
    'i-ph:chart-line-up', 'i-ph:wallet', 'i-ph:storefront', 'i-ph:hard-drives',
    'i-ph:pulse', 'i-ph:caret-down', 'i-ph:caret-right', 'i-ph:caret-up',
    'i-ph:magnifying-glass', 'i-ph:sun', 'i-ph:moon', 'i-ph:lightning',
    'i-ph:lightning-fill', 'i-ph:brain', 'i-ph:wrench', 'i-ph:eye', 'i-ph:image',
    'i-ph:speaker-high', 'i-ph:microphone', 'i-ph:video', 'i-ph:text-aa',
    'i-ph:arrow-up-right', 'i-ph:arrow-down-right', 'i-ph:circle-fill',
    'i-ph:shield-check', 'i-ph:shield-check-fill', 'i-ph:coins', 'i-ph:gauge',
    'i-ph:check', 'i-ph:check-circle', 'i-ph:check-circle-fill', 'i-ph:x',
    'i-ph:arrow-left', 'i-ph:plus', 'i-ph:gear', 'i-ph:info', 'i-ph:clock',
    'i-ph:fire', 'i-ph:drop', 'i-ph:stack', 'i-ph:seal-check', 'i-ph:link-simple',
    'i-ph:key', 'i-ph:lock-simple', 'i-ph:trend-up', 'i-ph:trend-down',
    'i-ph:cube', 'i-ph:plugs-connected', 'i-ph:receipt', 'i-ph:list-dashes',
  ],
})
