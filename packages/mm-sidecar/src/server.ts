import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { decideQuotes, parseQuoteRequest } from './quote'

/**
 * The MM sidecar HTTP server. The Rust operator runs this as a local sidecar
 * (the same pattern ai-trading-blueprint uses for its Claude sidecar) and calls
 * it each workflow tick. Two endpoints, no state, no auth — it binds to
 * localhost and is reached only by its parent operator process.
 *
 *   GET  /health  → { ok: true }
 *   POST /quote   → QuoteResponse (risk-gated quotes for one tick)
 */
export function createSidecarServer(): Server {
  return createServer((req, res) => {
    handle(req, res).catch((err) => sendJson(res, 500, { error: String(err) }))
  })
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, { ok: true })
  }
  if (req.method === 'POST' && req.url === '/quote') {
    let body: unknown
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      return sendJson(res, 400, { error: 'invalid JSON body' })
    }
    try {
      const decision = decideQuotes(parseQuoteRequest(body))
      return sendJson(res, 200, decision)
    } catch (err) {
      return sendJson(res, 422, { error: err instanceof Error ? err.message : String(err) })
    }
  }
  return sendJson(res, 404, { error: 'not found' })
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > 1_000_000) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(payload)
}

export interface ListeningSidecar {
  port: number
  close: () => Promise<void>
}

/** Start the sidecar on `port` (0 = ephemeral). Resolves with the bound port. */
export function listenSidecar(port: number, host = '127.0.0.1'): Promise<ListeningSidecar> {
  const server = createSidecarServer()
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const addr = server.address()
      if (addr === null || typeof addr === 'string') {
        reject(new Error('failed to bind sidecar'))
        return
      }
      resolve({ port: addr.port, close: () => new Promise<void>((r) => server.close(() => r())) })
    })
  })
}
