import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAccount, useReadContract, useSignTypedData } from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@tangle-network/sandbox-ui/primitives'
import type { Address, Hex } from 'viem'
import { PageHeader } from '~/components/PageHeader'
import { ApiKeyMint } from '~/components/ApiKeyMint'
import { CodeBlock } from '~/components/CodeBlock'
import { Badge, Panel, Segmented, Stat } from '~/components/ui'
import { cn } from '~/lib/cn'
import { compactUsd, pricePerM, tokens, truncAddr } from '~/lib/format'
import { CHAIN, ROUTER_URL, VENUE_URL, useCatalog, type CatalogModel } from '~/lib/api'
import { ProviderLogo } from '~/lib/logos'
import {
  EIP712_DOMAIN,
  SETTLEMENT,
  SETTLEMENT_ABI,
  USAGE_QUERY_TYPES,
  fetchVenueUsage,
  useMyLots,
  type CreditLot,
  type MeterRow,
} from '~/lib/settlement'
import { useVenueRegistry, endpointFor, type Venue } from '~/lib/venues'
import { privacyOn } from '~/lib/privacy'

type Tab = 'gateway' | 'router' | 'tcloud'
type ThinkingLevel = 'off' | 'low' | 'medium' | 'high'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  ms?: number
  error?: boolean
}

interface ChatModelOption {
  id: string
  name: string
  provider: string
  inputMicroPerM: number
  outputMicroPerM: number
}

interface ThinkingOption {
  value: ThinkingLevel
  label: string
  detail: string
}

const STARTER_PROMPTS = [
  'Show me a minimal OpenAI client for my lot-backed key',
  'Compare cheap models for a coding assistant',
  'What should I verify before routing this through production?',
]

const DEFAULT_CHAT_MAX_TOKENS = 600

/** Three ways to spend credits over the API. Each tab is the real integration
 * for that path; availability is tagged honestly — the router credit-debit and
 * the tcloud SDK surface are still rolling out, so they're marked, not faked. */
const TABS: Record<Tab, { label: string; badge: { tone: 'emerald' | 'amber'; text: string }; note: string; code: string }> = {
  gateway: {
    label: 'Gateway',
    badge: { tone: 'emerald', text: 'Live' },
    note: 'Local gateway for lot-backed API keys. Your app talks OpenAI-compatible HTTP; the gateway signs spend vouchers.',
    code: `from openai import OpenAI

# Run inference-bazaar-gateway with a minted lot key, then call:
client = OpenAI(base_url="http://127.0.0.1:8088/v1", api_key="sk-inference-bazaar")

resp = client.chat.completions.create(
    model="groq/llama-3.1-8b-instant",
    messages=[{"role": "user", "content": "hello"}],
)`,
  },
  router: {
    label: 'Router',
    badge: { tone: 'amber', text: 'Credits rolling out' },
    note: 'Live model router. Auto-spending Bazaar lots through the router is not the default path yet.',
    code: `from openai import OpenAI

# The Tangle Router — one base URL for every model, routed to a bonded operator.
client = OpenAI(base_url="${ROUTER_URL}/v1", api_key="tngl-...")

resp = client.chat.completions.create(
    model="groq/llama-3.1-8b-instant",
    messages=[{"role": "user", "content": "hello"}],
)`,
  },
  tcloud: {
    label: 'tcloud',
    badge: { tone: 'amber', text: 'Preview · tcloud#41' },
    note: 'SDK preview for cloud apps. Credit-lot pricing is still behind the preview surface.',
    code: `import { chat } from "@tangle-network/tcloud"

const res = await chat({
  model: "groq/llama-3.1-8b-instant",
  messages: [{ role: "user", content: "hello" }],
  pricing: { credits: true, mode: "market" },
})`,
  },
}

function Quickstart() {
  const [tab, setTab] = useState<Tab>('gateway')
  const t = TABS[tab]
  return (
    <Panel className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-[17px] font-semibold text-[var(--s-text)]">API access</h2>
        <Segmented
          size="sm"
          value={tab}
          onChange={setTab}
          options={(Object.keys(TABS) as Tab[]).map((k) => ({ value: k, label: TABS[k].label }))}
        />
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <Badge tone={t.badge.tone}>{t.badge.text}</Badge>
        <span className="font-body text-[15px] text-[var(--s-text-muted)]">{t.note}</span>
      </div>
      <CodeBlock code={t.code} className="mt-3" />
    </Panel>
  )
}

function normalizeGatewayUrl(raw: string) {
  const base = raw.trim().replace(/\/+$/, '')
  if (!base) return ''
  return base.endsWith('/v1') ? base : `${base}/v1`
}

function shortError(e: unknown) {
  const message = e instanceof Error ? e.message.split('\n')[0]! : String(e)
  return message.includes('Failed to fetch') ? 'Local gateway offline' : message
}

function toModelOption(model: CatalogModel): ChatModelOption {
  return {
    id: model.id,
    name: model.name || model.id,
    provider: model.provider && model.provider !== 'unknown' ? model.provider : providerFromModelId(model.id),
    inputMicroPerM: model.inputMicroPerM,
    outputMicroPerM: model.outputMicroPerM,
  }
}

function providerFromModelId(id: string) {
  if (id.includes('/')) return id.split('/')[0]!
  const lower = id.toLowerCase()
  if (lower.startsWith('gemini')) return 'google'
  if (lower.startsWith('deepseek')) return 'deepseek'
  if (lower.startsWith('gpt-')) return 'openai'
  return 'gateway'
}

function fallbackModelOption(id: string): ChatModelOption {
  const provider = providerFromModelId(id)
  return { id, name: id, provider, inputMicroPerM: 0, outputMicroPerM: 0 }
}

function formatModelPrice(microPerM: number) {
  return microPerM > 0 ? pricePerM(microPerM) : 'metered'
}

function gatewayStateLabel(state: 'idle' | 'checking' | 'ok' | 'error') {
  if (state === 'ok') return 'Ready'
  if (state === 'checking') return 'Checking'
  if (state === 'error') return 'Offline'
  return 'Local'
}

function useOutsideDismiss<T extends HTMLElement>(open: boolean, onDismiss: () => void) {
  const ref = useRef<T | null>(null)
  useEffect(() => {
    if (!open) return
    function onPointerDown(event: PointerEvent) {
      if (ref.current && event.target instanceof Node && !ref.current.contains(event.target)) onDismiss()
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onDismiss()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onDismiss])
  return ref
}

function ProviderMark({ provider, size = 'md' }: { provider: string; size?: 'sm' | 'md' }) {
  return <ProviderLogo provider={provider} size={size === 'sm' ? 30 : 36} />
}

function ChatModelPicker({
  value,
  models,
  onChange,
  loading,
  compact = false,
  placement = 'bottom',
  className,
}: {
  value: string
  models: ChatModelOption[]
  onChange: (id: string) => void
  loading: boolean
  compact?: boolean
  placement?: 'top' | 'bottom'
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useOutsideDismiss<HTMLDivElement>(open, () => setOpen(false))
  const selected = models.find((m) => m.id === value) ?? fallbackModelOption(value)
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return models
    return models.filter((m) => `${m.provider} ${m.name} ${m.id}`.toLowerCase().includes(q))
  }, [models, query])
  const groups = useMemo(() => {
    const byProvider = new Map<string, ChatModelOption[]>()
    for (const model of filtered) {
      const key = model.provider || 'Gateway'
      byProvider.set(key, [...(byProvider.get(key) ?? []), model])
    }
    return [...byProvider.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [filtered])

  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  return (
    <div ref={ref} className={cn('relative min-w-0', className)}>
      <button
        type="button"
        data-testid="developer-model-picker"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex w-full min-w-0 items-center text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] outline-none transition-colors hover:border-[var(--s-accent)]/45 focus-visible:border-[var(--s-accent)]/70',
          compact
            ? 'h-10 gap-2.5 rounded-[9px] border border-transparent bg-[var(--s-bg)]/60 px-2.5'
            : 'h-[46px] gap-3 rounded-[9px] border border-[var(--s-border)] bg-[var(--s-surface)] px-3',
        )}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <ProviderMark provider={selected.provider} size={compact ? 'sm' : 'md'} />
        <span className="min-w-0 flex-1">
          <span className={cn('block truncate font-data font-semibold text-[var(--s-text)]', compact ? 'text-[14px]' : 'text-[15px]')}>
            {selected.name}
          </span>
          <span className={cn('mt-0.5 min-w-0 items-center gap-2 font-data uppercase tracking-wide text-[var(--s-text-muted)]', compact ? 'hidden' : 'flex text-[12px]')}>
            <span className="truncate">{selected.provider}</span>
            <span className="text-[var(--s-text-subtle)]">/</span>
            <span>{formatModelPrice(selected.outputMicroPerM)} out</span>
          </span>
        </span>
        <span className={cn(loading ? 'i-ph:circle-notch animate-spin' : open ? 'i-ph:caret-up' : 'i-ph:caret-down', 'shrink-0 text-[17px] text-[var(--s-text-muted)]')} />
      </button>

      {open && (
        <div
          data-testid="developer-model-picker-list"
          className={cn(
            'absolute left-0 z-40 w-[min(92vw,560px)] overflow-hidden rounded-[10px] border border-[var(--s-border)] bg-[var(--s-panel)] shadow-[0_18px_60px_rgba(0,0,0,0.28)]',
            placement === 'top' ? 'bottom-full mb-2' : 'top-full mt-2',
          )}
          role="listbox"
        >
          <div className="border-b border-[var(--s-divider)] p-2">
            <label className="flex h-10 items-center gap-2 rounded-[10px] border border-[var(--s-border)] bg-[var(--s-bg)]/45 px-3 transition-[border-color,box-shadow,background-color] focus-within:border-[var(--s-accent)]/70 focus-within:bg-[var(--s-bg)]/70 focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--s-accent)_18%,transparent)]">
              <span className="i-ph:magnifying-glass text-[15px] text-[var(--s-text-subtle)]" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
                className="h-full min-w-0 flex-1 rounded-[9px] bg-transparent font-data text-[15px] text-[var(--s-text)] outline-none placeholder:text-[var(--s-text-subtle)] focus:outline-none focus-visible:outline-none"
                placeholder="Search models"
              />
            </label>
          </div>
          <div className="max-h-[360px] overflow-y-auto py-1">
            {groups.length === 0 ? (
              <div className="px-3 py-8 text-center font-data text-[13px] text-[var(--s-text-muted)]">
                No models match.
              </div>
            ) : (
              groups.map(([provider, items]) => (
                <div key={provider} className="py-1">
                  <div className="px-3 py-1 font-data text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--s-text-subtle)]">
                    {provider}
                  </div>
                  {items.map((item) => {
                    const active = item.id === value
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => {
                          onChange(item.id)
                          setOpen(false)
                        }}
                        className={cn(
                          'mx-1 grid w-[calc(100%-0.5rem)] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-[8px] px-2 py-2.5 text-left transition-colors focus:bg-[var(--s-surface)]',
                          active
                            ? 'bg-[var(--s-accent-soft)] text-[var(--s-accent)]'
                            : 'text-[var(--s-text-secondary)] hover:bg-[var(--s-surface)]',
                        )}
                        role="option"
                        aria-selected={active}
                      >
                        <ProviderMark provider={item.provider} size="sm" />
                        <span className="min-w-0">
                          <span className="block truncate font-data text-[15px] font-semibold">{item.name}</span>
                          <span className="block truncate font-data text-[12px] text-[var(--s-text-muted)]">{item.id}</span>
                        </span>
                        <span className="text-right font-data text-[12px] text-[var(--s-text-muted)]">
                          <span className="block uppercase tracking-wide">out</span>
                          <span className="block text-[var(--s-text-secondary)]">{formatModelPrice(item.outputMicroPerM)}</span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function supportsNativeThinking(modelId: string) {
  const id = modelId.toLowerCase()
  return id.includes('openai/') || id.startsWith('gpt-') || /\bo[134]\b/.test(id)
}

function thinkingOptionsFor(modelId: string): ThinkingOption[] {
  const native = supportsNativeThinking(modelId)
  return [
    { value: 'off', label: 'Off', detail: 'No extra reasoning instruction' },
    {
      value: 'low',
      label: 'Low',
      detail: native ? 'Sends native light reasoning' : 'Adds a brief private check',
    },
    {
      value: 'medium',
      label: 'Medium',
      detail: native ? 'Sends native balanced reasoning' : 'Adds careful problem solving',
    },
    {
      value: 'high',
      label: 'High',
      detail: native ? 'Sends native deep reasoning' : 'Adds deeper tradeoff analysis',
    },
  ]
}

function thinkingInstruction(thinking: ThinkingLevel) {
  if (thinking === 'off') return ''
  if (thinking === 'low') return 'Answer directly. Use a quick private check for assumptions before responding.'
  if (thinking === 'medium') return 'Work through the problem carefully before answering. Return the answer and only the essential evidence.'
  return 'Think deeply before answering. Resolve tradeoffs explicitly, then return a concise final answer with the key evidence.'
}

function buildSystemPrompt(thinking: ThinkingLevel) {
  return [
    'You are a concise developer assistant for Inference Bazaar. Give concrete, runnable answers.',
    thinkingInstruction(thinking),
  ]
    .filter(Boolean)
    .join('\n\n')
}

function EffortPicker({
  value,
  options,
  onChange,
}: {
  value: ThinkingLevel
  options: ThinkingOption[]
  onChange: (value: ThinkingLevel) => void
}) {
  const selected = options.find((option) => option.value === value) ?? options[0]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="developer-effort-picker"
          aria-label="Reasoning effort"
          className="inline-flex h-10 min-w-[144px] items-center gap-1.5 rounded-[9px] border border-transparent bg-[var(--s-bg)]/60 px-2.5 text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] outline-none transition-colors hover:border-[var(--s-accent)]/45 focus-visible:border-[var(--s-accent)]/70 data-[state=open]:border-[var(--s-accent)]/45"
        >
          <span className="i-ph:brain shrink-0 text-[15px] text-[var(--s-text-muted)]" />
          <span className="shrink-0 font-data text-[12px] font-semibold uppercase tracking-wide text-[var(--s-text-muted)]">
            Effort
          </span>
          <span className="min-w-0 flex-1 truncate font-data text-[13px] font-semibold text-[var(--s-text)]">
            {selected?.label ?? 'Off'}
          </span>
          <span className="i-ph:caret-down shrink-0 text-[14px] text-[var(--s-text-muted)]" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        data-testid="developer-effort-picker-list"
        side="top"
        align="start"
        sideOffset={8}
        className="z-50 w-[288px] max-w-[calc(100vw-24px)] rounded-[10px] border border-[var(--s-border)] bg-[var(--s-panel)] p-1 text-[var(--s-text)] shadow-[0_18px_60px_rgba(0,0,0,0.28)]"
      >
        {options.map((option) => {
          const active = option.value === value
          return (
            <DropdownMenuItem
              key={option.value}
              data-testid={`developer-effort-option-${option.value}`}
              onSelect={() => onChange(option.value)}
              className={cn(
                'rounded-[8px] px-3 py-2 font-data outline-none transition-colors focus:bg-[var(--s-surface)]',
                active
                  ? 'bg-[var(--s-accent-soft)] text-[var(--s-accent)]'
                  : 'text-[var(--s-text-secondary)]',
              )}
            >
              <span className="min-w-0">
                <span className="block truncate text-[14px] font-semibold">{option.label}</span>
                <span className={cn('mt-0.5 block text-[12px] leading-snug', active ? 'text-[var(--s-accent)] opacity-80' : 'text-[var(--s-text-muted)]')}>
                  {option.detail}
                </span>
              </span>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function useDeveloperModels(gatewayModels: string[]) {
  const catalog = useCatalog()
  return useMemo(() => {
    const byId = catalog.data ?? new Map<string, CatalogModel>()
    const ids = gatewayModels.length
      ? gatewayModels
      : [
          'groq/llama-3.1-8b-instant',
          'gemini-2.5-flash-lite',
          'deepseek-v4-flash',
          'openai/gpt-5-mini',
        ]
    const seen = new Set<string>()
    const out: ChatModelOption[] = []
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      const catalogModel = byId.get(id)
      out.push(catalogModel ? toModelOption(catalogModel) : fallbackModelOption(id))
    }
    if (out.length < 16 && byId.size > 0) {
      for (const model of byId.values()) {
        if (seen.has(model.id) || model.outputMicroPerM <= 0) continue
        seen.add(model.id)
        out.push(toModelOption(model))
        if (out.length >= 32) break
      }
    }
    return out
  }, [catalog.data, gatewayModels])
}

export function DeveloperChatPage() {
  const { address } = useAccount()
  const lots = useMyLots(address)
  const [gatewayUrl, setGatewayUrl] = useState('http://127.0.0.1:8088/v1')
  const [apiKey, setApiKey] = useState('sk-inference-bazaar')
  const [gatewayModels, setGatewayModels] = useState<string[]>([])
  const [model, setModel] = useState('groq/llama-3.1-8b-instant')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState<ThinkingLevel>('low')
  const [busy, setBusy] = useState(false)
  const [gatewayOpen, setGatewayOpen] = useState(false)
  const [gatewayState, setGatewayState] = useState<'idle' | 'checking' | 'ok' | 'error'>('idle')
  const [gatewayError, setGatewayError] = useState<string | null>(null)

  const modelOptions = useDeveloperModels(gatewayModels)
  const selected = modelOptions.find((m) => m.id === model) ?? fallbackModelOption(model)
  const thinkingOptions = useMemo(() => thinkingOptionsFor(model), [model])
  const statusTone = gatewayState === 'ok' ? 'emerald' : gatewayState === 'error' ? 'crimson' : 'neutral'
  const activeLots = (lots.data ?? []).filter(
    (l) => l.qtyTokens - l.lockedTokens > 0n && Number(l.expiry) * 1000 > Date.now(),
  )

  useEffect(() => {
    if (modelOptions.length > 0 && !modelOptions.some((m) => m.id === model)) {
      setModel(modelOptions[0]!.id)
    }
  }, [model, modelOptions])

  useEffect(() => {
    if (!thinkingOptions.some((option) => option.value === thinking)) {
      setThinking(thinkingOptions[thinkingOptions.length - 1]?.value ?? 'off')
    }
  }, [thinking, thinkingOptions])

  useEffect(() => {
    void refreshGatewayModels()
    // Only probe the default once on mount; editing the URL should not fire
    // requests on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function refreshGatewayModels() {
    const base = normalizeGatewayUrl(gatewayUrl)
    if (!base) return
    setGatewayState('checking')
    setGatewayError(null)
    try {
      const res = await fetch(`${base}/models`, {
        headers: { authorization: `Bearer ${apiKey || 'sk-inference-bazaar'}` },
      })
      const text = await res.text()
      if (!res.ok) throw new Error(`${res.status}: ${text}`)
      const json = JSON.parse(text) as { data?: Array<{ id?: string }> }
      const ids = (json.data ?? []).map((m) => m.id).filter((id): id is string => !!id)
      if (ids.length === 0) throw new Error('gateway returned no models')
      setGatewayModels(ids)
      setModel((current) => (ids.includes(current) ? current : ids[0]!))
      setGatewayState('ok')
    } catch (e) {
      setGatewayModels([])
      setGatewayState('error')
      setGatewayError(shortError(e))
    }
  }

  async function send() {
    const prompt = input.trim()
    const base = normalizeGatewayUrl(gatewayUrl)
    if (!prompt || !base || busy) return
    const user: ChatMessage = { id: `u-${Date.now()}`, role: 'user', content: prompt }
    const nextMessages = [...messages, user]
    setMessages(nextMessages)
    setInput('')
    setBusy(true)
    try {
      const body: {
        model: string
        max_tokens: number
        messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
        reasoning_effort?: Exclude<ThinkingLevel, 'off'>
      } = {
        model,
        max_tokens: DEFAULT_CHAT_MAX_TOKENS,
        messages: [
          { role: 'system', content: buildSystemPrompt(thinking) },
          ...nextMessages.map((m) => ({ role: m.role, content: m.content })),
        ],
      }
      if (supportsNativeThinking(model) && thinking !== 'off') {
        body.reasoning_effort = thinking
      }
      const started = performance.now()
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey || 'sk-inference-bazaar'}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      const text = await res.text()
      let json: any
      try {
        json = JSON.parse(text)
      } catch {
        json = null
      }
      if (!res.ok) {
        const msg = json?.error?.message ?? text
        throw new Error(`${res.status}: ${msg}`)
      }
      const assistant: ChatMessage = {
        id: `a-${Date.now()}`,
        role: 'assistant',
        content: json?.choices?.[0]?.message?.content?.trim() || '',
        usage: json?.usage,
        ms: Math.round(performance.now() - started),
      }
      setMessages([...nextMessages, assistant])
      setGatewayState('ok')
    } catch (e) {
      const message = shortError(e)
      setMessages([
        ...nextMessages,
        { id: `e-${Date.now()}`, role: 'assistant', content: message, error: true },
      ])
      setGatewayState('error')
      setGatewayError(message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="shrink-0 border-b border-[var(--s-divider)] bg-[color-mix(in_srgb,var(--s-bg)_82%,transparent)] px-3 py-3 backdrop-blur-xl sm:px-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <ProviderMark provider={selected.provider} size="sm" />
              <h1 className="truncate font-display text-[20px] font-semibold text-[var(--s-text)]">Chat</h1>
              <Badge tone={statusTone}>{gatewayStateLabel(gatewayState)}</Badge>
            </div>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2 font-data text-[12px] uppercase tracking-wide text-[var(--s-text-muted)]">
              <span className="truncate">{selected.provider}</span>
              <span className="text-[var(--s-text-subtle)]">/</span>
              <span>{selected.outputMicroPerM ? pricePerM(selected.outputMicroPerM) : 'metered'} out</span>
              <span className="text-[var(--s-text-subtle)]">/</span>
              <span>{lots.isLoading ? '...' : activeLots.length} active lots</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setGatewayOpen((v) => !v)}
              aria-expanded={gatewayOpen}
              className="btn-secondary h-9 whitespace-nowrap"
            >
              <span className="i-ph:terminal-window text-[16px]" /> Gateway
            </button>
            <Link to="/developer" className="btn-secondary h-9 whitespace-nowrap">
              <span className="i-ph:key text-[16px]" /> API keys
            </Link>
          </div>
        </div>

        {gatewayOpen && (
          <div className="mt-3 grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(220px,320px)_auto]">
            <label className="flex h-9 min-w-0 items-center gap-2 rounded-[8px] border border-[var(--s-border)] bg-[var(--s-surface)] px-2.5">
              <span className="i-ph:terminal-window shrink-0 text-[15px] text-[var(--s-text-subtle)]" />
              <input
                aria-label="Gateway URL"
                value={gatewayUrl}
                onChange={(e) => setGatewayUrl(e.target.value)}
                className="h-full min-w-0 flex-1 bg-transparent font-data text-[14px] text-[var(--s-text)] outline-none"
              />
            </label>
            <label className="flex h-9 min-w-0 items-center gap-2 rounded-[8px] border border-[var(--s-border)] bg-[var(--s-surface)] px-2.5">
              <span className="i-ph:key shrink-0 text-[15px] text-[var(--s-text-subtle)]" />
              <input
                aria-label="Gateway API key"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="h-full min-w-0 flex-1 bg-transparent font-data text-[14px] text-[var(--s-text)] outline-none"
              />
            </label>
            <button
              onClick={() => void refreshGatewayModels()}
              className="btn-secondary h-9 justify-center"
              title="Refresh gateway models"
            >
              <span className={cn(gatewayState === 'checking' ? 'i-ph:circle-notch animate-spin' : 'i-ph:arrow-clockwise', 'text-[16px]')} />
              Refresh
            </button>
          </div>
        )}
      </header>

      <section data-testid="developer-chat-log" className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-6">
        <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col justify-end gap-3">
          {messages.length === 0 ? (
            <div className="my-auto w-full max-w-[680px] self-center py-8">
              <div className="flex items-center gap-3">
                <ProviderMark provider={selected.provider} />
                <div className="min-w-0">
                  <h2 className="font-display text-[24px] font-semibold leading-tight text-[var(--s-text)]">
                    Lot-backed chat
                  </h2>
                  <p className="mt-1 font-body text-[15px] leading-relaxed text-[var(--s-text-muted)]">
                    Spend through the local gateway with any OpenAI-compatible model.
                  </p>
                </div>
              </div>
              {gatewayError && (
                <div className="mt-4 flex items-center gap-2 rounded-[8px] border border-[var(--s-crimson)]/25 bg-[var(--s-crimson-soft)] px-3 py-2 font-data text-[13px] text-[var(--s-crimson)]">
                  <span className="i-ph:warning-circle shrink-0 text-[16px]" />
                  <span className="min-w-0 truncate">{gatewayError}</span>
                </div>
              )}
              <div className="mt-5 grid gap-2 sm:grid-cols-3">
                {STARTER_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => setInput(prompt)}
                    className="min-h-[74px] rounded-[8px] border border-[var(--s-border)] bg-[var(--s-surface)] px-3 py-2 text-left font-data text-[13px] leading-relaxed text-[var(--s-text-secondary)] transition-colors hover:border-[var(--s-accent)]/45 hover:text-[var(--s-accent)]"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m) => (
              <div key={m.id} className={cn('flex items-start gap-2', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                {m.role === 'assistant' && (
                  <span
                    className={cn(
                      'mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] border',
                      m.error
                        ? 'border-[var(--s-crimson)]/35 bg-[var(--s-crimson-soft)] text-[var(--s-crimson)]'
                        : 'border-[var(--s-brand)]/35 bg-[var(--s-brand-soft)] text-[var(--s-brand)]',
                    )}
                  >
                    <span className={cn(m.error ? 'i-ph:warning-circle' : 'i-ph:sparkle', 'text-[15px]')} />
                  </span>
                )}
                <div
                  className={cn(
                    'max-w-[min(86%,720px)] rounded-[10px] border px-3 py-2',
                    m.role === 'user'
                      ? 'border-[var(--s-accent)]/30 bg-[var(--s-accent-soft)] text-[var(--s-text)]'
                      : m.error
                        ? 'border-[var(--s-crimson)]/30 bg-[var(--s-crimson-soft)] text-[var(--s-crimson)]'
                        : 'border-[var(--s-border)] bg-[var(--s-surface)] text-[var(--s-text-secondary)]',
                  )}
                >
                  <div className="whitespace-pre-wrap font-body text-[15px] leading-relaxed">{m.content}</div>
                  {m.usage && (
                    <div className="mt-2 font-data text-[12px] text-[var(--s-text-muted)]">
                      {m.usage.total_tokens ?? '...'} tokens · {m.ms ?? '...'} ms
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <footer className="shrink-0 border-t border-[var(--s-divider)] bg-[color-mix(in_srgb,var(--s-bg)_86%,transparent)] p-3 backdrop-blur-xl sm:p-4">
        <div className="mx-auto max-w-4xl overflow-visible rounded-[12px] border border-[var(--s-border)] bg-[var(--s-surface)] shadow-[0_10px_40px_rgba(0,0,0,0.12)]">
          <textarea
            data-testid="developer-chat-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
            rows={3}
            className="max-h-[28dvh] min-h-[92px] w-full resize-none bg-transparent px-3 py-3 font-body text-[15px] text-[var(--s-text)] outline-none placeholder:text-[var(--s-text-subtle)]"
            placeholder="Message your lot-backed model..."
          />
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--s-divider)] px-2 py-2">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
              <ChatModelPicker
                value={model}
                models={modelOptions}
                onChange={setModel}
                loading={gatewayState === 'checking'}
                compact
                placement="top"
                className="w-[min(100%,360px)]"
              />
              <EffortPicker value={thinking} options={thinkingOptions} onChange={setThinking} />
            </div>
            <button
              data-testid="developer-chat-send"
              onClick={() => void send()}
              disabled={busy || !input.trim()}
              className="btn-primary h-9 w-11 !px-0"
              title="Send"
            >
              <span className={cn(busy ? 'i-ph:circle-notch animate-spin' : 'i-ph:paper-plane-tilt', 'text-[18px]')} />
            </button>
          </div>
        </div>
      </footer>
    </div>
  )
}

/** The venue that issued a lot — its operator is the only one that meters it. */
function venueUrlForLot(lot: CreditLot, venues: Venue[] | undefined): string {
  const issuer = venues?.find(
    (v) => v.healthy && v.operator.toLowerCase() === lot.issuer.toLowerCase(),
  )
  return issuer ? endpointFor(issuer, privacyOn()) : VENUE_URL
}

/** On-chain draw-down (settled). When a signed live read is present, the
 * vouchered-but-unsettled `inflight` is shown too — it's the spend the chain
 * can't see yet. */
function SpendMeter({ lot, live }: { lot: CreditLot; live?: MeterRow }) {
  const filled = Number(lot.filledTokens)
  const spendable = Number(lot.qtyTokens - lot.lockedTokens)
  const locked = Number(lot.lockedTokens)
  const spent = Math.max(0, filled - Number(lot.qtyTokens))
  const pctSpent = filled > 0 ? Math.min(100, (spent / filled) * 100) : 0
  const pctLocked = filled > 0 ? Math.min(100 - pctSpent, (locked / filled) * 100) : 0
  const pctInflight =
    live && filled > 0 ? Math.min(100 - pctSpent - pctLocked, (live.inflightTokens / filled) * 100) : 0
  return (
    <div className="w-full">
      <div className="flex items-baseline justify-between font-data text-[15px]">
        <span className="text-[var(--s-emerald)]">{tokens(spendable)} left</span>
        <span className="text-[var(--s-text-muted)]">
          {tokens(spent)} spent of {tokens(filled)}
          {live && live.inflightTokens > 0 && (
            <span className="text-[var(--s-accent)]"> · {tokens(live.inflightTokens)} in-flight</span>
          )}
        </span>
      </div>
      <div className="mt-1.5 flex h-1.5 w-full overflow-hidden rounded-full bg-[var(--s-emerald-soft)]">
        <span className="h-full bg-[var(--s-text-muted)]" style={{ width: `${pctSpent}%` }} />
        <span className="h-full bg-[var(--s-amber)]" style={{ width: `${pctLocked}%` }} />
        <span className="h-full bg-[var(--s-accent)]" style={{ width: `${pctInflight}%` }} />
      </div>
    </div>
  )
}

function LotKey({ lot, venueUrl, live }: { lot: CreditLot; venueUrl: string; live?: MeterRow }) {
  const expired = Number(lot.expiry) * 1000 < Date.now()
  return (
    <Panel bodyClassName="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-center gap-2 font-data text-[15px] text-[var(--s-text-secondary)]">
          <span className="i-ph:hard-drives shrink-0 text-[16px] text-[var(--s-text-muted)]" />
          <a
            href={`${CHAIN.explorer}/address/${lot.issuer}`}
            target="_blank"
            rel="noreferrer"
            className="hover:text-[var(--s-accent)] hover:underline"
          >
            {truncAddr(lot.issuer)}
          </a>
          <span className="text-[var(--s-text-subtle)]">·</span>
          <span className={expired ? 'text-[var(--s-crimson)]' : 'text-[var(--s-text-muted)]'}>
            {expired ? 'expired' : `expires ${new Date(Number(lot.expiry) * 1000).toLocaleDateString()}`}
          </span>
        </div>
        <SpendMeter lot={lot} live={live} />
      </div>
      <div className="shrink-0">
        <ApiKeyMint lot={lot} venueUrl={venueUrl} />
      </div>
    </Panel>
  )
}

/**
 * Holder-signed read of live spend across every venue the holder has lots with.
 * ONE signature (UsageQuery is venue-independent) is fanned out to each distinct
 * venue; an unreachable venue is skipped, not fatal. Returns rows keyed by lotId.
 */
function useLiveUsage(address: Address | undefined) {
  const { signTypedDataAsync } = useSignTypedData()
  const [rows, setRows] = useState<Map<Hex, MeterRow> | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function sync(lots: CreditLot[], venues: Venue[] | undefined) {
    if (!address) return
    setSyncing(true)
    setError(null)
    try {
      const expiry = Math.floor(Date.now() / 1000) + 300
      const sig = (await signTypedDataAsync({
        domain: EIP712_DOMAIN,
        types: USAGE_QUERY_TYPES,
        primaryType: 'UsageQuery',
        message: { holder: address, expiry: BigInt(expiry) },
      })) as Hex
      const urls = [...new Set(lots.map((l) => venueUrlForLot(l, venues)))]
      const merged = new Map<Hex, MeterRow>()
      const results = await Promise.allSettled(
        urls.map((u) => fetchVenueUsage(u, address, expiry, sig)),
      )
      for (const r of results) {
        if (r.status === 'fulfilled') for (const [k, v] of r.value) merged.set(k, v)
      }
      if (merged.size === 0 && results.every((r) => r.status === 'rejected')) {
        throw new Error('no venue could be reached')
      }
      setRows(merged)
    } catch (e) {
      setError(e instanceof Error ? e.message.split('\n')[0]! : String(e))
    } finally {
      setSyncing(false)
    }
  }

  return { rows, syncing, error, sync }
}

/**
 * The developer surface: credits as an API. On-chain balances and spend are read
 * straight from the chain (filled − remaining), so they can't drift from what the
 * settlement contract enforces. "Sync live usage" signs a UsageQuery and overlays
 * the real-time, vouchered-but-unsettled spend the chain can't show yet.
 */
export default function DeveloperPage() {
  const { address, isConnected } = useAccount()
  const lots = useMyLots(address)
  const registry = useVenueRegistry()
  const meter = useLiveUsage(address)
  const settlementBalance = useReadContract({
    address: SETTLEMENT.address,
    abi: SETTLEMENT_ABI,
    functionName: 'balances',
    args: address ? [address] : undefined,
    chainId: CHAIN.id,
    query: { enabled: !!address },
  })

  const all = lots.data ?? []
  const remaining = all.reduce((n, l) => n + Number(l.qtyTokens - l.lockedTokens), 0)
  const spent = all.reduce((n, l) => n + Math.max(0, Number(l.filledTokens - l.qtyTokens)), 0)
  const liveKeys = all.filter((l) => l.qtyTokens - l.lockedTokens > 0n && Number(l.expiry) * 1000 > Date.now())
  const inflight = meter.rows ? [...meter.rows.values()].reduce((n, r) => n + r.inflightTokens, 0) : null

  return (
    <div>
      <PageHeader
        title="Developer"
        subtitle="API keys, credit spend, and integration paths."
        right={
          <>
            <Link to="/developer/chat" className="btn-primary h-9 whitespace-nowrap">
              <span className="i-ph:chat-circle-dots text-[16px]" /> Open chat
            </Link>
            {isConnected && all.length > 0 ? (
              <button
                onClick={() => void meter.sync(all, registry.data)}
                disabled={meter.syncing}
                className="btn-secondary h-9 whitespace-nowrap"
                title="Sign a read-only query to fetch live, unsettled spend from your operators"
              >
                <span className={meter.syncing ? 'i-ph:circle-notch animate-spin text-[16px]' : 'i-ph:pulse text-[16px]'} />
                {meter.syncing ? 'Signing...' : meter.rows ? 'Refresh usage' : 'Sync usage'}
              </button>
            ) : null}
          </>
        }
      />

      <div className="px-4 py-4 sm:px-6">
        {isConnected ? (
          <>
            <div className="panel grid grid-cols-2 divide-x divide-[var(--s-divider)] sm:grid-cols-4">
              <Stat label="Credits left" value={lots.isLoading ? '…' : tokens(remaining)} tone="emerald" sub="spendable tokens" />
              <Stat
                label="Spent"
                value={lots.isLoading ? '…' : tokens(spent)}
                sub={inflight != null && inflight > 0 ? `+${tokens(inflight)} in-flight` : 'drawn down on-chain'}
              />
              <Stat label="Active keys" value={lots.isLoading ? '…' : liveKeys.length} tone="accent" sub="usable lots" />
              <Stat
                label="Settlement balance"
                value={settlementBalance.data !== undefined ? compactUsd(Number(settlementBalance.data)) : '…'}
                sub="deposited tsUSD"
              />
            </div>
            {meter.error && (
              <p className="mt-2 font-data text-[12px] text-[var(--s-crimson)]">Live usage: {meter.error}</p>
            )}
          </>
        ) : (
          <Panel bodyClassName="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className="i-ph:key text-[24px] text-[var(--s-text-subtle)]" />
              <p className="font-body text-[15px] text-[var(--s-text-muted)]">
                Connect a wallet to mint lot-backed API keys and view on-chain drawdown.
              </p>
            </div>
            <ConnectKitButton.Custom>
              {({ show }) => (
                <button onClick={show} className="btn-primary h-10">
                  <span className="i-ph:wallet text-[17px]" /> Connect wallet
                </button>
              )}
            </ConnectKitButton.Custom>
          </Panel>
        )}
      </div>

      <div className="px-4 pb-4 sm:px-6">
        <Quickstart />
      </div>

      <div className="px-4 pb-4 sm:px-6">
        <h2 className="mb-2 font-display text-[17px] font-semibold text-[var(--s-text)]">API keys</h2>
        {!isConnected || !address ? (
          <Panel bodyClassName="flex flex-col items-center gap-3 px-6 py-12 text-center">
            <span className="i-ph:wallet text-[36px] text-[var(--s-text-subtle)]" />
            <p className="max-w-sm font-body text-[15px] text-[var(--s-text-muted)]">
              Wallet connection is only needed for key minting and live usage reads.
            </p>
            <ConnectKitButton.Custom>
              {({ show }) => (
                <button onClick={show} className="btn-primary h-10">
                  <span className="i-ph:wallet text-[16px]" /> Connect wallet
                </button>
              )}
            </ConnectKitButton.Custom>
          </Panel>
        ) : lots.isLoading ? (
          <p className="px-1 py-6 font-body text-[15px] text-[var(--s-text-muted)]">Reading your lots from the chain…</p>
        ) : all.length === 0 ? (
          <Panel bodyClassName="flex flex-col items-center gap-3 px-6 py-12 text-center">
            <span className="i-ph:key text-[36px] text-[var(--s-text-subtle)]" />
            <p className="max-w-sm font-body text-[15px] text-[var(--s-text-muted)]">
              No credit lots yet. Buy discounted inference, then mint a key here to spend it over the API.
            </p>
            <a href="/" className="btn-primary h-10">
              <span className="i-ph:lightning text-[16px]" /> Buy inference
            </a>
          </Panel>
        ) : (
          <div className="flex flex-col gap-3">
            {all.map((lot) => (
              <LotKey
                key={lot.lotId}
                lot={lot}
                venueUrl={venueUrlForLot(lot, registry.data)}
                live={meter.rows?.get(lot.lotId)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
