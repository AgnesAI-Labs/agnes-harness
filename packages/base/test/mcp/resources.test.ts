import { createServer, type Server as HttpServer } from 'node:http'
import { createRequire } from 'node:module'
import { checkToolDef, type ExtensionAPI, type ToolDef } from '@agnes/extension-api'
import { afterEach, describe, expect, it } from 'vitest'
import { connectMcp } from '../../src/mcp/connect.js'
import { mcpPublicToolName } from '../../src/mcp/naming.js'
import { type McpConnection, registerRemoteToolsStrict } from '../../src/mcp/register.js'
import {
  MCP_RESOURCE_LIST_SUFFIX,
  MCP_RESOURCE_READ_SUFFIX,
  MCP_RESOURCE_TEMPLATES_SUFFIX,
  mcpResourceToolName,
} from '../../src/mcp/resources.js'
import { fakeToolContext } from '../../testkit/tool-context.js'

const require = createRequire(import.meta.url)
const { createFixtureServer } = require('./fixture-server.cjs') as {
  createFixtureServer: () => {
    connect(transport: object): Promise<void>
    close(): Promise<void>
  }
}
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js') as {
  StreamableHTTPServerTransport: new (options: {
    sessionIdGenerator: undefined
    enableJsonResponse: boolean
  }) => {
    handleRequest(req: unknown, res: unknown): Promise<void>
    close(): Promise<void>
  }
}
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js') as {
  SSEServerTransport: new (
    path: string,
    res: unknown,
  ) => {
    sessionId: string
    handlePostMessage(req: unknown, res: unknown): Promise<void>
    onclose?: () => void
  }
}
const fixturePath = require.resolve('./fixture-server.cjs')

function apiOf() {
  const tools: ToolDef[] = []
  const resources: Array<{ description?: string }> = []
  const warn = { calls: [] as string[] }
  const api = {
    registerTool: (tool: ToolDef) => {
      tools.push(tool)
      return () => undefined
    },
    registerResource: (resource: { description?: string }) => {
      resources.push(resource)
      return () => undefined
    },
    ctx: {
      log: {
        debug() {},
        info() {},
        warn(message: string) {
          warn.calls.push(message)
        },
        error() {},
      },
    },
  } as unknown as ExtensionAPI
  return { api, tools, resources, warn }
}

function connection(over: Partial<McpConnection> = {}): McpConnection {
  return {
    id: 'docs',
    async listTools() {
      return [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }]
    },
    async callTool() {
      return { content: [{ type: 'text', text: 'ok' }] }
    },
    async close() {},
    supportsResources: true,
    async listResources() {
      return { resources: [{ uri: 'memo://readme', name: 'readme', description: 'fixture readme' }] }
    },
    async listResourceTemplates() {
      return { resourceTemplates: [{ uriTemplate: 'memo://item/{id}', name: 'item' }] }
    },
    async readResource(uri) {
      return { contents: [{ uri, text: 'fixture readme' }] }
    },
    ...over,
  }
}

const cfg = { id: 'docs', transport: 'stdio' as const, cmd: ['fixture'], defer: false }

describe('MCP resource tools', () => {
  it('adds no resource tools unless the server advertises resources', async () => {
    const { api, tools } = apiOf()
    await registerRemoteToolsStrict(api, connection({ supportsResources: false }), cfg)
    expect(tools.map((tool) => tool.name)).toEqual([
      mcpPublicToolName('docs', 'echo'),
      expect.stringMatching(/_echo$/),
    ])
  })

  it('registers list, template, and read tools and omits only a conflicting name', async () => {
    const { api, tools, resources, warn } = apiOf()
    const names = {
      list: mcpResourceToolName('docs', MCP_RESOURCE_LIST_SUFFIX),
      templates: mcpResourceToolName('docs', MCP_RESOURCE_TEMPLATES_SUFFIX),
      read: mcpResourceToolName('docs', MCP_RESOURCE_READ_SUFFIX),
    }
    await registerRemoteToolsStrict(
      api,
      connection({
        async listTools() {
          return [{ name: 'res_list', description: 'remote owns this name', inputSchema: { type: 'object' } }]
        },
      }),
      cfg,
    )
    expect(tools.map((tool) => tool.name)).toEqual([
      mcpPublicToolName('docs', 'res_list'),
      names.templates,
      names.read,
      names.list,
    ])
    expect(tools.find((tool) => tool.name === names.list)?.description).toBe('remote owns this name')
    expect(warn.calls).toEqual(['MCP resource tool name conflicts with a registered tool'])
    expect(resources[0]?.description).toContain('2 resource tools')
    expect(resources[0]?.description).toContain('1 omitted for name conflict')
    for (const tool of tools) expect(checkToolDef(tool).ok).toBe(true)
    const longId = 'a'.repeat(40)
    expect(mcpResourceToolName(longId, MCP_RESOURCE_TEMPLATES_SUFFIX).length).toBeLessThanOrEqual(64)
  })

  it('passes the tool signal through to the resource read', async () => {
    let seen: AbortSignal | undefined
    const { api, tools } = apiOf()
    await registerRemoteToolsStrict(
      api,
      connection({
        async readResource(uri, options) {
          seen = options?.signal
          return { contents: [{ uri, text: 'fixture readme' }] }
        },
      }),
      cfg,
    )
    const read = tools.find((tool) => tool.name.endsWith(MCP_RESOURCE_READ_SUFFIX))
    const ctx = fakeToolContext()
    const result = await read?.execute({ uri: 'memo://readme' }, ctx)
    expect(seen).toBe(ctx.signal)
    expect(result?.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('fixture readme'),
    })
  })
})

describe('MCP resource transports', () => {
  const cleanup: Array<() => Promise<unknown>> = []
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((close) => close()))
  })

  function listen(server: HttpServer, path: string): Promise<string> {
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('missing fixture address')
        resolve(`http://127.0.0.1:${address.port}${path}`)
      })
    })
  }

  async function expectResources(id: string, transport: 'stdio' | 'http' | 'sse', url?: string) {
    if (transport !== 'stdio' && url === undefined) throw new Error('missing fixture url')
    const conn = await connectMcp(
      transport === 'stdio'
        ? { id, transport, defer: false, cmd: [process.execPath, fixturePath] }
        : { id, transport, defer: false, url: url as string },
      undefined,
      {},
    )
    cleanup.push(() => conn.close())
    expect(conn.supportsResources).toBe(true)
    const listed = await conn.listResources?.()
    expect(listed?.resources).toEqual([expect.objectContaining({ uri: 'memo://readme', name: 'readme' })])
    const templates = await conn.listResourceTemplates?.()
    expect(templates?.resourceTemplates[0]?.uriTemplate).toBe('memo://item/{id}')
    const read = await conn.readResource?.('memo://item/7')
    expect(read?.contents).toEqual([expect.objectContaining({ uri: 'memo://item/7', text: 'item 7' })])
    const controller = new AbortController()
    const pending = conn.readResource?.('memo://slow', { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toThrow()
    return conn
  }

  it('reads resources over stdio', async () => {
    await expectResources('stdio-fixture', 'stdio')
  })

  it('reads resources over Streamable HTTP', async () => {
    const mcp = createFixtureServer()
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    await mcp.connect(transport)
    const server = createServer((req, res) => {
      void transport.handleRequest(req, res)
    })
    const url = await listen(server, '/mcp')
    cleanup.push(async () => {
      await mcp.close()
      await transport.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    await expectResources('http-fixture', 'http', url)
  })

  it('reads resources over legacy SSE', async () => {
    const mcp = createFixtureServer()
    const sessions = new Map<string, InstanceType<typeof SSEServerTransport>>()
    const server = createServer((req, res) => {
      const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (req.method === 'GET' && requestUrl.pathname === '/sse') {
        const transport = new SSEServerTransport('/messages', res)
        sessions.set(transport.sessionId, transport)
        transport.onclose = () => sessions.delete(transport.sessionId)
        void mcp.connect(transport)
        return
      }
      if (req.method === 'POST' && requestUrl.pathname === '/messages') {
        const transport = sessions.get(requestUrl.searchParams.get('sessionId') ?? '')
        if (!transport) {
          res.writeHead(404).end()
          return
        }
        void transport.handlePostMessage(req, res)
        return
      }
      res.writeHead(404).end()
    })
    const url = await listen(server, '/sse')
    cleanup.push(async () => {
      await mcp.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    await expectResources('sse-fixture', 'sse', url)
  })
})
