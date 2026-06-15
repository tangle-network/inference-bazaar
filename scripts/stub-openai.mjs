// Minimal OpenAI-compatible upstream for e2e: fixed completion, fixed usage.
// The spend rail meters usage.completion_tokens — 137 here, asserted on-chain.
import http from 'node:http'

const PORT = Number(process.env.PORT ?? 9911)
http
  .createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const parsed = JSON.parse(body)
        const model = parsed.model
        // Streaming path: OpenAI-style SSE chunks, then a final usage chunk (when
        // stream_options.include_usage), then [DONE] — so the operator tees the
        // usage and bills streamed requests exactly like buffered ones.
        if (parsed.stream) {
          res.setHeader('content-type', 'text/event-stream')
          const chunk = (delta, extra = {}) =>
            res.write(
              `data: ${JSON.stringify({
                id: 'chatcmpl-stub',
                object: 'chat.completion.chunk',
                model,
                choices: [{ index: 0, delta, finish_reason: extra.finish ?? null }],
                ...(extra.usage ? { usage: extra.usage } : {}),
              })}\n\n`,
            )
          chunk({ role: 'assistant', content: '' })
          for (const w of ['InferenceBazaar ', 'spend-rail ', 'stub ', 'reply.']) chunk({ content: w })
          chunk({}, { finish: 'stop' })
          if (parsed.stream_options?.include_usage) {
            res.write(
              `data: ${JSON.stringify({
                id: 'chatcmpl-stub',
                object: 'chat.completion.chunk',
                model,
                choices: [],
                usage: { prompt_tokens: 21, completion_tokens: 137, total_tokens: 158 },
              })}\n\n`,
            )
          }
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            id: 'chatcmpl-stub',
            object: 'chat.completion',
            model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'InferenceBazaar spend-rail stub reply.' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 21, completion_tokens: 137, total_tokens: 158 },
          }),
        )
      })
      return
    }
    res.statusCode = 404
    res.end()
  })
  .listen(PORT, '127.0.0.1', () => console.log(`stub-openai on :${PORT}`))
