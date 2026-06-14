import { type ReactNode } from 'react'

export function PageHeader({
  title,
  subtitle,
  right,
}: {
  title: ReactNode
  subtitle?: ReactNode
  right?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 border-b border-[var(--s-border)] px-4 py-4 sm:px-6">
      <div className="min-w-0">
        <h1 className="flex items-center gap-2.5 font-display text-[22px] font-bold tracking-tight text-[var(--s-text)]">
          <span className="h-2 w-2 rounded-full bg-[var(--s-accent)] shadow-[0_0_10px_var(--s-accent)]" />
          {title}
        </h1>
        {subtitle != null && (
          <p className="mt-1 max-w-2xl font-body text-[15px] leading-snug text-[var(--s-text-muted)]">{subtitle}</p>
        )}
      </div>
      {right != null && <div className="flex items-center gap-2">{right}</div>}
    </div>
  )
}
