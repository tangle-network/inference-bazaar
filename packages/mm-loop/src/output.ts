import type { QuoteSet } from '@inference-bazaar/market-core'
import type { OutputAdapter, SandboxEvent } from '@tangle-network/agent-runtime/loops'

/**
 * SandboxEvent stream → QuoteSet.
 *
 * Both executors end in text: the inline algorithmic executor emits the
 * quote JSON as `result.finalText`; an agentic sandbox run ends with prose
 * that must contain one JSON object (fenced or bare). One adapter parses
 * both, so swapping executors never touches the loop wiring.
 */
export const quoteSetOutput: OutputAdapter<QuoteSet> = {
  parse(events: SandboxEvent[]): QuoteSet {
    const text = collectText(events)
    if (!text) throw new Error('no text output to parse quotes from')
    const candidate = extractJson(text)
    if (!candidate) throw new Error(`no JSON quote object found in output: ${text.slice(0, 200)}`)
    return validateQuoteSet(candidate)
  },
}

function collectText(events: SandboxEvent[]): string {
  const parts: string[] = []
  for (const event of events) {
    const data = (event as { data?: unknown }).data
    if (typeof data === 'string') {
      parts.push(data)
      continue
    }
    if (data && typeof data === 'object') {
      for (const key of ['finalText', 'answer', 'text', 'content', 'message'] as const) {
        const value = (data as Record<string, unknown>)[key]
        if (typeof value === 'string' && value.length > 0) parts.push(value)
      }
    }
  }
  return parts.join('\n')
}

function extractJson(text: string): unknown {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)]
  const lastFence = fenced[fenced.length - 1]?.[1]
  const sources = lastFence ? [lastFence, text] : [text]
  for (const source of sources) {
    const parsed = lastQuoteShapedJson(source)
    if (parsed !== undefined) return parsed
  }
  return undefined
}

function isQuoteShaped(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  return 'bid' in obj || 'ask' in obj || 'rationale' in obj
}

/**
 * Parse the LAST balanced `{...}` in the text that is valid JSON AND looks
 * like a quote set — otherwise a trailing `{"price":..,"qty":..}` inside the
 * real object would shadow its parent. Falls back to the last valid object.
 */
function lastQuoteShapedJson(text: string): unknown {
  let fallback: unknown
  for (let start = text.lastIndexOf('{'); start >= 0; start = text.lastIndexOf('{', start - 1)) {
    let depth = 0
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i]
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          try {
            const parsed: unknown = JSON.parse(text.slice(start, i + 1))
            if (isQuoteShaped(parsed)) return parsed
            if (fallback === undefined) fallback = parsed
          } catch {
            // not valid JSON from this start — keep scanning earlier opens
          }
          break
        }
      }
    }
    if (start === 0) break
  }
  return fallback
}

function validateQuoteSet(raw: unknown): QuoteSet {
  if (!raw || typeof raw !== 'object') throw new Error('quote output is not an object')
  const obj = raw as Record<string, unknown>
  const set: QuoteSet = {
    rationale: typeof obj.rationale === 'string' ? obj.rationale : '',
  }
  for (const side of ['bid', 'ask'] as const) {
    const quote = obj[side]
    if (quote === undefined || quote === null) continue
    if (typeof quote !== 'object') throw new Error(`${side} is not an object`)
    const { price, qty } = quote as Record<string, unknown>
    if (typeof price !== 'number' || typeof qty !== 'number') {
      throw new Error(`${side} missing numeric price/qty: ${JSON.stringify(quote)}`)
    }
    set[side] = { price, qty }
  }
  return set
}
