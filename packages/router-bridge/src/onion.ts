/**
 * Onion routing for the sell side.
 *
 * When a seller's surplus inference is redeemed, the request is fulfilled by
 * SOME operator on the router. If the router always picked the cheapest /
 * closest operator, a seller's flow would concentrate on a small set of
 * operators who could then correlate timing + volume to de-anonymize the
 * seller — exactly the linkage a shielded credit account is meant to break.
 *
 * This module is the crypto core. Three composed mechanisms:
 *  1. `selectCircuit` — anti-sticky relay selection. Picks N distinct relays,
 *     biased AWAY from relays this seller used recently (a decaying penalty),
 *     so consecutive redemptions spread across the operator set.
 *  2. `wrapOnion` / `peelOnion` — layered x25519 + HKDF + ChaCha20-Poly1305
 *     request envelopes. Each relay decrypts exactly one layer, learning only
 *     the NEXT hop, never the origin or the final payload. The exit relay
 *     recovers the request; no single relay sees both who sent it and what it is.
 *  3. `sealReply` / `openReply` — the RETURN path. `wrapOnion` hands the sender
 *     the per-hop AEAD keys; each relay re-encrypts the response under its key
 *     on the way back, and only the original sender — who holds every hop key —
 *     can peel the layered response. The response is bound to the same circuit
 *     without any relay learning both endpoints.
 *
 * Plus `padToCell` / `unpadCell`: payloads are padded to a fixed cell size so
 * the onion's length does not leak the request/response content size.
 *
 * Primitives are Node's `node:crypto` (x25519 ECDH, HKDF-SHA256, ChaCha20-
 * Poly1305 AEAD) — no third-party crypto dependency.
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
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')

/** Cell granularity for length-padding, bytes. Hides exact content length. */
export const CELL_SIZE = 2048

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

// ── Circuit selection ─────────────────────────────────────────────────────────

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

// ── Forward path ──────────────────────────────────────────────────────────────

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

export interface WrappedOnion {
  /** The message handed to `circuit[0]`. */
  message: OnionMessage
  /**
   * Per-hop AEAD keys, `hopKeys[i]` shared with `circuit[i]`. The sender keeps
   * these to peel the layered response (`openReply`). They never leave the
   * sender — each relay re-derives only its own key from the forward onion.
   */
  hopKeys: Buffer[]
}

/**
 * Wrap `payload` for a circuit so each relay peels one layer on the way out.
 * Returns the message for `circuit[0]` plus the per-hop keys the sender uses to
 * unwrap the response. Pad `payload` with `padToCell` first to hide its length.
 */
export function wrapOnion(circuit: Relay[], payload: Uint8Array): WrappedOnion {
  if (circuit.length === 0) throw new Error('empty circuit')
  // Build inside-out: exit layer first. Capture each hop's derived key.
  let inner = Buffer.from(payload)
  let message: OnionMessage | undefined
  const hopKeys: Buffer[] = new Array(circuit.length)
  for (let hop = circuit.length - 1; hop >= 0; hop -= 1) {
    const relay = circuit[hop]!
    const next = hop === circuit.length - 1 ? null : circuit[hop + 1]!.id
    const layer: LayerPlaintext = { next, payload: inner.toString('base64') }
    const sealed = sealLayer(relay.publicKey, Buffer.from(JSON.stringify(layer)))
    hopKeys[hop] = sealed.key
    message = sealed.message
    inner = Buffer.from(JSON.stringify(message))
  }
  return { message: message!, hopKeys }
}

export interface PeelResult {
  /** Next relay id, or null if this relay is the exit. */
  next: string | null
  /** Inner onion to forward (next !== null) or the final payload (next === null). */
  payload: Buffer
  /**
   * The AEAD key this relay derived for the layer. The relay uses it to seal
   * the response on the return path (`sealReply`); it is the SAME key the
   * sender holds in `hopKeys` for this hop, so the sender can peel that layer.
   */
  layerKey: Buffer
}

/** A relay peels its forward layer: ECDH against the sender's ephemeral key. */
export function peelOnion(privateKeyHex: string, message: OnionMessage): PeelResult {
  const priv = privateKeyFromRawHex(privateKeyHex)
  const ephemeral = publicKeyFromRawHex(message.ephemeralPublicKey)
  const shared = diffieHellman({ privateKey: priv, publicKey: ephemeral })
  const key = deriveLayerKey(shared)
  const plain = aeadOpen(key, message.iv, message.ciphertext, message.tag)
  const layer = JSON.parse(plain.toString()) as LayerPlaintext
  return { next: layer.next, payload: Buffer.from(layer.payload, 'base64'), layerKey: key }
}

function sealLayer(
  recipientPublicHex: string,
  plaintext: Buffer,
): { message: OnionMessage; key: Buffer } {
  const ephemeral = generateKeyPairSync('x25519')
  const recipient = publicKeyFromRawHex(recipientPublicHex)
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient })
  const key = deriveLayerKey(shared)
  const sealed = aeadSeal(key, plaintext)
  return {
    message: { ephemeralPublicKey: rawPublicHex(ephemeral.publicKey), ...sealed },
    key,
  }
}

// ── Return path ───────────────────────────────────────────────────────────────

/** One symmetric reply layer. No ephemeral key — the hop key is already shared. */
export interface ReplyCell {
  iv: string
  ciphertext: string
  tag: string
}

/** A relay (or the exit) seals a response layer under its hop key. */
export function sealReply(hopKey: Buffer, plaintext: Uint8Array): ReplyCell {
  return aeadSeal(hopKey, Buffer.from(plaintext))
}

/** Peel one reply layer with a single hop key. */
export function openReplyLayer(hopKey: Buffer, cell: ReplyCell): Buffer {
  return aeadOpen(hopKey, cell.iv, cell.ciphertext, cell.tag)
}

/** Serialize a reply cell so an intermediate relay can seal it in its own layer. */
export function encodeReplyCell(cell: ReplyCell): Buffer {
  return Buffer.from(JSON.stringify(cell))
}

export function decodeReplyCell(bytes: Buffer): ReplyCell {
  return JSON.parse(bytes.toString()) as ReplyCell
}

/**
 * Sender-side: peel the fully-layered response. The outermost layer was sealed
 * by `circuit[0]`, the innermost by the exit, so we peel `hopKeys` in order.
 * Each non-final layer reveals the next relay's encoded reply cell; the final
 * layer reveals the exit's plaintext response (still cell-padded).
 */
export function openReply(hopKeys: Buffer[], outer: ReplyCell): Buffer {
  if (hopKeys.length === 0) throw new Error('no hop keys')
  let cell = outer
  for (let i = 0; i < hopKeys.length; i += 1) {
    const inner = openReplyLayer(hopKeys[i]!, cell)
    if (i === hopKeys.length - 1) return inner
    cell = decodeReplyCell(inner)
  }
  /* c8 ignore next */
  throw new Error('unreachable')
}

// ── Length padding ────────────────────────────────────────────────────────────

/** Length-prefix and zero-pad `data` up to a multiple of `cellSize`. */
export function padToCell(data: Uint8Array, cellSize = CELL_SIZE): Buffer {
  if (data.length > 0xffffffff) throw new Error('payload too large to cell-pad')
  const total = 4 + data.length
  const padded = Math.max(cellSize, Math.ceil(total / cellSize) * cellSize)
  const out = Buffer.alloc(padded)
  out.writeUInt32BE(data.length, 0)
  Buffer.from(data).copy(out, 4)
  return out
}

/** Recover the original payload from a cell-padded buffer. */
export function unpadCell(padded: Buffer): Buffer {
  if (padded.length < 4) throw new Error('cell too short')
  const len = padded.readUInt32BE(0)
  if (len > padded.length - 4) throw new Error('cell length header exceeds buffer')
  return padded.subarray(4, 4 + len)
}

// ── AEAD + key derivation ─────────────────────────────────────────────────────

function deriveLayerKey(sharedSecret: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', sharedSecret, Buffer.alloc(0), HKDF_INFO, KEY_BYTES))
}

function aeadSeal(key: Buffer, plaintext: Buffer): { iv: string; ciphertext: string; tag: string } {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('chacha20-poly1305', key, iv, { authTagLength: TAG_BYTES })
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return {
    iv: iv.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
  }
}

function aeadOpen(key: Buffer, ivHex: string, ciphertextHex: string, tagHex: string): Buffer {
  const decipher = createDecipheriv('chacha20-poly1305', key, Buffer.from(ivHex, 'hex'), {
    authTagLength: TAG_BYTES,
  })
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  return Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()])
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

function privateKeyFromRawHex(hex: string): KeyObject {
  const raw = Buffer.from(hex, 'hex')
  if (raw.length !== 32) throw new Error(`x25519 private key must be 32 bytes, got ${raw.length}`)
  return createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, raw]),
    format: 'der',
    type: 'pkcs8',
  })
}
