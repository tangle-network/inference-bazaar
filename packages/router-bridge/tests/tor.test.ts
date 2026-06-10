import { type AddressInfo, createServer as createTcpServer, connect as netConnect } from 'node:net'
import { createServer as createHttpServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { OperatorMemory } from '../src/memory'
import { TorRedemptionClient } from '../src/redemption'
import { TorTransport } from '../src/tor'

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Minimal in-process SOCKS5 CONNECT proxy (RFC 1928, no-auth) standing in for
 * Arti's SOCKS listener. It speaks the SAME wire protocol Arti speaks, so the
 * TorTransport SOCKS5 handshake is exercised for real — only the anonymity
 * network behind it is replaced by a direct pipe (we don't contact live Tor).
 */
function startSocks5Stub(): Promise<{ port: number; close: () => Promise<void>; connects: string[] }> {
  const connects: string[] = []
  const server = createTcpServer((client) => {
    let stage: 'greeting' | 'request' | 'piping' = 'greeting'
    let buf = Buffer.alloc(0)
    client.on('data', (chunk: Buffer) => {
      if (stage === 'piping') return
      buf = Buffer.concat([buf, chunk])
      if (stage === 'greeting') {
        if (buf.length < 2) return
        const nmethods = buf[1]!
        if (buf.length < 2 + nmethods) return
        buf = buf.subarray(2 + nmethods)
        client.write(Buffer.from([0x05, 0x00])) // no-auth
        stage = 'request'
      }
      if (stage === 'request') {
        if (buf.length < 4) return
        const atyp = buf[3]!
        let host: string
        let offset: number
        if (atyp === 0x03) {
          const len = buf[4]!
          if (buf.length < 5 + len + 2) return
          host = buf.subarray(5, 5 + len).toString('ascii')
          offset = 5 + len
        } else if (atyp === 0x01) {
          if (buf.length < 4 + 4 + 2) return
          host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`
          offset = 4 + 4
        } else {
          client.destroy()
          return
        }
        const port = (buf[offset]! << 8) | buf[offset + 1]!
        connects.push(`${host}:${port}`)
        const upstream = netConnect({ host, port }, () => {
          // Success reply with a dummy bound addr (ATYP=1, 0.0.0.0:0).
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
          stage = 'piping'
          const rest = buf.subarray(offset + 2)
          if (rest.length) upstream.write(rest)
          client.pipe(upstream)
          upstream.pipe(client)
        })
        upstream.on('error', () => client.destroy())
      }
    })
    client.on('error', () => {})
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        port,
        connects,
        close: () => new Promise<void>((r) => server.close(() => r())),
      })
    })
  })
}

function startEchoOperator(label: string): Promise<{ url: string; close: () => Promise<void>; server: Server }> {
  const server = createHttpServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString()
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(`${label}:${body}`)
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({ url: `http://127.0.0.1:${port}`, server, close: () => new Promise<void>((r) => server.close(() => r())) })
    })
  })
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

describe('TorTransport over a real SOCKS5 conversation', () => {
  it('tunnels an HTTP request to an operator through the SOCKS5 proxy', async () => {
    const socks = await startSocks5Stub()
    const op = await startEchoOperator('OP')
    cleanups.push(socks.close, op.close)

    const transport = new TorTransport({ socksPort: socks.port })
    const res = await transport.fetch(`${op.url}/onion`, {
      method: 'POST',
      body: Buffer.from('hello-via-tor'),
    })
    expect(res.status).toBe(200)
    expect(res.body.toString()).toBe('OP:hello-via-tor')
    // The proxy — not the client — opened the connection to the operator.
    expect(socks.connects.length).toBe(1)
    expect(socks.connects[0]).toContain('127.0.0.1:')
  })
})

describe('TorRedemptionClient — private, anti-sticky redemption over Tor', () => {
  it('redeems through the selected operator and reaches it via the proxy', async () => {
    const socks = await startSocks5Stub()
    const a = await startEchoOperator('A')
    const b = await startEchoOperator('B')
    const c = await startEchoOperator('C')
    cleanups.push(socks.close, a.close, b.close, c.close)

    const transport = new TorTransport({ socksPort: socks.port })
    const client = new TorRedemptionClient({
      operators: [
        { id: 'A', url: a.url },
        { id: 'B', url: b.url },
        { id: 'C', url: c.url },
      ],
      transport,
      memory: new OperatorMemory(2),
      rand: mulberry32(5),
    })

    const seen = new Set<string>()
    for (let i = 0; i < 6; i += 1) {
      const result = await client.redeem('seller-commitment', '/v1/infer', Buffer.from(`req-${i}`))
      expect(result.status).toBe(200)
      expect(result.body.toString()).toBe(`${result.operator}:req-${i}`)
      seen.add(result.operator)
    }
    // Every request went through the proxy, and anti-stickiness spread the
    // redemptions across more than one operator.
    expect(socks.connects.length).toBe(6)
    expect(seen.size).toBeGreaterThan(1)
  })
})
