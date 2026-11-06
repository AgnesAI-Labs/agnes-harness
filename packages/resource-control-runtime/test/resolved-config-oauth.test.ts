import { describe, expect, it, vi } from 'vitest'
import { createMcpResourceManager, type McpConnectOptions, resolvedConfig } from '../src/mcp.js'
import type { McpOAuthRecord } from '../src/mcp-oauth-store.js'
import { createMemoryOAuthStore } from './helpers/memory-oauth-store.js'

const URL_TEXT = 'https://mcp.example.com/mcp'
const policies = { stdioPolicy: { allowedExecutables: [] } }
const barrier = { quiesce: async <T>(_id: string, publish: (permit: unknown) => Promise<T>) => publish({}) }

function definition(binding: Record<string, string> = {}) {
  return {
    serverId: 'remote-server',
    displayName: 'Remote',
    transport: { kind: 'http' as const, url: URL_TEXT },
    secretBinding: { kind: 'oauth' as const, ...binding },
  }
}

const managed = (binding?: Record<string, string>) => ({
  definition: definition(binding),
  revision: 'a'.repeat(64),
  desired: 'enabled' as const,
  trust: 'trusted' as const,
})

const record: McpOAuthRecord = {
  version: 2,
  kind: 'oauth',
  epoch: 0,
  rev: 1,
  client: { clientId: 'client-1', redirectUri: 'http://localhost:1/callback' },
  server: {
    endpoint: URL_TEXT,
    authorizationServer: 'https://auth.example.com/',
    tokenEndpoint: 'https://auth.example.com/token',
    resource: URL_TEXT,
  },
  tokens: { accessToken: 'tok-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 3_600_000, scope: [] },
  requiredScope: [],
}

function manager(options: {
  oauthStore?: ReturnType<typeof createMemoryOAuthStore>
  credentials?: () => Promise<string>
}) {
  const connect = vi.fn(async (_config: unknown, connectOptions: McpConnectOptions) => {
    // Like the real transport: the first request asks the authorizer, and a refusal ends the connect.
    const headers = await connectOptions.authorize?.headers()
    if (!headers) throw new Error('no authorizer')
    return {
      id: 'remote-server',
      listTools: async () => [],
      callTool: async () => ({ content: [] }),
      close: async () => undefined,
    }
  })
  const credentials = vi.fn(options.credentials ?? (async () => 'unused'))
  const created = createMcpResourceManager({
    barrier,
    profile: 'local-dev',
    credentials,
    ...(options.oauthStore ? { oauthStore: options.oauthStore } : {}),
    stdioPolicy: { allowedExecutables: [] },
    connect,
    inspectCatalog: async () => ({ tools: [], skipped: [] }),
    apply: async () => undefined,
  })
  return { created, connect, credentials }
}

const reconcile = (created: ReturnType<typeof createMcpResourceManager>, binding?: Record<string, string>) =>
  created.reconcile({
    profile: 'local-dev',
    serverId: 'remote-server',
    definition: definition(binding),
    enabled: true,
    signal: new AbortController().signal,
  })

describe('OAuth servers through resolvedConfig and the resource manager', () => {
  it('the config of an OAuth server carries no token and resolves no secret', async () => {
    const resolver = vi.fn(async () => 'unused')
    const config = await resolvedConfig(managed(), resolver, new AbortController().signal, {}, policies)
    expect(config).toMatchObject({ id: 'remote-server', transport: 'http', url: URL_TEXT })
    expect(config.headers).toBeUndefined()
    expect(resolver).not.toHaveBeenCalled()
  })

  it('connects an OAuth server with an authorizer that sends the stored token', async () => {
    const oauthStore = createMemoryOAuthStore({ 'remote-server': record })
    const { created, connect } = manager({ oauthStore })
    created.stage(managed())
    const result = await reconcile(created)
    expect(result.status).toMatchObject({ connectionState: 'ready' })
    expect(connect).toHaveBeenCalledTimes(1)
    expect(connect.mock.calls[0]?.[0]).not.toHaveProperty('headers')
    expect(await connect.mock.calls[0]?.[1].authorize?.headers()).toEqual({ authorization: 'Bearer tok-1' })
    await created.close()
  })

  it('an OAuth server without a store needs sign-in and is never connected', async () => {
    const { created, connect } = manager({})
    created.stage(managed())
    const result = await reconcile(created)
    expect(result.status).toMatchObject({
      connectionState: 'unavailable',
      lastSafeError: { code: 'MCP_OAUTH_NEEDS_RECONNECT', message: 'MCP server needs sign-in' },
    })
    expect(connect).not.toHaveBeenCalled()
  })

  it('an OAuth server with no stored sign-in needs sign-in', async () => {
    const { created } = manager({ oauthStore: createMemoryOAuthStore() })
    created.stage(managed())
    const result = await reconcile(created)
    expect(result.status).toMatchObject({
      connectionState: 'unavailable',
      lastSafeError: { code: 'MCP_OAUTH_NEEDS_RECONNECT' },
    })
  })

  it("a static client's secret is resolved from its reference for the connection", async () => {
    const oauthStore = createMemoryOAuthStore({ 'remote-server': record })
    const { created, credentials } = manager({ oauthStore, credentials: async () => 'static-secret' })
    const binding = { staticClientId: 'client-1', clientSecretRef: 'secret://mcp/remote-client' }
    created.stage(managed(binding))
    const result = await reconcile(created, binding)
    expect(result.status).toMatchObject({ connectionState: 'ready' })
    expect(credentials).toHaveBeenCalledWith('secret://mcp/remote-client', expect.any(AbortSignal))
    await created.close()
  })
})
