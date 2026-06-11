/**
 * Real provider logos — LobeHub's icon set (the canonical AI-brand SVGs),
 * keyed by the router catalog's `_provider`. No invented glyphs.
 */
import anthropic from '@lobehub/icons-static-svg/icons/claude-color.svg?url'
import openai from '@lobehub/icons-static-svg/icons/openai.svg?url'
import gemini from '@lobehub/icons-static-svg/icons/gemini-color.svg?url'
import deepseek from '@lobehub/icons-static-svg/icons/deepseek-color.svg?url'
import mistral from '@lobehub/icons-static-svg/icons/mistral-color.svg?url'
import zai from '@lobehub/icons-static-svg/icons/zai.svg?url'
import zhipu from '@lobehub/icons-static-svg/icons/zhipu-color.svg?url'
import groq from '@lobehub/icons-static-svg/icons/groq.svg?url'
import meta from '@lobehub/icons-static-svg/icons/meta-color.svg?url'
import qwen from '@lobehub/icons-static-svg/icons/qwen-color.svg?url'
import moonshot from '@lobehub/icons-static-svg/icons/moonshot.svg?url'
import xai from '@lobehub/icons-static-svg/icons/xai.svg?url'
import { cn } from '~/lib/cn'

const LOGOS: Record<string, { src: string; invertInDark?: boolean }> = {
  anthropic: { src: anthropic },
  openai: { src: openai, invertInDark: true },
  google: { src: gemini },
  deepseek: { src: deepseek },
  mistral: { src: mistral },
  mistralai: { src: mistral },
  zai: { src: zai, invertInDark: true },
  zhipu: { src: zhipu },
  groq: { src: groq, invertInDark: true },
  meta: { src: meta },
  'meta-llama': { src: meta },
  qwen: { src: qwen },
  moonshot: { src: moonshot, invertInDark: true },
  moonshotai: { src: moonshot, invertInDark: true },
  xai: { src: xai, invertInDark: true },
}

export function ProviderLogo({
  provider,
  size = 28,
  className,
}: {
  provider: string
  size?: number
  className?: string
}) {
  const logo = LOGOS[provider.toLowerCase()]
  if (!logo) {
    // Unknown provider: neutral monogram, never a fake brand.
    return (
      <span
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded-[7px] border border-[var(--s-border)] bg-[var(--s-panel-strong)] font-data font-bold text-[var(--s-text-secondary)]',
          className,
        )}
        style={{ width: size, height: size, fontSize: size * 0.42 }}
        title={provider}
      >
        {provider.slice(0, 2).toUpperCase()}
      </span>
    )
  }
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-[7px] border border-[var(--s-border)] bg-[var(--s-panel-strong)] p-[5px]',
        className,
      )}
      style={{ width: size, height: size }}
      title={provider}
    >
      <img
        src={logo.src}
        alt={provider}
        width={size - 10}
        height={size - 10}
        className={cn('h-full w-full object-contain', logo.invertInDark && 'logo-invert-dark')}
      />
    </span>
  )
}
