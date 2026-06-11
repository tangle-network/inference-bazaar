import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PageHeader } from '~/components/PageHeader'
import { Badge, Field, Mark, Segmented } from '~/components/ui'
import { cn } from '~/lib/cn'
import { usd } from '~/lib/format'
import { LABS, VENUES } from '~/lib/mock'

type Reach = 'clearnet' | 'onion'

export default function OperatorRegisterPage() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [venues, setVenues] = useState<Set<string>>(new Set())
  const [labs, setLabs] = useState<Set<string>>(new Set())
  const [reach, setReach] = useState<Reach>('clearnet')
  const [endpoint, setEndpoint] = useState('')
  const [bond, setBond] = useState(25_000)
  const [feeBps, setFeeBps] = useState(200)
  const [done, setDone] = useState(false)

  const venueList = Object.values(VENUES).filter((v) => v.id !== 'tangle')
  const labList = Object.values(LABS)
  const ready = name.length > 1 && venues.size > 0 && labs.size > 0 && endpoint.length > 4 && bond >= 100

  function toggle(set: Set<string>, id: string, setter: (s: Set<string>) => void) {
    const next = new Set(set)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setter(next)
  }

  if (done) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center px-4 py-20 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[var(--s-accent-soft)]">
          <span className="i-ph:hard-drives text-[36px] text-[var(--s-accent)]" />
        </div>
        <h2 className="mt-4 font-display text-[22px] font-bold text-[var(--s-text)]">Registration submitted</h2>
        <p className="mt-1.5 font-body text-[13px] text-[var(--s-text-muted)]">
          <span className="font-semibold text-[var(--s-text-secondary)]">{name}</span> is registering on-chain with a {usd(bond, 0)} bond.
          Your venue comes live once the service request is approved.
        </p>
        <button onClick={() => navigate('/operators')} className="btn-primary mt-5 h-11 w-full max-w-xs !text-[13px]">
          View operators
        </button>
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="Register as an operator"
        subtitle="Run a venue that quotes both sides and fulfills redemptions. Post a bond, declare capacity, and the blueprint registers you on Tangle."
      />

      <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
        <div className="space-y-5">
          <Field label="Display name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. h100farm"
              className="h-11 w-full rounded-[6px] border border-[var(--s-border)] bg-[var(--s-surface)] px-3 font-data text-[13px] text-[var(--s-text)] outline-none placeholder:text-[var(--s-text-subtle)] focus:border-[var(--s-border-hover)]"
            />
          </Field>

          <Field label="Source venues you can fulfill through">
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {venueList.map((v) => {
                const active = venues.has(v.id)
                return (
                  <button
                    key={v.id}
                    onClick={() => toggle(venues, v.id, setVenues)}
                    className={cn(
                      'flex items-center gap-2 rounded-[6px] border px-2.5 py-2 transition-colors',
                      active ? 'border-[var(--s-accent)] bg-[var(--s-accent-soft)]' : 'border-[var(--s-border)] hover:border-[var(--s-border-hover)]',
                    )}
                  >
                    <span className="h-2 w-2 rounded-full" style={{ background: v.hue }} />
                    <span className="truncate font-data text-[11px] text-[var(--s-text-secondary)]">{v.name}</span>
                  </button>
                )
              })}
            </div>
          </Field>

          <Field label="Model families you serve">
            <div className="flex flex-wrap gap-2">
              {labList.map((l) => {
                const active = labs.has(l.id)
                return (
                  <button
                    key={l.id}
                    onClick={() => toggle(labs, l.id, setLabs)}
                    className={cn(
                      'flex items-center gap-1.5 rounded-[6px] border px-2.5 py-1.5 transition-colors',
                      active ? 'border-[var(--s-accent)] bg-[var(--s-accent-soft)]' : 'border-[var(--s-border)] hover:border-[var(--s-border-hover)]',
                    )}
                  >
                    <Mark hue={l.hue} glyph={l.glyph} label={l.name} size={18} />
                    <span className="font-data text-[12px] text-[var(--s-text-secondary)]">{l.name}</span>
                  </button>
                )
              })}
            </div>
          </Field>

          <Field label="Reachability" hint="Tor onion keeps sellers from being correlated">
            <Segmented
              value={reach}
              onChange={setReach}
              options={[
                { value: 'clearnet', label: 'Clearnet HTTPS' },
                { value: 'onion', label: 'Tor onion' },
              ]}
            />
            <div className="mt-2 flex h-11 items-center rounded-[6px] border border-[var(--s-border)] bg-[var(--s-surface)] px-3">
              <span className={cn(reach === 'onion' ? 'i-ph:plugs-connected' : 'i-ph:link-simple', 'mr-2 text-[15px] text-[var(--s-text-muted)]')} />
              <input
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                placeholder={reach === 'onion' ? 'xxxxxxxx…onion' : 'https://venue.example.com'}
                className="w-full bg-transparent font-data text-[13px] text-[var(--s-text)] outline-none placeholder:text-[var(--s-text-subtle)]"
              />
            </div>
          </Field>

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <Field label="Bond" hint={<span className="text-[var(--s-text-secondary)]">{usd(bond, 0)}</span>}>
              <input
                type="range"
                className="s-range mt-2 w-full"
                style={{ background: `linear-gradient(90deg, var(--s-accent) ${((bond - 1000) / (200000 - 1000)) * 100}%, var(--s-border) ${((bond - 1000) / (200000 - 1000)) * 100}%)` }}
                min={1000}
                max={200000}
                step={1000}
                value={bond}
                onChange={(e) => setBond(Number(e.target.value))}
              />
              <div className="mt-1.5 flex justify-between font-data text-[10px] text-[var(--s-text-subtle)]">
                <span>$1K</span>
                <span>$100K</span>
                <span>$200K</span>
              </div>
            </Field>
            <Field label="Maker fee" hint={<span className="text-[var(--s-text-secondary)]">{(feeBps / 100).toFixed(2)}%</span>}>
              <input
                type="range"
                className="s-range mt-2 w-full"
                style={{ background: `linear-gradient(90deg, var(--s-accent) ${(feeBps / 500) * 100}%, var(--s-border) ${(feeBps / 500) * 100}%)` }}
                min={0}
                max={500}
                step={5}
                value={feeBps}
                onChange={(e) => setFeeBps(Number(e.target.value))}
              />
              <div className="mt-1.5 flex justify-between font-data text-[10px] text-[var(--s-text-subtle)]">
                <span>0%</span>
                <span>2.5%</span>
                <span>5%</span>
              </div>
            </Field>
          </div>

          <div className="flex items-start gap-2.5 rounded-[6px] border border-[var(--s-divider)] bg-[var(--s-surface)] px-3.5 py-3">
            <span className="i-ph:shield-check-fill mt-0.5 shrink-0 text-[18px] text-[var(--s-accent)]" />
            <p className="font-body text-[12px] leading-snug text-[var(--s-text-muted)]">
              Your bond backs the credits you mint. Fail to serve a valid redemption and the buyer is made whole from it —
              plus a restake slash through the blueprint. <span className="text-[var(--s-text-secondary)]">Serve reliably and it's fully yours.</span>
            </p>
          </div>

          <button onClick={() => setDone(true)} disabled={!ready} className="btn-primary h-12 w-full !text-[14px]">
            {ready ? 'Register operator' : 'Complete the fields above'}
          </button>
          <div className="flex items-center justify-center gap-2">
            <Badge icon="i-ph:cube">Base Sepolia</Badge>
            <span className="font-data text-[11px] text-[var(--s-text-muted)]">registration is one on-chain tx</span>
          </div>
        </div>
      </div>
    </div>
  )
}
