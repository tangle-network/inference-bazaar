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
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            id: 'chatcmpl-stub',
            object: 'chat.completion',
            model: JSON.parse(body).model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'Surplus spend-rail stub reply.' },
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
