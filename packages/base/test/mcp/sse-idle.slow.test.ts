import { createServer, type Server, type ServerResponse } from 'node:http'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { createDeploymentFetch } from '@agnes/system-node/deployment-network'
import { afterEach, expect, it } from 'vitest'

const servers: Server[] = []
const clients: ReturnType<typeof createDeploymentFetch>[] = []

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        }),
    ),
  )
})

async function listen(server: Server): Promise<string> {
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No fixture port')
  return `http://127.0.0.1:${address.port}`
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

it('keeps a quiet MCP SSE stream open past the deployment idle and request deadlines', async () => {
  let gets = 0
  let held: ServerResponse | undefined
  const endpoint = await listen(
    createServer((request, response) => {
      if (request.method === 'GET') {
        gets += 1
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        response.write('event: endpoint\ndata: /message\n\n')
        held = response
        request.on('close', () => response.end())
        return
      }
      response.writeHead(202).end()
    }),
  )
  const network = createDeploymentFetch({ streamIdleMs: 30, requestMs: 80 }, {})
  clients.push(network)
  const transport = new SSEClientTransport(new URL(endpoint), { fetch: network.fetch })
  const messages: unknown[] = []
  const errors: unknown[] = []
  transport.onmessage = (message) => messages.push(message)
  transport.onerror = (error) => errors.push(error)
  try {
    await transport.start()
    await wait(150)
    expect(gets).toBe(1)
    expect(errors).toEqual([])
    held?.write(
      `data: ${JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { progressToken: 'token', progress: 1 },
      })}\n\n`,
    )
    await wait(50)
    expect(messages).toEqual([
      {
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { progressToken: 'token', progress: 1 },
      },
    ])
    expect(gets).toBe(1)
  } finally {
    await transport.close()
  }
})
