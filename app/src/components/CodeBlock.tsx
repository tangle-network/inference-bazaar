import { useState, type ReactNode } from 'react'

/**
 * Tiny dependency-free highlighter — enough for the short, controlled snippets
 * on the developer page, themed to the app's CSS vars (no shiki/prism bundle).
 * Strings and URLs are matched before the `//`/`#` comment rule, so a URL like
 * `https://…/v1` is never mistaken for a comment.
 */
const LEX =
  /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(https?:\/\/[^\s"'`)]+)|(\/\/[^\n]*|#[^\n]*)|(\b\d[\d_.]*\b)|(\b(?:import|from|export|default|const|let|var|async|await|function|return|def|class|new|if|elif|else|for|while|in|of|with|as|true|false|True|False|None|null|undefined)\b)|([A-Za-z_$][\w$]*)(?=\s*\()/g

const TONE: Record<number, string> = {
  1: 'text-[var(--s-emerald)]', // string
  2: 'text-[var(--s-blue)] underline decoration-dotted underline-offset-2', // url
  3: 'text-[var(--s-text-subtle)] italic', // comment
  4: 'text-[var(--s-amber)]', // number
  5: 'text-[var(--s-accent)]', // keyword
  6: 'text-[var(--s-blue)]', // function call
}

function highlight(code: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  LEX.lastIndex = 0
  let k = 0
  while ((m = LEX.exec(code))) {
    if (m.index > last) out.push(code.slice(last, m.index))
    const group = m.slice(1).findIndex((g) => g !== undefined) + 1
    out.push(
      <span key={k++} className={TONE[group]}>
        {m[0]}
      </span>,
    )
    last = m.index + m[0].length
  }
  if (last < code.length) out.push(code.slice(last))
  return out
}

export function CodeBlock({ code, className }: { code: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className={`group relative ${className ?? ''}`}>
      <button
        onClick={() => { void navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
        className="absolute right-2 top-2 rounded-[5px] border border-[var(--s-border)] bg-[var(--s-surface)] px-2 py-1 font-data text-[12px] font-semibold text-[var(--s-text-muted)] opacity-0 transition-opacity hover:text-[var(--s-accent)] focus-visible:opacity-100 group-hover:opacity-100"
      >
        {copied ? 'copied ✓' : 'copy'}
      </button>
      <pre className="overflow-x-auto rounded-[8px] bg-[var(--s-bg)]/60 px-4 py-3 font-data text-[15px] leading-relaxed text-[var(--s-text)]">
        <code>{highlight(code)}</code>
      </pre>
    </div>
  )
}
