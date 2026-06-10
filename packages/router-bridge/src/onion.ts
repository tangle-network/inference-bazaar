/**
 * Onion routing for the sell side.
 *
 * When a seller's surplus inference is redeemed, the request is fulfilled by
 * SOME operator on the router. If the router always picked the cheapest /
 * closest operator, a seller's flow would concentrate on a small set of
 * operators who could then correlate timing + volume to de-anonymize the
 * seller — exactly the linkage a shielded credit account is meant to break.
 *
 * Two mechanisms, composed:
 *  1. `selectCircuit` — anti-sticky relay selection. Picks N distinct relays,
 *     biased AWAY from relays this seller used recently (a decaying penalty),
 *     so consecutive redemptions spread across the operator set.
 *  2. `wrapOnion` / `peelOnion` — layered x25519 + HKDF + ChaCha20-Poly1305
 *     envelopes. Each relay decrypts exactly one layer, learning only the NEXT
 *     hop, never the origin or the final payload. The exit relay recovers the
 *     inference request; no single relay sees both who sent it and what it is.
 *
 * Primitives are Node's WebCrypto-adjacent `node:crypto` (x25519 ECDH, HKDF-
 * SHA256, ChaCha20-Poly1305 AEAD) — no third-party crypto dependency.
 */

import {
  createCipheriv,
  createDecipheriv,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  createPublicKey,
  createPrivateKey,
  randomBytes,
} from 'node:crypto'

const HKDF_INFO = Buffer.from('surplus-onion-v1')
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
/** x25519 SPKI DER is a fixed 44 bytes; we strip the 12-byte prefix to ship 32. */
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')

export interface Relay {
  /** Stable operator/relay id (router operator slug). */
  id: string
  /** Relay's long-term x25519 public key, raw 32 bytes hex. */
  publicKey: string
}

export interface RelayKeypair extends Relay {
  /** Raw 32-byte x25519 private scalar, hex. Held only by the relay. */
  privateKey: string
}

/** Generate a relay's long-term x25519 identity. */
export function generateRelayKeypair(id: string): RelayKeypair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  return {
    id,
    publicKey: rawPublicHex(publicKey),
    privateKey: rawPrivateHex(privateKey),
  }
}

export interface CircuitSelectionOptions {
  relays: Relay[]
  /** Hops in the circuit (including exit). Typically 3. */
  length: number
  /** Relay ids used by this seller recently, most-recent-first. */
  recentRelayIds?: string[]
  /** Deterministic uniform source in [0,1). Inject for tests. */
  rand?: () => number
  /**
   * Per-occurrence penalty for a recently-used relay, multiplied by its
   * recency weight. 0 = no anti-stickiness; 1 = strong avoidance. Default 0.8.
   */
  stickinessPenalty?: number
}

/**
 * Choose `length` distinct relays, weighted away from recently-used ones.
 *
 * Weight(relay) = 1 − penalty·recencyWeight, floored at a small epsilon so a
 * fully-penalized relay is unlikely but not impossible (availability beats a
 * perfect avoid). recencyWeight decays linearly with position in
 * `recentRelayIds` — the last relay used is penalized most.
 */
export function selectCircuit(opts: CircuitSelectionOptions): Relay[] {
  const { relays, length } = opts
  if (length <= 0) throw new Error('circuit length must be > 0')
  if (relays.length < length) {
    throw new Error(`need >= ${length} relays for a circuit, have ${relays.length}`)
  }
  const rand = opts.rand ?? Math.random
  const penalty = opts.stickinessPenalty ?? 0.8
  const recent = opts.recentRelayIds ?? []
  const recencyWeight = new Map<string, number>()
  recent.forEach((id, index) => {
    // Most-recent (index 0) → weight 1; older → linearly less. Keep the max if
    // a relay appears multiple times.
    const w = 1 - index / Math.max(recent.length, 1)
    recencyWeight.set(id, Math.max(recencyWeight.get(id) ?? 0, w))
  })

  const pool = relays.map((relay) => ({
    relay,
    weight: Math.max(0.02, 1 - penalty * (recencyWeight.get(relay.id) ?? 0)),
  }))

  const chosen: Relay[] = []
  for (let hop = 0; hop < length; hop += 1) {
    const total = pool.reduce((sum, p) => sum + p.weight, 0)
    let target = rand() * total
    let pickIndex = pool.length - 1
    for (let i = 0; i < pool.length; i += 1) {
      target -= pool[i]!.weight
      if (target <= 0) {
        pickIndex = i
        break
      }
    }
    chosen.push(pool[pickIndex]!.relay)
    pool.splice(pickIndex, 1) // distinct hops
  }
  return chosen
}

export interface OnionMessage {
  /** Sender's ephemeral x25519 public key for THIS layer, raw 32-byte hex. */
  ephemeralPublicKey: string
  iv: string
  ciphertext: string
  tag: string
}

interface LayerPlaintext {
  /** Next relay id to forward to, or null at the exit. */
  next: string | null
  /** Inner onion (for relays) or the final payload (at the exit), base64. */
  payload: string
}

/**
 * Wrap `payload` for a circuit so each relay peels one layer. The returned
 * message is handed to `circuit[0]`; each relay calls `peelOnion` with its
 * private key, learns its `next` hop, and forwards the inner message.
 */
export function wrapOnion(circuit: Relay[], payload: Uint8Array): OnionMessage {
  if (circuit.length === 0) throw new Error('empty circuit')
  // Build inside-out: exit layer first.
  let inner = Buffer.from(payload)
  let message: OnionMessage | undefined
  for (let hop = circuit.length - 1; hop >= 0; hop -= 1) {
    const relay = circuit[hop]!
    const next = hop === circuit.length - 1 ? null : circuit[hop + 1]!.id
    const layer: LayerPlaintext = { next, payload: inner.toString('base64') }
    message = sealLayer(relay.publicKey, Buffer.from(JSON.stringify(layer)))
    inner = Buffer.from(JSON.stringify(message))
  }
  return message!
}

export interface PeelResult {
  /** Next relay id, or null if this relay is the exit. */
  next: string | null
  /** Inner onion to forward (next !== null) or the final payload (next === null). */
  payload: Buffer
}

/** A relay peels its layer: ECDH against the sender's ephemeral key, decrypt. */
export function peelOnion(privateKeyHex: string, message: OnionMessage): PeelResult {
  const priv = privateKeyFromRawHex(privateKeyHex)
  const ephemeral = publicKeyFromRawHex(message.ephemeralPublicKey)
  const shared = diffieHellman({ privateKey: priv, publicKey: ephemeral })
  const key = hkdfSync('sha256', shared, Buffer.alloc(0), HKDF_INFO, KEY_BYTES)
  const decipher = createDecipheriv(
    'chacha20-poly1305',
    Buffer.from(key),
    Buffer.from(message.iv, 'hex'),
    { authTagLength: TAG_BYTES },
  )
  decipher.setAuthTag(Buffer.from(message.tag, 'hex'))
  const plain = Buffer.concat([
    decipher.update(Buffer.from(message.ciphertext, 'hex')),
    decipher.final(),
  ])
  const layer = JSON.parse(plain.toString()) as LayerPlaintext
  return { next: layer.next, payload: Buffer.from(layer.payload, 'base64') }
}

function sealLayer(recipientPublicHex: string, plaintext: Buffer): OnionMessage {
  const ephemeral = generateKeyPairSync('x25519')
  const recipient = publicKeyFromRawHex(recipientPublicHex)
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient })
  const key = hkdfSync('sha256', shared, Buffer.alloc(0), HKDF_INFO, KEY_BYTES)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('chacha20-poly1305', Buffer.from(key), iv, {
    authTagLength: TAG_BYTES,
  })
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return {
    ephemeralPublicKey: rawPublicHex(ephemeral.publicKey),
    iv: iv.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
  }
}

// ── x25519 raw-key <-> KeyObject helpers ──────────────────────────────────────
// node:crypto only imports/exports x25519 keys as DER; the wire format here is
// the raw 32-byte scalar/point, so we splice the fixed DER prefixes.

function rawPublicHex(key: KeyObject): string {
  const der = key.export({ type: 'spki', format: 'der' })
  return Buffer.from(der.subarray(der.length - 32)).toString('hex')
}

function rawPrivateHex(key: KeyObject): string {
  const der = key.export({ type: 'pkcs8', format: 'der' })
  return Buffer.from(der.subarray(der.length - 32)).toString('hex')
}

function publicKeyFromRawHex(hex: string): KeyObject {
  const raw = Buffer.from(hex, 'hex')
  if (raw.length !== 32) throw new Error(`x25519 public key must be 32 bytes, got ${raw.length}`)
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  })
}

const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')

function privateKeyFromRawHex(hex: string): KeyObject {
  const raw = Buffer.from(hex, 'hex')
  if (raw.length !== 32) throw new Error(`x25519 private key must be 32 bytes, got ${raw.length}`)
  return createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, raw]),
    format: 'der',
    type: 'pkcs8',
  })
}
