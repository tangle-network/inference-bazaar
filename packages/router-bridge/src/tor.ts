/**
 * Tor transport via Arti.
 *
 * Privacy on the sell side is delegated to Tor — the real anonymity network —
 * not to anything hand-rolled here. The production deployment runs Arti
 * (`arti-client`, the Tor Project's Rust Tor implementation) as a local SOCKS5
 * proxy; this transport opens a stream THROUGH that proxy to the fulfilling
 * operator. Operators are reached either as Tor onion services (`http://<...>.onion`)
 * or as clearnet HTTPS via a Tor exit. Either way the operator never learns the
 * seller's IP and no on-path observer links the two.
 *
 * What lives here is only the SOCKS5 client + HTTP-over-tunnel plumbing (RFC
 * 1928 — a plain wire protocol, not cryptography). All anonymity, relay
 * selection, circuit construction, guard nodes, and directory consensus are
 * Arti/Tor's job. Point `socksPort` at Arti's SOCKS listener (default 9150).
 */

import { connect as netConnect, type Socket } from 'node:net'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as tlsConnect } from 'node:tls'

export interface TorConfig {
  /** Arti SOCKS proxy host. Default 127.0.0.1. */
  socksHost?: string
  /** Arti SOCKS proxy port (Arti default 9150). */
  socksPort: number
  /** Per-request timeout, ms. Default 30_000 (Tor is not fast). */
  requestTimeoutMs?: number
}

export interface TorResponse {
  status: number
  body: Buffer
}

export interface TorRequestInit {
  method?: string
  headers?: Record<string, string>
  body?: Uint8Array
}

/** HTTP(S) transport that tunnels every request through Arti's SOCKS5 proxy. */
export class TorTransport {
  private readonly socksHost: string
  private readonly socksPort: number
  private readonly timeoutMs: number

  constructor(cfg: TorConfig) {
    this.socksHost = cfg.socksHost ?? '127.0.0.1'
    this.socksPort = cfg.socksPort
    this.timeoutMs = cfg.requestTimeoutMs ?? 30_000
  }

  async fetch(target: string, init: TorRequestInit = {}): Promise<TorResponse> {
    const url = new URL(target)
    const isHttps = url.protocol === 'https:'
    const destPort = url.port ? Number(url.port) : isHttps ? 443 : 80
    const tunnel = await socks5Connect({
      socksHost: this.socksHost,
      socksPort: this.socksPort,
      destHost: url.hostname,
      destPort,
      timeoutMs: this.timeoutMs,
    })

    const requestFn = isHttps ? httpsRequest : httpRequest
    return await new Promise<TorResponse>((resolve, reject) => {
      const req = requestFn(
        target,
        {
          method: init.method ?? 'GET',
          // One request per tunnel: close the connection when done so the
          // SOCKS stream is released rather than held open by keep-alive.
          headers: { connection: 'close', ...init.headers },
          // `agent: false` so our `createConnection` is honored instead of the
          // global agent's. Reuse the SOCKS-tunneled socket as the HTTP(S)
          // connection; for HTTPS, run TLS end-to-end over the tunnel.
          agent: false,
          createConnection: () =>
            isHttps ? tlsConnect({ socket: tunnel, servername: url.hostname }) : tunnel,
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => {
            tunnel.destroy()
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) })
          })
        },
      )
      req.on('error', (err) => {
        tunnel.destroy()
        reject(err)
      })
      if (init.body) req.write(Buffer.from(init.body))
      req.end()
    })
  }
}

interface Socks5ConnectOptions {
  socksHost: string
  socksPort: number
  destHost: string
  destPort: number
  timeoutMs: number
}

/**
 * Open a SOCKS5 CONNECT tunnel and resolve the connected socket (RFC 1928,
 * no-auth method 0x00 — Arti's default). The destination host is sent as a
 * domain name (ATYP 0x03), so `.onion` addresses are resolved by Tor, never
 * locally.
 */
export function socks5Connect(opts: Socks5ConnectOptions): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = netConnect({ host: opts.socksHost, port: opts.socksPort })
    let settled = false
    const fail = (err: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      reject(err)
    }
    const timer = setTimeout(() => fail(new Error('SOCKS5 connect timed out')), opts.timeoutMs)
    socket.once('error', fail)

    socket.once('connect', () => {
      // Greeting: VER=5, NMETHODS=1, METHODS=[0x00 no-auth].
      socket.write(Buffer.from([0x05, 0x01, 0x00]))
      // One accumulating handler drives the whole handshake: read the greeting
      // reply, send CONNECT, read the variable-length CONNECT reply, then hand
      // the socket off — pushing back any bytes that arrived past the reply so
      // the HTTP layer reads them cleanly. (Chained per-read listeners + unshift
      // drop bytes across listener swaps; one handler does not.)
      let buf = Buffer.alloc(0)
      let phase: 'greeting' | 'reply' = 'greeting'
      const onData = (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk])
        if (phase === 'greeting') {
          if (buf.length < 2) return
          if (buf[0] !== 0x05 || buf[1] !== 0x00) return fail(new Error('SOCKS5 rejected no-auth'))
          buf = buf.subarray(2)
          const host = Buffer.from(opts.destHost, 'ascii')
          if (host.length > 255) return fail(new Error('destination host too long for SOCKS5'))
          const port = Buffer.from([(opts.destPort >> 8) & 0xff, opts.destPort & 0xff])
          // CONNECT: VER=5, CMD=1, RSV=0, ATYP=3 (domain), LEN, HOST, PORT.
          socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host, port]))
          phase = 'reply'
        }
        if (phase === 'reply') {
          const total = socksReplyLength(buf)
          if (total === null) return // need more bytes
          if (total < 0) return fail(new Error(`unknown SOCKS5 reply ATYP ${buf[3]}`))
          if (buf[0] !== 0x05) return fail(new Error('bad SOCKS5 reply version'))
          if (buf[1] !== 0x00) return fail(new Error(`SOCKS5 CONNECT failed (code ${buf[1]})`))
          if (buf.length < total) return
          settled = true
          clearTimeout(timer)
          socket.removeListener('data', onData)
          socket.removeListener('error', fail)
          const leftover = buf.subarray(total)
          if (leftover.length) socket.unshift(leftover)
          resolve(socket)
        }
      }
      socket.on('data', onData)
    })
  })
}

/** Total byte length of a SOCKS5 CONNECT reply, or null if more bytes are
 *  needed, or -1 for an unknown ATYP. Reply = VER REP RSV ATYP BND.ADDR BND.PORT. */
function socksReplyLength(buf: Buffer): number | null {
  if (buf.length < 4) return null
  const atyp = buf[3]
  if (atyp === 0x01) return 4 + 4 + 2
  if (atyp === 0x04) return 4 + 16 + 2
  if (atyp === 0x03) {
    if (buf.length < 5) return null
    return 4 + 1 + buf[4]! + 2
  }
  return -1
}
