# Surplus marketplace UI — design rationale

The product is a market for **prepaid inference-token credits**. Sellers list
surplus inference (idle operators, over-bought prepaid packs from OpenRouter /
Venice / Anthropic / OpenAI / …); buyers buy it below list; operators make
markets. The tradeable instrument is `(model, tokenKind)` — output/input/cache
tokens of a specific model — priced as a discount to the model's router list
price (the reference, in micro-tsUSD per 1M tokens).

Design language is the ai-trading-blueprints arena's **Obsidian Terminal**,
hex-for-hex: obsidian blue-black depth layers (`#0A0A0F → #22222E`), violet
primary actions (`#A370FF`, translucent fills + glow), electric emerald
`#00FF88` gains / crimson `#FF4D6A` losses / amber `#FFB800` highlights,
glass-card surfaces (backdrop blur + hairline borders), the arena mesh
gradient + noise grain, `IBM Plex Mono` tabular numerals, `Outfit` display.
The whole app reads `--s-*` tokens, so light/dark is one attribute flip.

Shared components, not look-alikes: `Identicon` (blo) from
`@tangle-network/blueprint-ui/components` for sellers/operators/wallet; the
wallet is REAL — wagmi + ConnectKit via blueprint-ui's `Web3Shell` +
`defaultConnectKitOptions`, chains Base Sepolia (where the Surplus blueprint
and settlement contracts live) + Tangle testnet/mainnet, with balance, chain
state, switch, copy, explorer, disconnect. Charts are chart.js
(react-chartjs-2) with gradient area fills — the instrument chart plots the
market price against the dashed list-price reference so the discount is the
visible gap; table sparklines are the same component at row scale.

Below: every page, the layouts considered, the choice, and **why**.

---

## Information architecture

Left-sidebar shell (arena's pattern): **Markets · Buy · Sell · Operators ·
Activity · Portfolio**. Two personas, one nav: buyers live in Markets→Buy;
sellers/operators live in Sell→Operators→Portfolio. Wallet + theme top-right.

Why a sidebar over a top nav: this is a tool people keep open and scan, not a
marketing site. A persistent rail keeps all six surfaces one click away and
leaves the full width for dense tables. A "Settlement live" reassurance card
pins the product's core promise (collateral-backed credits) in view everywhere.

---

## 1. Markets (home) — the market board

**Options weighed**
- **A. Dense terminal table**, one row per model — model, capabilities, best
  discount, best price, list, liquidity, 24h volume, venues, trend.
- **B. Card grid** of models with logo + headline discount + sparkline.
- **C. Hybrid**: a featured strip of "hottest" markets over the table.

**Chosen: C (table + featured strip).** A market is for *comparing many
instruments fast*. A mono, sortable, right-aligned-numeric table is the highest
information density and matches the terminal DNA — cards bury the numbers buyers
compare and waste vertical space. The featured strip (top discount, deepest
liquidity, 24h volume leader, totals) gives newcomers an entry point without
costing the scanner anything.

**The expand interaction** the brief asked for: clicking a model row opens an
inline **venue/operator sub-table** — every seller, the venue they fulfill
through, discount, price (in/out/cache), offered, sold, remaining, and a per-row
Buy. Inline expand = compare sellers without losing your place; an "Open market"
link goes to the full detail page for depth. **Capability filter chips** (text,
tools, reasoning, vision, image, audio, video, voice) are the primary navigation
verb — how a buyer narrows "vision model with tool-calling." Token-kind segmented
control (output/input/cache) reprices the whole board.

---

## 2. Model market (detail) — the trading terminal

**Options weighed**
- **A. Exchange instrument page**: orderbook + trades + chart + buy ticket.
- **B. Marketing-style model page** with a buy button.
- **C. Just the venue/operator table, bigger.**

**Chosen: A.** Once a buyer commits to a model, they want the market's depth.
Layout: stat strip (best discount, best price vs list, liquidity, 24h volume,
active offers, spread) → three columns: **order book** (depth bars, spread row),
**mid-price chart** (with the list price as a dashed reference line so the
discount is visceral) + **recent trades**, and the **cost-projection** card.
Full-width **offers table** (operators & venues) below.

**Why the projection slider is the hero.** Buyers don't think in "$/1M tokens" —
they think "I burn ~50M tokens/month, what's it cost?" The slider translates the
abstract market price into the buyer's real decision: a live **"you save
$X/month"** and a cost-vs-list bar. That's the compelling, legible hook, and it
ties straight to the settlement spine: the Buy CTA carries the guarantee —
*credits are claims on bonded operators; unserved spend is refunded in full plus
a penalty.*

---

## 3. Buy — focused firm-quote flow

**Options weighed**
- **A. Swap-widget drawer** on the market page (DEX style).
- **B. Dedicated, centered quote flow.**

**Chosen: B, with quick-buy drawers reachable from the table.** Buying credits
is a money commitment; it deserves a focused surface with a clear quote and
savings framing, not a cramped widget. Left: configuration (model picker,
token-kind, amount as slider + input, fulfillment route with **best-price
auto-route** or a specific venue). Right: the **firm-quote ticket** — price, list
strikethrough, discount, fulfilled-by, total, **save $X** badge, a **valid-120s
countdown**, and the collateral guarantee. Confirm → "credit lot minted."

**Why a firm quote with a countdown.** This *is* the RFQ rail from the settlement
contracts surfaced as UI: a signed, firm, time-boxed quote the buyer hits with no
slippage. The countdown makes "firm but time-boxed" legible; the guarantee line
makes "definitely get your spend" legible. The page teaches the product's trust
model by using it.

---

## 4. Sell — centered onboarding flow

**Options weighed**
- **A. Dense form** (all fields at once).
- **B. Numbered step wizard** (step 1/2/3 cards).
- **C. Centered single column, progressive reveal.**

**Chosen: C.** Selling is a deliberate, multi-decision commitment (you're
listing inventory and backing it), so it gets a calm, centered, framed flow — the
opposite of the scan-many terminal. Sections reveal as prior ones resolve, marked
by a check, **not** numbered step cards (procedural theater). Progression:
**venue** (your supply source, logo tiles) → **model** (scoped to that venue) →
**amount + discount** (slider with live effective price / your net) → **back the
supply**.

**Why "back the supply" is the crux** — it's the "actually get onboarded" part. A
credit must be redeemable, so the seller either **connects the source** (API key,
held by the fulfilling operator only for redemptions they sell) or **posts
collateral** (the trustless path; covers refund value + the 5% default penalty).
A live "what buyers will see" preview is always visible so the outcome is never
hidden. Listing signs an EIP-712 order — no gas until a buyer fills it.

---

## 5. Operators + registration

Operators are a distinct persona from resellers — infra providers who quote both
sides continuously and fulfill redemptions. **Operators** page: a leaderboard
(bond, venues, models, 7d served, fill rate, uptime, **slashes** with a clean
shield) — trust is the product here, so the table foregrounds reliability and
the slash record. **Register**: a focused form (name, source venues, model
families, **clearnet vs Tor onion** reachability for seller privacy, endpoint,
**bond** + **maker-fee** sliders) with the bond/slash contract stated plainly:
your bond backs the credits you mint; fail to serve and the buyer is made whole
from it plus a restake slash.

---

## 6. Portfolio + Activity (close the loop)

**Portfolio**: what you hold (credit lots — remaining/used, redeemable value,
expiry, **Redeem**) and what you're running (offers — sold %, projected net).
Holdings as cards (each lot is a distinct object with its own actions), offers as
a table (rows to scan). **Activity**: global fills feed + volume-by-market —
the market's pulse, and proof it's alive.

---

## Anti-slop checklist applied

- No numbered step cards — Sell/Buy express progress through revealed controls
  and selected states.
- No generic text boxes pretending to be everything — the token-kind segmented,
  amount slider, route radios, and provider tiles are each the right control for
  their decision.
- No dead panels — the Sell first viewport is framed with an always-on preview;
  empty states carry a real next action.
- Numbers are mono + tabular + right-aligned; `—` for null/zero; list prices
  shown struck-through next to the discounted price so savings are visceral.
- Real identity: per-lab and per-venue brand marks (hue + glyph), capability
  icons, verified-supply seals.

## Data seam

Everything renders from `src/lib/mock.ts`, a deterministic seeded dataset shaped
exactly like a real `@surplus/router-bridge` response. Each `getX()` is the swap
point: replace the body with a fetch to the operator venue API (`/book`, `/rfq`,
`/settlement/outbox`, …) and the UI is unchanged.
