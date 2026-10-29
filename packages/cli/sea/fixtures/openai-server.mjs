import { createServer } from 'node:http'

// Inspect provider pixels independently of sharp: package read must have decoded and resized them.
function dimensions(url) {
  const bytes = Buffer.from(url.split(',')[1] ?? '', 'base64')
  if (url.startsWith('data:image/png;') && bytes.length >= 24)
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]
  if (!url.startsWith('data:image/jpeg;')) return []
  for (let offset = 2; offset + 9 < bytes.length; ) {
    if (bytes[offset++] !== 255) return []
    const marker = bytes[offset++]
    if ([192, 193, 194].includes(marker))
      return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)]
    const size = bytes.readUInt16BE(offset)
    if (size < 2) return []
    offset += size
  }
  return []
}

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
  let answer = 'sea faux ok'
  let tool
  if (JSON.stringify(body.messages).includes('SEA_IMAGE_SMOKE')) {
    const results = body.messages.filter((message) => message.role === 'tool')
    if (results.length) {
      const images = body.messages.flatMap((message) =>
        Array.isArray(message.content) ? message.content.filter((block) => block.type === 'image_url') : [],
      )
      const expectedMime = results.length === 1 ? 'image/png' : 'image/jpeg'
      if (
        !images.some((image) => image.image_url.url.startsWith(`data:${expectedMime};`)) ||
        images.some((image) => dimensions(image.image_url.url).join('x') !== '128x64')
      ) {
        response.writeHead(400)
        response.end('packaged image read did not return resized 128x64 pixels')
        return
      }
    }
    const format = results.length === 0 ? 'png' : results.length === 1 ? 'jpeg' : undefined
    if (format)
      tool = {
        index: 0,
        id: `sea-${format}`,
        type: 'function',
        function: { name: 'read', arguments: JSON.stringify({ path: `sea-image.${format}`, max_edge: 128 }) },
      }
    else answer = 'sea image smoke ok'
  }
  const event = {
    id: 'sea-smoke',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'faux-1',
    choices: [
      {
        index: 0,
        delta: tool ? { role: 'assistant', tool_calls: [tool] } : { role: 'assistant', content: answer },
        finish_reason: null,
      },
    ],
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.write(`data: ${JSON.stringify(event)}\n\n`)
  response.write(
    `data: ${JSON.stringify({ ...event, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
  )
  response.end('data: [DONE]\n\n')
})

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('loopback server has no port')
  process.stdout.write(`${address.port}\n`)
})

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)))
