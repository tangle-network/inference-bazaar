import { icons as phIcons } from '@iconify-json/ph'
import { defineConfig, presetIcons, transformerDirectives } from 'unocss'
import { presetWind4 } from 'unocss/preset-wind4'

/*
 * OBSIDIAN TERMINAL — Surplus
 * The ai-trading-blueprints arena system, faithfully: deep obsidian blue-black
 * base (#0A0A0F depth layers), violet primary actions, electric emerald gains /
 * crimson losses / amber rankings, glass-card surfaces with backdrop blur and
 * semantic glow shadows. Numbers are mono (IBM Plex Mono, tabular).
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
    // Glass-card panels — arena obsidian-terminal surface treatment.
    panel:
      'bg-[var(--s-glass)] border border-[var(--s-border)] rounded-[10px] backdrop-blur-[16px]',
    'panel-hover':
      'transition-[background-color,border-color,box-shadow] duration-150 hover:bg-[var(--s-glass-strong)] hover:border-[var(--s-border-hover)]',
    'panel-strong':
      'bg-[var(--s-glass-strong)] border border-[var(--s-border)] rounded-[10px] backdrop-blur-[24px]',
    // Micro-label: the uppercase tracked mono caption used on every stat.
    'mono-label':
      'font-data text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--s-text-muted)]',
    'mono-num': 'font-data tabular-nums text-[var(--s-text)]',
    // Arena buttons: translucent violet fill + violet text, glow on hover.
    'btn-primary':
      'inline-flex items-center justify-center gap-1.5 rounded-[8px] bg-[var(--s-accent-soft)] border border-[var(--s-accent)]/30 px-4 font-data text-[13px] font-semibold uppercase tracking-wide text-[var(--s-accent)] transition-all hover:bg-[var(--s-accent)]/24 hover:border-[var(--s-accent)]/50 hover:shadow-[var(--s-glow-violet)] disabled:opacity-40 disabled:cursor-not-allowed',
    'btn-secondary':
      'inline-flex items-center justify-center gap-1.5 rounded-[8px] border border-[var(--s-border)] bg-[var(--s-glass)] px-4 font-data text-[13px] font-semibold uppercase tracking-wide text-[var(--s-text-secondary)] backdrop-blur-[8px] transition-colors hover:border-[var(--s-border-hover)] hover:text-[var(--s-text)] disabled:opacity-40 disabled:cursor-not-allowed',
    'btn-brand':
      'inline-flex items-center justify-center gap-1.5 rounded-[8px] bg-[var(--s-brand-soft)] border border-[var(--s-brand)]/30 px-4 font-data text-[13px] font-semibold uppercase tracking-wide text-[var(--s-brand)] transition-colors hover:bg-[var(--s-brand)]/24 hover:border-[var(--s-brand)]/50 disabled:opacity-40 disabled:cursor-not-allowed',
    'glow-emerald': 'shadow-[var(--s-glow-emerald)]',
    'glow-crimson': 'shadow-[var(--s-glow-crimson)]',
    'glow-violet': 'shadow-[var(--s-glow-violet)]',
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
      // Obsidian Terminal hues (ai-trading-blueprints arena), usable directly.
      emerald: { DEFAULT: '#00FF88', soft: 'rgba(0,255,136,0.10)' },
      crimson: { DEFAULT: '#FF4D6A', soft: 'rgba(255,59,92,0.12)' },
      amber: { DEFAULT: '#FFB800', soft: 'rgba(255,184,0,0.10)' },
      accent: { DEFAULT: '#A370FF' },
      brand: { DEFAULT: '#00B4FF' },
      violet: { DEFAULT: '#8B5CF6', 400: '#A370FF' },
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
