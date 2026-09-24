import { createServer } from 'node:http'

const server = createServer(async (request, response) => {
  const chunks = []
  for await (const _chunk of request) {
    chunks.push(_chunk)
  }
  const body = JSON.parse(Buffer.concat(chunks).toString())
  if (
    request.method !== 'POST' ||
    request.url !== '/v1/chat/completions' ||
    request.headers.authorization !== 'Bearer sea-smoke-key' ||
    body.model !== 'faux-1'
  ) {
    response.writeHead(400)
    response.end('unexpected production provider request')
    return
  }
  const event = {
    id: 'sea-smoke',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'faux-1',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'sea faux ok' }, finish_reason: null }],
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.write(`data: ${JSON.stringify(event)}\n\n`)
  response.write(
    `data: ${JSON.stringify({ ...event, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
  )
  response.end('data: [DONE]\n\n')
})

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('loopback server has no port')
  process.stdout.write(`${address.port}\n`)
})

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)))
