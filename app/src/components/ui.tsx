import { type ComponentProps, type ReactNode } from 'react'
import { Badge as SharedBadge } from '@tangle-network/ui/primitives'
import { cn } from '~/lib/cn'

// ── Brand mark for a lab/venue: tinted square with glyph or initials ──────────

export function Mark({
  hue,
  glyph,
  label,
  size = 28,
}: {
  hue: string
  glyph?: string
  label: string
  size?: number
}) {
  const initials = label
    .split(/[\s-]/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-[6px] font-data font-bold"
      style={{
        width: size,
        height: size,
        background: `color-mix(in srgb, ${hue} 18%, transparent)`,
        color: hue,
        border: `1px solid color-mix(in srgb, ${hue} 35%, transparent)`,
        fontSize: size * 0.4,
      }}
      title={label}
    >
      {glyph ? <span className={cn(glyph)} style={{ fontSize: size * 0.5 }} /> : initials}
    </span>
  )
}

// ── Badge / pill ──────────────────────────────────────────────────────────────

type Tone = 'neutral' | 'accent' | 'emerald' | 'crimson' | 'amber'
// Market meanings stay here; the shared primitive owns their rendering.
const toneVariants: Record<Tone, ComponentProps<typeof SharedBadge>['variant']> = {
  neutral: 'secondary',
  accent: 'sandbox',
  emerald: 'success',
  crimson: 'error',
  amber: 'warning',
}

export function Badge({
  children,
  tone = 'neutral',
  className,
  icon,
}: {
  children: ReactNode
  tone?: Tone
  className?: string
  icon?: string
}) {
  return (
    <SharedBadge variant={toneVariants[tone]} className={className}>
      {icon && <span className={cn(icon, 'text-[15px]')} aria-hidden="true" />}
      {children}
    </SharedBadge>
  )
}

// ── Stat tile ─────────────────────────────────────────────────────────────────

export function Stat({
  label,
  value,
  sub,
  tone,
  className,
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  tone?: 'accent' | 'emerald' | 'crimson' | 'amber'
  className?: string
}) {
  const color =
    tone === 'accent'
      ? 'var(--s-accent)'
      : tone === 'emerald'
        ? 'var(--s-emerald)'
        : tone === 'crimson'
          ? 'var(--s-crimson)'
          : tone === 'amber'
            ? 'var(--s-amber)'
            : 'var(--s-text)'
  return (
    <div className={cn('min-w-0 px-3.5 py-2.5', className)}>
      <div className="mono-label truncate">{label}</div>
      <div className="mt-1.5 truncate font-data text-[22px] font-bold leading-none tabular-nums" style={{ color }}>
        {value}
      </div>
      {sub != null && <div className="mt-1.5 truncate font-data text-[15px] text-[var(--s-text-muted)]">{sub}</div>}
    </div>
  )
}

// ── Sparkline — real chart.js gradient-area trend (see charts.tsx) ───────────

export { Sparkline } from './charts'

// ── Segmented control ─────────────────────────────────────────────────────────

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = 'md',
}: {
  value: T
  options: { value: T; label: ReactNode }[]
  onChange: (v: T) => void
  size?: 'sm' | 'md'
}) {
  return (
    <div className="inline-flex rounded-[6px] border border-[var(--s-border)] bg-[var(--s-surface)] p-0.5">
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className={cn(
              'rounded-[5px] font-data font-semibold uppercase tracking-wide transition-colors',
              size === 'sm' ? 'px-2.5 py-1 text-[12px]' : 'px-3 py-1.5 text-[15px]',
              active
                ? 'bg-[var(--s-accent-soft)] text-[var(--s-accent)]'
                : 'text-[var(--s-text-muted)] hover:text-[var(--s-text-secondary)]',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

// ── Slider with label ─────────────────────────────────────────────────────────

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  className,
}: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  className?: string
}) {
  const pctFill = ((value - min) / (max - min)) * 100
  return (
    <input
      type="range"
      className={cn('s-range w-full', className)}
      style={{
        background: `linear-gradient(90deg, var(--s-accent) ${pctFill}%, var(--s-border) ${pctFill}%)`,
      }}
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  )
}

// ── Section frame ─────────────────────────────────────────────────────────────

export function Panel({
  title,
  right,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode
  right?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <section className={cn('panel overflow-hidden', className)}>
      {title != null && (
        <header className="flex h-10 items-center justify-between border-b border-[var(--s-divider)] px-3.5">
          <h3 className="mono-label !text-[var(--s-text-secondary)] !tracking-[0.12em]">{title}</h3>
          {right}
        </header>
      )}
      <div className={cn(bodyClassName)}>{children}</div>
    </section>
  )
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <label className="block">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="mono-label">{label}</span>
        {hint != null && <span className="font-data text-[12px] text-[var(--s-text-muted)]">{hint}</span>}
      </div>
      {children}
    </label>
  )
}
