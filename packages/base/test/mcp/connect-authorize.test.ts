import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectMcp, type McpHttpAuthorizer } from '../../src/mcp/connect.js'

// Untyped like the other fixtures in this folder: the SDK's server transport options are not
// exactOptionalPropertyTypes-clean.
const require = createRequire(import.meta.url)
const { Server: McpServer } = require('@modelcontextprotocol/sdk/server/index.js')
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js')
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js')
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js')

type Seen = Readonly<{ method: string | undefined; headers: Record<string, string | string[] | undefined> }>
/** Answers this status (with a bearer challenge) instead of passing the request on. */
type Refuse = (req: IncomingMessage) => 401 | 403 | undefined

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()))
})

function listen(server: HttpServer): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('missing fixture address')
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

function close(server: HttpServer): Promise<void> {
  server.closeAllConnections()
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
}

function mcpServer() {
  const mcp = new McpServer({ name: 'authorize-fixture', version: '1' }, { capabilities: { tools: {} } })
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: 'echo', inputSchema: { type: 'object' as const } }],
  }))
  mcp.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'ok' }] }))
  return mcp
}

function refused(res: ServerResponse, status: 401 | 403): void {
  res
    .writeHead(status, {
      'www-authenticate':
        status === 401 ? 'Bearer error="invalid_token"' : 'Bearer error="insufficient_scope", scope="more"',
    })
    .end()
}

async function startHttp(refuse: Refuse = () => undefined): Promise<{ url: string; seen: Seen[] }> {
  const mcp = mcpServer()
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  await mcp.connect(transport)
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    seen.push({ method: req.method, headers: { ...req.headers } })
    const status = refuse(req)
    if (status) return refused(res, status)
    void transport.handleRequest(req, res)
  })
  const origin = await listen(server)
  cleanup.push(async () => {
    await mcp.close()
    await close(server)
  })
  return { url: `${origin}/mcp`, seen }
}

async function startSse(refuse: Refuse = () => undefined): Promise<{ url: string; seen: Seen[] }> {
  const mcp = mcpServer()
  const seen: Seen[] = []
  const sessions = new Map<string, InstanceType<typeof SSEServerTransport>>()
  const server = createServer((req, res) => {
    seen.push({ method: req.method, headers: { ...req.headers } })
    const status = refuse(req)
    if (status) return refused(res, status)
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method === 'GET' && url.pathname === '/sse') {
      const transport = new SSEServerTransport('/messages', res)
      sessions.set(transport.sessionId, transport)
      void mcp.connect(transport)
      return
    }
    const transport = sessions.get(url.searchParams.get('sessionId') ?? '')
    if (req.method === 'POST' && transport) return void transport.handlePostMessage(req, res)
    res.writeHead(404).end()
  })
  const origin = await listen(server)
  cleanup.push(async () => {
    await mcp.close()
    await close(server)
  })
  return { url: `${origin}/sse`, seen }
}

const start = { http: startHttp, sse: startSse }

function authorizer(
  headers: () => Record<string, string>,
  rejected: (response: Response, final: boolean) => Promise<'retry' | 'fail'> = async () => 'fail',
) {
  return {
    headers: vi.fn(async (_signal?: AbortSignal, _resendOf?: Readonly<Record<string, string>>) => headers()),
    rejected: vi.fn(async (response: Response, _sent: Readonly<Record<string, string>>, final: boolean) =>
      rejected(response, final),
    ),
  } satisfies McpHttpAuthorizer
}

const loopback = (url: URL): void => {
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('not loopback')
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection')
}

const signal = () => new AbortController().signal

describe('connectMcp with a per-request authorizer', () => {
  it.each(['http', 'sse'] as const)('adds authorizer headers to every request (%s)', async (kind) => {
    const server = await start[kind]()
    const auth = authorizer(() => ({ authorization: 'Bearer t-1' }))
    const conn = await connectMcp({ id: 'a', transport: kind, url: server.url, defer: false }, undefined, {
      authorize: auth,
    })
    await conn.listTools()
    await conn.callTool('echo', {}, { signal: signal() })
    await conn.close()
    expect(server.seen.length).toBeGreaterThanOrEqual(3)
    for (const request of server.seen) expect(request.headers.authorization).toBe('Bearer t-1')
    expect(auth.headers.mock.calls.length).toBe(server.seen.length)
    expect(auth.rejected).not.toHaveBeenCalled()
  })

  it.each(['http', 'sse'] as const)('401 then one retry with fresh headers (%s)', async (kind) => {
    const server = await start[kind]((req) => (req.headers.authorization === 'Bearer old' ? 401 : undefined))
    let token = 'old'
    const auth = authorizer(
      () => ({ authorization: `Bearer ${token}` }),
      async (response) => {
        expect(response.status).toBe(401)
        token = 'new'
        return 'retry'
      },
    )
    const conn = await connectMcp({ id: 'a', transport: kind, url: server.url, defer: false }, undefined, {
      authorize: auth,
    })
    expect(await conn.listTools()).toHaveLength(1)
    await conn.close()
    expect(auth.rejected).toHaveBeenCalledTimes(1)
    expect(server.seen[0]?.headers.authorization).toBe('Bearer old')
    expect(server.seen.slice(1).every((request) => request.headers.authorization === 'Bearer new')).toBe(true)
  })

  it('at most one refresh and one retry per request', async () => {
    const server = await startHttp(() => 401)
    const auth = authorizer(
      () => ({ authorization: 'Bearer t-1' }),
      async () => 'retry',
    )
    const error = await failure(
      connectMcp({ id: 'a', transport: 'http', url: server.url, defer: false }, undefined, {
        authorize: auth,
      }),
    )
    // The resend's 401 is shown as final: 'retry' then counts as 'fail', so there is no third send.
    expect((error as { code?: unknown }).code).toBe(401)
    expect(server.seen).toHaveLength(2)
    expect(auth.rejected.mock.calls.map((call) => call[2])).toEqual([false, true])
    expect(auth.headers).toHaveBeenCalledTimes(2)
    // The resend's headers are asked for with the first send's headers, so a refresh is not repeated.
    expect(auth.headers.mock.calls[1]?.[1]).toEqual({ authorization: 'Bearer t-1' })
  })

  it.each(['http', 'sse'] as const)(
    'a 401 on the resend goes to the authorizer as final, and its error reaches the call (%s)',
    async (kind) => {
      let refuseAll = false
      const server = await start[kind]((req) => (refuseAll && req.method === 'POST' ? 401 : undefined))
      const refusal = Object.assign(new Error('needs sign-in'), { code: 'MCP_OAUTH_NEEDS_RECONNECT' })
      const auth = authorizer(
        () => ({ authorization: 'Bearer t-1' }),
        async (_response, final) => {
          if (final) throw refusal
          return 'retry'
        },
      )
      const conn = await connectMcp({ id: 'a', transport: kind, url: server.url, defer: false }, undefined, {
        authorize: auth,
      })
      // POSTs only: the Streamable HTTP client opens its event stream (a GET) in the background.
      const posts = () => server.seen.filter((request) => request.method === 'POST').length
      const sent = posts()
      refuseAll = true
      expect(await failure(conn.callTool('echo', {}, { signal: signal() }))).toBe(refusal)
      expect(posts()).toBe(sent + 2)
      await conn.close()
    },
  )

  it('a 401 on the resend of the SSE event stream: the final refusal is what connect reports', async () => {
    const server = await startSse(() => 401)
    const refusal = Object.assign(new Error('needs sign-in'), { code: 'MCP_OAUTH_NEEDS_RECONNECT' })
    const auth = authorizer(
      () => ({ authorization: 'Bearer t-1' }),
      async (_response, final) => {
        if (final) throw refusal
        return 'retry'
      },
    )
    const error = await failure(
      connectMcp({ id: 'a', transport: 'sse', url: server.url, defer: false }, undefined, {
        authorize: auth,
      }),
    )
    expect(error).toBe(refusal)
    expect(server.seen).toHaveLength(2)
  })

  it('a refusal answered with fail is returned without being sent again', async () => {
    const server = await startHttp(() => 403)
    const auth = authorizer(() => ({ authorization: 'Bearer t-1' }))
    const error = await failure(
      connectMcp({ id: 'a', transport: 'http', url: server.url, defer: false }, undefined, {
        authorize: auth,
      }),
    )
    expect((error as { code?: unknown }).code).toBe(403)
    expect(server.seen).toHaveLength(1)
    expect(auth.rejected).toHaveBeenCalledTimes(1)
  })

  it('authorizer header is stripped on a cross-origin redirect', async () => {
    const target = await startHttp()
    const redirects: Seen[] = []
    const redirect = createServer((req, res) => {
      redirects.push({ method: req.method, headers: { ...req.headers } })
      res.writeHead(307, { location: target.url }).end()
    })
    const origin = await listen(redirect)
    cleanup.push(() => close(redirect))
    const auth = authorizer(() => ({ authorization: 'Bearer t-1', 'x-grant': 'g-1' }))
    const conn = await connectMcp(
      { id: 'a', transport: 'http', url: `${origin}/mcp`, defer: false },
      undefined,
      { authorize: auth, validateRedirectUrl: loopback },
    )
    await conn.close()
    expect(redirects[0]?.headers['x-grant']).toBe('g-1')
    expect(target.seen.length).toBeGreaterThan(0)
    for (const request of target.seen) {
      expect(request.headers.authorization).toBeUndefined()
      expect(request.headers['x-grant']).toBeUndefined()
    }
  })

  it.each(['http', 'sse'] as const)('headers() throwing sends nothing (%s)', async (kind) => {
    const server = await start[kind]()
    const refusal = Object.assign(new Error('needs sign-in'), { code: 'MCP_OAUTH_NEEDS_RECONNECT' })
    const auth = authorizer(() => {
      throw refusal
    })
    const error = await failure(
      connectMcp({ id: 'a', transport: kind, url: server.url, defer: false }, undefined, { authorize: auth }),
    )
    expect(error).toBe(refusal)
    expect(server.seen).toHaveLength(0)
  })

  it.each(['http', 'sse'] as const)(
    'an error thrown by rejected() reaches the caller as is (%s)',
    async (kind) => {
      const server = await start[kind](() => 403)
      const refusal = Object.assign(new Error('needs more permissions'), {
        code: 'MCP_OAUTH_NEEDS_RECONNECT',
      })
      const auth = authorizer(
        () => ({ authorization: 'Bearer t-1' }),
        async () => {
          throw refusal
        },
      )
      const error = await failure(
        connectMcp({ id: 'a', transport: kind, url: server.url, defer: false }, undefined, {
          authorize: auth,
        }),
      )
      expect(error).toBe(refusal)
      expect(server.seen).toHaveLength(1)
    },
  )

  it.each(['http', 'sse'] as const)(
    'a refusal after connecting reaches the call unchanged and sends nothing (%s)',
    async (kind) => {
      const server = await start[kind]()
      const refusal = Object.assign(new Error('needs sign-in'), { code: 'MCP_OAUTH_NEEDS_RECONNECT' })
      let refuse = false
      const auth = authorizer(() => {
        if (refuse) throw refusal
        return { authorization: 'Bearer t-1' }
      })
      const conn = await connectMcp({ id: 'a', transport: kind, url: server.url, defer: false }, undefined, {
        authorize: auth,
      })
      const sent = server.seen.length
      refuse = true
      expect(await failure(conn.callTool('echo', {}, { signal: signal() }))).toBe(refusal)
      expect(await failure(conn.listTools())).toBe(refusal)
      expect(server.seen).toHaveLength(sent)
      await conn.close()
    },
  )

  it.each(['http', 'sse'] as const)(
    'a refusal still ends the connection, but only after its call failed with the refusal (%s)',
    async (kind) => {
      const server = await start[kind]()
      const refusal = Object.assign(new Error('needs sign-in'), { code: 'MCP_OAUTH_NEEDS_RECONNECT' })
      let refuse = false
      const auth = authorizer(() => {
        if (refuse) throw refusal
        return { authorization: 'Bearer t-1' }
      })
      const conn = await connectMcp({ id: 'a', transport: kind, url: server.url, defer: false }, undefined, {
        authorize: auth,
      })
      // Like the row supervisor: a reported disconnect closes the connection at once.
      const lost = vi.fn(() => void conn.close())
      conn.onClose?.(lost)
      refuse = true
      expect(await failure(conn.callTool('echo', {}, { signal: signal() }))).toBe(refusal)
      await vi.waitFor(() => expect(lost).toHaveBeenCalledTimes(1))
    },
  )
})
