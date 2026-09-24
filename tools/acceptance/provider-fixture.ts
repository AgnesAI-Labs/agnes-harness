import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

/** Loopback-only deterministic provider used by real-process acceptance, never an external model. */
export async function startProviderFixture(
  reply = 'Shared backend acceptance reply.',
  initialTool?: { name: string; args: Record<string, unknown> },
  model = 'deepseek-v4-flash',
) {
  const apiKey = randomBytes(24).toString('hex')
  const queuedTools = initialTool ? [initialTool] : []
  const requests: Array<{ model: string; messages: unknown[] }> = []
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${apiKey}`) {
      response.writeHead(401).end('fixture authentication failed')
      return
    }
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ data: [{ id: model }] }))
      return
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString())
      if (!body || typeof body !== 'object' || !('model' in body) || !('messages' in body))
        throw new Error('missing fixture payload')
      if (body.model !== model || !Array.isArray(body.messages)) throw new Error('unexpected fixture model')
      requests.push({ model: body.model, messages: body.messages })
      // Background title requests have no tool catalog and must not consume the next test action.
      const available = 'tools' in body && Array.isArray(body.tools) ? body.tools : []
      const next = queuedTools[0]
      const tool =
        next && available.some((entry) => entry?.function?.name === next.name)
          ? queuedTools.shift()
          : undefined
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const event = {
        id: `shared-fixture-${requests.length}`,
        object: 'chat.completion.chunk',
        created: 0,
        model: body.model,
      }
      response.write(
        `data: ${JSON.stringify({ ...event, choices: [{ index: 0, delta: tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'acceptance-edit', type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : { role: 'assistant', content: reply }, finish_reason: null }] })}\n\n`,
      )
      response.end(
        `data: ${JSON.stringify({ ...event, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 } })}\n\ndata: [DONE]\n\n`,
      )
    } catch {
      if (!response.headersSent) response.writeHead(400)
      response.end('invalid fixture request')
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture listener unavailable')
  return {
    apiKey,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    queueTool: (tool: { name: string; args: Record<string, unknown> }) => queuedTools.push(tool),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}
