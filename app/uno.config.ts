import { icons as phIcons } from '@iconify-json/ph'
import { defineConfig, presetIcons, transformerDirectives } from 'unocss'
import { presetWind4 } from 'unocss/preset-wind4'

export default defineConfig({
  content: {
    filesystem: [
      './src/**/*.{ts,tsx}',
      './node_modules/@tangle-network/ui/src/primitives/badge.tsx',
      './node_modules/@tangle-network/ui/src/primitives/dropdown-menu.tsx',
      './node_modules/@tangle-network/ui/src/lib/surface-motion.tsx',
      './node_modules/@tangle-network/ui/src/markdown/code-block.tsx',
      './node_modules/@tangle-network/ui/src/lib/focus.ts',
      './node_modules/@tangle-network/ui/src/lib/code-presentation.ts',
    ],
  },
  presets: [
    presetWind4({
      dark: { light: '[data-theme="aubergine-light"]', dark: '[data-theme="aubergine"]' },
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
      'font-data text-[12px] font-semibold uppercase tracking-[0.14em] text-[var(--s-text-muted)]',
    'mono-num': 'font-data tabular-nums text-[var(--s-text)]',
    // Arena buttons: translucent violet fill + violet text, glow on hover.
    'btn-primary':
      'inline-flex items-center justify-center gap-1.5 rounded-[8px] bg-[var(--s-accent-soft)] border border-[var(--s-accent)]/30 px-4 font-data text-[15px] font-semibold uppercase tracking-wide text-[var(--s-accent)] transition-all hover:bg-[var(--s-accent)]/24 hover:border-[var(--s-accent)]/50 hover:shadow-[var(--s-glow-violet)] disabled:opacity-40 disabled:cursor-not-allowed',
    'btn-secondary':
      'inline-flex items-center justify-center gap-1.5 rounded-[8px] border border-[var(--s-border)] bg-[var(--s-glass)] px-4 font-data text-[15px] font-semibold uppercase tracking-wide text-[var(--s-text-secondary)] backdrop-blur-[8px] transition-colors hover:border-[var(--s-border-hover)] hover:text-[var(--s-text)] disabled:opacity-40 disabled:cursor-not-allowed',
    'btn-brand':
      'inline-flex items-center justify-center gap-1.5 rounded-[8px] bg-[var(--s-brand-soft)] border border-[var(--s-brand)]/30 px-4 font-data text-[15px] font-semibold uppercase tracking-wide text-[var(--s-brand)] transition-colors hover:bg-[var(--s-brand)]/24 hover:border-[var(--s-brand)]/50 disabled:opacity-40 disabled:cursor-not-allowed',
    'focus-ring':
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--s-accent)]/60',
  },
  theme: {
    font: { sans: 'var(--font-sans)', mono: 'var(--font-mono)' },
    colors: Object.fromEntries(
      [
        'background', 'foreground', 'card', 'card-foreground',
        'primary', 'primary-foreground', 'secondary', 'secondary-foreground',
        'muted', 'muted-foreground', 'popover', 'popover-foreground',
        'accent', 'accent-foreground', 'destructive', 'destructive-foreground',
        'border', 'input', 'ring',
      ].map((role) => [role, `hsl(var(--hsl-${role}))`]),
    ),
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
    'i-ph:globe-hemisphere-west',
  ],
})
