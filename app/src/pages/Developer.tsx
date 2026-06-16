import { useEffect, useMemo, useRef, useState } from 'react'
import { useAccount, useReadContract, useSignTypedData } from 'wagmi'
import { ConnectKitButton } from 'connectkit'
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
type AgentProfile = 'builder' | 'operator' | 'research' | 'custom'
type ToolKey = 'market' | 'chain' | 'memory' | 'mcp'

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

const PROFILE_LABELS: Record<AgentProfile, string> = {
  builder: 'Builder',
  operator: 'Operator',
  research: 'Research',
  custom: 'Custom',
}

const PROFILE_PROMPTS: Record<AgentProfile, string> = {
  builder: 'You are a concise senior engineer. Prefer concrete implementation steps and runnable commands.',
  operator: 'You are an inference-market operator. Prioritize reliability, cost, settlement risk, and live verification.',
  research: 'You are a research analyst. Separate measured facts from inference and include the smallest useful evidence.',
  custom: 'Follow the agent profile below exactly where it is specific.',
}

const TOOL_OPTIONS: { key: ToolKey; label: string; icon: string; prompt: string }[] = [
  { key: 'market', label: 'Market', icon: 'i-ph:chart-line-up', prompt: 'Can reason over Inference Bazaar lots, books, operators, prices, and spend state.' },
  { key: 'chain', label: 'Chain', icon: 'i-ph:link-simple-horizontal', prompt: 'Can request on-chain evidence such as tx hashes, balances, lots, and settlement status.' },
  { key: 'memory', label: 'Memory', icon: 'i-ph:database', prompt: 'Can maintain project context across turns when the caller provides it.' },
  { key: 'mcp', label: 'MCP', icon: 'i-ph:plugs-connected', prompt: 'Can call declared MCP servers when an external runtime provides those tools.' },
]

const STARTER_PROMPTS = [
  'Price this agent workflow against my lots',
  'Draft a gateway client for a Next.js app',
  'Check the settlement risk before I scale this',
]

/** Three ways to spend credits over the API. Each tab is the real integration
 * for that path; availability is tagged honestly — the router credit-debit and
 * the tcloud SDK surface are still rolling out, so they're marked, not faked. */
const TABS: Record<Tab, { label: string; badge: { tone: 'emerald' | 'amber'; text: string }; note: string; code: string }> = {
  gateway: {
    label: 'Gateway',
    badge: { tone: 'emerald', text: 'Live' },
    note: 'Zero trust — the gateway runs on your machine and holds the session key; the operator can never bill more than it signs.',
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
    note: 'One endpoint for every model on Tangle. The endpoint is live; auto-spending your held credit lots through it is rolling out — today route via your platform balance or shielded credits.',
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
    note: 'The tcloud buyer SDK: `pricing` picks how you pay. credits spends your discounted lots soonest-expiry-first; market/limit cap the price you accept.',
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
        <h2 className="font-display text-[17px] font-semibold text-[var(--s-text)]">Connect your app</h2>
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
  return <ProviderLogo provider={provider} size={size === 'sm' ? 28 : 36} />
}

function ChatModelPicker({
  value,
  models,
  onChange,
  loading,
}: {
  value: string
  models: ChatModelOption[]
  onChange: (id: string) => void
  loading: boolean
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
    <div ref={ref} className="relative min-w-0">
      <button
        type="button"
        data-testid="developer-model-picker"
        onClick={() => setOpen((v) => !v)}
        className="flex h-[46px] w-full min-w-0 items-center gap-3 rounded-[9px] border border-[var(--s-border)] bg-[var(--s-surface)] px-3 text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] outline-none transition-colors hover:border-[var(--s-accent)]/45 focus-visible:border-[var(--s-accent)]/70"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <ProviderMark provider={selected.provider} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-data text-[15px] font-semibold text-[var(--s-text)]">
            {selected.name}
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-2 font-data text-[12px] uppercase tracking-wide text-[var(--s-text-muted)]">
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
          className="absolute left-0 top-full z-40 mt-2 w-[min(92vw,560px)] overflow-hidden rounded-[10px] border border-[var(--s-border)] bg-[var(--s-panel)] shadow-[0_18px_60px_rgba(0,0,0,0.28)]"
          role="listbox"
        >
          <div className="border-b border-[var(--s-divider)] p-2">
            <div className="flex h-9 items-center gap-2 rounded-[8px] border border-[var(--s-border)] bg-[var(--s-bg)]/45 px-2.5">
              <span className="i-ph:magnifying-glass text-[15px] text-[var(--s-text-subtle)]" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
                className="h-full min-w-0 flex-1 bg-transparent font-data text-[15px] text-[var(--s-text)] outline-none placeholder:text-[var(--s-text-subtle)]"
                placeholder="Search models"
              />
            </div>
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
                          'grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5 text-left transition-colors',
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

function lines(raw: string) {
  return raw
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean)
}

function buildSystemPrompt(params: {
  profile: AgentProfile
  customProfile: string
  thinking: boolean
  skills: string
  tools: Set<ToolKey>
  mcp: string
}) {
  const skillList = lines(params.skills)
  const mcpList = lines(params.mcp)
  const toolPrompts = TOOL_OPTIONS.filter((t) => params.tools.has(t.key)).map((t) => `- ${t.prompt}`)
  return [
    PROFILE_PROMPTS[params.profile],
    params.customProfile.trim(),
    params.thinking ? 'Use a private scratchpad for hard parts, but only return the final answer and essential evidence.' : '',
    skillList.length ? `Skills:\n${skillList.map((s) => `- ${s}`).join('\n')}` : '',
    toolPrompts.length ? `Available tool contract:\n${toolPrompts.join('\n')}` : '',
    mcpList.length ? `MCP servers declared by caller:\n${mcpList.map((s) => `- ${s}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

function DeveloperChat({ activeLots }: { activeLots: CreditLot[] }) {
  const catalog = useCatalog()
  const [gatewayUrl, setGatewayUrl] = useState('http://127.0.0.1:8088/v1')
  const [apiKey, setApiKey] = useState('sk-inference-bazaar')
  const [gatewayModels, setGatewayModels] = useState<string[]>([])
  const [model, setModel] = useState('groq/llama-3.1-8b-instant')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('What can I build with these inference lots?')
  const [profile, setProfile] = useState<AgentProfile>('builder')
  const [customProfile, setCustomProfile] = useState('')
  const [skills, setSkills] = useState('typescript, router integrations, on-chain settlement')
  const [mcp, setMcp] = useState('github, figma, tangle-admin')
  const [tools, setTools] = useState<Set<ToolKey>>(() => new Set(['market', 'chain']))
  const [thinking, setThinking] = useState(true)
  const [maxTokens, setMaxTokens] = useState(600)
  const [busy, setBusy] = useState(false)
  const [gatewayState, setGatewayState] = useState<'idle' | 'checking' | 'ok' | 'error'>('idle')
  const [gatewayError, setGatewayError] = useState<string | null>(null)

  const modelOptions = useMemo(() => {
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

  useEffect(() => {
    if (modelOptions.length > 0 && !modelOptions.some((m) => m.id === model)) {
      setModel(modelOptions[0]!.id)
    }
  }, [model, modelOptions])

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

  function toggleTool(key: ToolKey) {
    setTools((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
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
      const system = buildSystemPrompt({ profile, customProfile, thinking, skills, tools, mcp })
      const body = {
        model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          ...nextMessages.map((m) => ({ role: m.role, content: m.content })),
        ],
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

  const selected = modelOptions.find((m) => m.id === model) ?? fallbackModelOption(model)
  const statusTone = gatewayState === 'ok' ? 'emerald' : gatewayState === 'error' ? 'crimson' : 'neutral'
  const activeToolLabels = TOOL_OPTIONS.filter((tool) => tools.has(tool.key))

  return (
    <Panel className="overflow-visible" bodyClassName="grid gap-0 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="flex min-h-[620px] flex-col border-b border-[var(--s-divider)] lg:border-b-0 lg:border-r">
        <div className="grid gap-3 border-b border-[var(--s-divider)] px-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-4">
          <ChatModelPicker
            value={model}
            models={modelOptions}
            onChange={setModel}
            loading={gatewayState === 'checking'}
          />
          <div className="flex items-center justify-between gap-2 sm:justify-end">
            <Badge tone={statusTone}>{gatewayStateLabel(gatewayState)}</Badge>
            <button
              onClick={() => void refreshGatewayModels()}
              className="btn-secondary h-9 w-9 !px-0"
              title="Refresh gateway models"
            >
              <span className={cn(gatewayState === 'checking' ? 'i-ph:circle-notch animate-spin' : 'i-ph:arrow-clockwise', 'text-[16px]')} />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 border-b border-[var(--s-divider)] sm:grid-cols-4">
          <Stat label="Lots" value={activeLots.length} tone="accent" sub="wallet" />
          <Stat
            label="Profile"
            value={PROFILE_LABELS[profile]}
            sub={thinking ? 'private scratchpad' : 'direct replies'}
          />
          <Stat label="Provider" value={selected.provider} sub={selected.id} />
          <Stat label="Output" value={selected.outputMicroPerM ? pricePerM(selected.outputMicroPerM) : '—'} sub="/1M tokens" />
        </div>

        <div data-testid="developer-chat-log" className="flex-1 space-y-3 overflow-y-auto px-3 py-4 sm:px-4">
          {messages.length === 0 ? (
            <div className="flex h-full min-h-[280px] items-center justify-center">
              <div className="w-full max-w-[560px]">
                <div className="flex items-center gap-3">
                  <ProviderMark provider={selected.provider} />
                  <div className="min-w-0">
                    <h2 className="font-display text-[22px] font-semibold leading-tight text-[var(--s-text)]">
                      Lot-backed chat
                    </h2>
                    <p className="mt-1 font-body text-[15px] leading-relaxed text-[var(--s-text-muted)]">
                      OpenAI-compatible requests, metered through the local gateway.
                    </p>
                  </div>
                </div>
                {gatewayError && (
                  <div className="mt-4 flex items-center gap-2 rounded-[8px] border border-[var(--s-crimson)]/25 bg-[var(--s-crimson-soft)] px-3 py-2 font-data text-[13px] text-[var(--s-crimson)]">
                    <span className="i-ph:warning-circle shrink-0 text-[16px]" />
                    <span className="min-w-0 truncate">{gatewayError}</span>
                  </div>
                )}
                <div className="mt-5 flex flex-wrap gap-2">
                  {STARTER_PROMPTS.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      onClick={() => setInput(prompt)}
                      className="rounded-[8px] border border-[var(--s-border)] bg-[var(--s-surface)] px-3 py-2 text-left font-data text-[13px] text-[var(--s-text-secondary)] transition-colors hover:border-[var(--s-accent)]/45 hover:text-[var(--s-accent)]"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-2 font-data text-[12px] uppercase tracking-wide text-[var(--s-text-muted)]">
                  <span>{PROFILE_LABELS[profile]}</span>
                  <span className="text-[var(--s-text-subtle)]">/</span>
                  <span>{activeToolLabels.length ? activeToolLabels.map((tool) => tool.label).join(', ') : 'no tools'}</span>
                  <span className="text-[var(--s-text-subtle)]">/</span>
                  <span>{maxTokens} max tokens</span>
                </div>
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
                    'max-w-[86%] rounded-[10px] border px-3 py-2',
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
                      {m.usage.total_tokens ?? '—'} tokens · {m.ms ?? '—'} ms
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="border-t border-[var(--s-divider)] p-3">
          <div className="overflow-hidden rounded-[12px] border border-[var(--s-border)] bg-[var(--s-surface)]">
            <textarea
              data-testid="developer-chat-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              rows={3}
              className="min-h-[86px] w-full resize-none bg-transparent px-3 py-3 font-body text-[15px] text-[var(--s-text)] outline-none placeholder:text-[var(--s-text-subtle)]"
              placeholder="Message your lot-backed agent..."
            />
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--s-divider)] px-2 py-2">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="inline-flex h-8 items-center gap-1.5 rounded-[7px] bg-[var(--s-bg)]/60 px-2 font-data text-[12px] uppercase tracking-wide text-[var(--s-text-muted)]">
                  <span className="i-ph:user-focus text-[15px]" />
                  {PROFILE_LABELS[profile]}
                </span>
                <button
                  type="button"
                  onClick={() => setThinking((v) => !v)}
                  aria-pressed={thinking}
                  className={cn(
                    'inline-flex h-8 items-center gap-1.5 rounded-[7px] px-2 font-data text-[12px] font-semibold uppercase tracking-wide transition-colors',
                    thinking
                      ? 'bg-[var(--s-accent-soft)] text-[var(--s-accent)]'
                      : 'bg-[var(--s-bg)]/60 text-[var(--s-text-muted)] hover:text-[var(--s-text-secondary)]',
                  )}
                  title="Toggle private reasoning guidance"
                >
                  <span className="i-ph:brain text-[15px]" />
                  Thinking
                </button>
                <label className="inline-flex h-8 items-center gap-1.5 rounded-[7px] bg-[var(--s-bg)]/60 px-2 font-data text-[12px] uppercase tracking-wide text-[var(--s-text-muted)]">
                  Max
                  <input
                    aria-label="Max tokens"
                    type="number"
                    min={64}
                    max={4096}
                    step={64}
                    value={maxTokens}
                    onChange={(e) => setMaxTokens(Number(e.target.value))}
                    className="h-6 w-[68px] bg-transparent text-right font-data text-[13px] text-[var(--s-text)] outline-none"
                  />
                </label>
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
        </div>
      </div>

      <div className="divide-y divide-[var(--s-divider)] bg-[var(--s-bg)]/20 lg:bg-transparent">
        <section className="p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="mono-label">Runtime</div>
            <Badge tone={statusTone}>{gatewayStateLabel(gatewayState)}</Badge>
          </div>
          <div className="mt-3 grid gap-2">
            <div className="flex h-9 items-center gap-2 rounded-[8px] border border-[var(--s-border)] bg-[var(--s-surface)] px-2.5">
              <span className="i-ph:terminal-window shrink-0 text-[15px] text-[var(--s-text-subtle)]" />
              <input
                aria-label="Gateway URL"
                value={gatewayUrl}
                onChange={(e) => setGatewayUrl(e.target.value)}
                className="h-full min-w-0 flex-1 bg-transparent font-data text-[15px] text-[var(--s-text)] outline-none"
              />
            </div>
            <div className="flex h-9 items-center gap-2 rounded-[8px] border border-[var(--s-border)] bg-[var(--s-surface)] px-2.5">
              <span className="i-ph:key shrink-0 text-[15px] text-[var(--s-text-subtle)]" />
              <input
                aria-label="Gateway API key"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="h-full min-w-0 flex-1 bg-transparent font-data text-[15px] text-[var(--s-text)] outline-none"
              />
            </div>
          </div>
        </section>

        <section className="p-4">
          <div className="mono-label mb-2">Agent</div>
          <Segmented
            size="sm"
            value={profile}
            onChange={setProfile}
            options={(Object.keys(PROFILE_LABELS) as AgentProfile[]).map((value) => ({
              value,
              label: PROFILE_LABELS[value],
            }))}
          />
          {profile === 'custom' && (
            <textarea
              value={customProfile}
              onChange={(e) => setCustomProfile(e.target.value)}
              rows={3}
              className="mt-2 w-full resize-none rounded-[8px] border border-[var(--s-border)] bg-[var(--s-surface)] px-3 py-2 font-body text-[15px] text-[var(--s-text)] outline-none focus:border-[var(--s-accent)]/50"
              placeholder="Agent role, boundaries, style…"
            />
          )}
        </section>

        <section className="p-4">
          <div className="mono-label mb-2">Tools</div>
          <div className="grid grid-cols-2 gap-2">
            {TOOL_OPTIONS.map((tool) => {
              const active = tools.has(tool.key)
              return (
                <button
                  key={tool.key}
                  onClick={() => toggleTool(tool.key)}
                  aria-pressed={active}
                  className={cn(
                    'flex h-9 items-center justify-start gap-2 rounded-[8px] border px-3 font-data text-[15px] transition-colors',
                    active
                      ? 'border-[var(--s-brand)]/40 bg-[var(--s-brand-soft)] text-[var(--s-brand)]'
                      : 'border-[var(--s-border)] bg-[var(--s-surface)] text-[var(--s-text-muted)] hover:text-[var(--s-text-secondary)]',
                  )}
                >
                  <span className={cn(active ? tool.icon : 'i-ph:square', 'text-[16px]')} />
                  {tool.label}
                </button>
              )
            })}
          </div>
        </section>

        <section className="p-4">
          <div className="mono-label mb-2">Skills</div>
          <textarea
            value={skills}
            onChange={(e) => setSkills(e.target.value)}
            rows={3}
            className="w-full resize-none rounded-[8px] border border-[var(--s-border)] bg-[var(--s-surface)] px-3 py-2 font-body text-[15px] text-[var(--s-text)] outline-none focus:border-[var(--s-accent)]/50"
          />
          <div className="mono-label mb-2 mt-4">MCP</div>
          <textarea
            value={mcp}
            onChange={(e) => setMcp(e.target.value)}
            rows={3}
            className="w-full resize-none rounded-[8px] border border-[var(--s-border)] bg-[var(--s-surface)] px-3 py-2 font-body text-[15px] text-[var(--s-text)] outline-none focus:border-[var(--s-accent)]/50"
          />
        </section>
      </div>
    </Panel>
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
        subtitle="Your inference credits, as an OpenAI-compatible API."
        right={
          isConnected && all.length > 0 ? (
            <button
              onClick={() => void meter.sync(all, registry.data)}
              disabled={meter.syncing}
              className="btn-secondary h-9 whitespace-nowrap"
              title="Sign a read-only query to fetch live, unsettled spend from your operators"
            >
              <span className={meter.syncing ? 'i-ph:circle-notch animate-spin text-[16px]' : 'i-ph:pulse text-[16px]'} />
              {meter.syncing ? 'Signing…' : meter.rows ? 'Refresh live usage' : 'Sync live usage'}
            </button>
          ) : undefined
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

      <div className="px-4 py-4 sm:px-6">
        <DeveloperChat activeLots={liveKeys} />
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
