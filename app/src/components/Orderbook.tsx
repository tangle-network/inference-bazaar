import { useMemo } from 'react'
import { pricePerM, tokens } from '~/lib/format'
import type { BookLevel } from '~/lib/api'

export function Orderbook({ bids, asks }: { bids: BookLevel[]; asks: BookLevel[] }) {
  const maxTokens = useMemo(
    () => Math.max(1, ...bids.map((b) => b.qty), ...asks.map((a) => a.qty)),
    [bids, asks],
  )
  const bestBid = bids[0]?.price ?? 0
  const bestAsk = asks[0]?.price ?? 0
  const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : bestBid || bestAsk
  const spread = bestAsk && bestBid ? bestAsk - bestBid : 0

  const asksDesc = [...asks].reverse()

  return (
    <div className="font-data text-[13px]">
      <div className="grid grid-cols-3 border-b border-[var(--s-divider)] px-3 py-1.5">
        <span className="mono-label">Price /1M</span>
        <span className="mono-label text-right">Size</span>
        <span className="mono-label text-right">Orders</span>
      </div>
      <div>
        {asksDesc.map((a, i) => (
          <Row key={`a${i}`} level={a} max={maxTokens} side="ask" />
        ))}
      </div>
      <div className="flex items-center justify-between border-y border-[var(--s-divider)] bg-[var(--s-panel)] px-3 py-1.5">
        <span className="tabular-nums font-semibold text-[var(--s-text)]">{pricePerM(mid)}</span>
        <span className="text-[12px] text-[var(--s-text-muted)]">
          spread {pricePerM(spread)} · {mid > 0 ? ((spread / mid) * 10000).toFixed(0) : '0'} bps
        </span>
      </div>
      <div>
        {bids.map((b, i) => (
          <Row key={`b${i}`} level={b} max={maxTokens} side="bid" />
        ))}
      </div>
    </div>
  )
}

function Row({ level, max, side }: { level: BookLevel; max: number; side: 'bid' | 'ask' }) {
  const color = side === 'bid' ? 'var(--s-emerald)' : 'var(--s-crimson)'
  const fill = side === 'bid' ? 'var(--s-emerald-soft)' : 'var(--s-crimson-soft)'
  const w = (level.qty / max) * 100
  return (
    <div className="relative grid grid-cols-3 px-3 py-1 hover:bg-[var(--s-panel)]">
      <div className="absolute inset-y-0 right-0" style={{ width: `${w}%`, background: fill, opacity: 0.6 }} />
      <span className="relative tabular-nums" style={{ color }}>
        {pricePerM(level.price)}
      </span>
      <span className="relative text-right tabular-nums text-[var(--s-text-secondary)]">{tokens(level.qty)}</span>
      <span className="relative text-right tabular-nums text-[var(--s-text-muted)]">{level.orders}</span>
    </div>
  )
}
