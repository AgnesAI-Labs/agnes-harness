import { createServer } from 'node:http'

/** A real authenticated, stateless Streamable HTTP MCP peer. Never contacts external services. */
export async function startMcpHttpServer() {
  let accepted = ['fixture', 'old'].join('-')
  const calls: { method: string; name: string | null }[] = []
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/mcp') {
      response.writeHead(404).end()
      return
    }
    if (request.headers.authorization !== `Bearer ${accepted}`) {
      response.writeHead(401).end()
      return
    }
    try {
      const parts: Buffer[] = []
      let size = 0
      for await (const part of request) {
        size += part.length
        if (size > 1048576) {
          response.writeHead(413).end()
          return
        }
        parts.push(part)
      }
      const message = JSON.parse(Buffer.concat(parts).toString('utf8'))
      calls.push({ method: message.method, name: message.params?.name ?? null })
      if (message.method === 'notifications/initialized') {
        response.writeHead(202).end()
        return
      }
      let result: unknown
      if (message.method === 'initialize')
        result = {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: 'fixture', version: '1' },
        }
      else if (message.method === 'tools/list')
        result = {
          tools: ['echo', 'hang', 'state'].map((name) => ({ name, inputSchema: { type: 'object' } })),
        }
      else if (message.method === 'resources/read')
        result = { contents: [{ uri: message.params.uri, text: 'fixture-resource' }] }
      else if (message.method === 'tools/call') {
        if (message.params.name === 'hang') return
        if (!['echo', 'state'].includes(message.params.name)) {
          response.writeHead(400).end()
          return
        }
        result = {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ value: message.params.arguments?.value ?? null, pid: process.pid }),
            },
          ],
        }
      } else {
        response.writeHead(400).end()
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    } catch {
      response.writeHead(400).end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture address unavailable')
  return {
    port: address.port,
    calls: () => [...calls],
    rotate: () => {
      accepted = ['fixture', 'new'].join('-')
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      }),
  }
}
