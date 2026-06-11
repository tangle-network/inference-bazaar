import type { Capability } from './types'

export const CAPABILITY_META: Record<Capability, { label: string; icon: string; hue: string }> = {
  text: { label: 'Text', icon: 'i-ph:text-aa', hue: 'var(--s-text-secondary)' },
  tools: { label: 'Tool calling', icon: 'i-ph:wrench', hue: 'var(--s-accent)' },
  vision: { label: 'Vision', icon: 'i-ph:eye', hue: 'var(--s-blue)' },
  reasoning: { label: 'Reasoning', icon: 'i-ph:brain', hue: 'var(--s-brand)' },
  image: { label: 'Image', icon: 'i-ph:image', hue: 'var(--s-amber)' },
  audio: { label: 'Audio', icon: 'i-ph:speaker-high', hue: 'var(--s-emerald)' },
  video: { label: 'Video', icon: 'i-ph:video', hue: 'var(--s-crimson)' },
  voice: { label: 'Voice', icon: 'i-ph:microphone', hue: 'var(--s-brand-strong)' },
}

export const CAPABILITY_ORDER: Capability[] = [
  'text', 'tools', 'reasoning', 'vision', 'image', 'audio', 'video', 'voice',
]
