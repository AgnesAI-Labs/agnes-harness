import type { NodeClient } from '@agnes/sdk'

/** A stand-in for the daemon client: records every call and answers the few the sign-in uses. */
export type FakeDaemonOptions = {
  transport?: { kind: 'http' | 'sse'; url: string } | { kind: 'stdio'; executable: string; args: string[] }
  secretBinding?: Record<string, unknown>
  summary?: Record<string, unknown>
  refresh?: { signedIn: boolean }
  completeError?: unknown
  reconnect?: 'succeeded' | 'failed' | 'throws'
}

export const SERVER_URL = 'https://mcp.example.test/mcp'
const REVISION = 'a'.repeat(64)
const UPDATED = 'b'.repeat(64)

export function fakeDaemon(options: FakeDaemonOptions = {}) {
  const calls: [string, Record<string, unknown>][] = []
  let definition: Record<string, unknown> = {
    serverId: 'docs',
    displayName: 'Docs',
    transport: options.transport ?? { kind: 'http', url: SERVER_URL },
    secretBinding: options.secretBinding ?? { kind: 'oauth' },
  }
  let revision = REVISION
  const operations = new Map<string, { state: string; lastSafeError?: { code: string; message: string } }>()
  const receipt = (operationId: string, state: string, lastSafeError?: { code: string; message: string }) => {
    operations.set(operationId, { state, ...(lastSafeError ? { lastSafeError } : {}) })
    return { operationId, state: 'received' }
  }
  const record = (name: string, params: unknown) => calls.push([name, params as Record<string, unknown>])
  const client = {
    async clientId() {
      return 'cli-client'
    },
    async request(method: string, params: Record<string, unknown>) {
      record(method, params)
      if (method === '_agnes/v1/admin.mcp.oauth.get')
        return {
          epoch: 0,
          signedIn: false,
          refreshable: false,
          scope: [],
          requiredScope: [],
          ...options.summary,
        }
      if (method === '_agnes/v1/admin.mcp.oauth.refresh') return options.refresh ?? { signedIn: false }
      if (method === '_agnes/v1/admin.mcp.oauth.complete') {
        if (options.completeError) throw options.completeError
        return {}
      }
      if (method === '_agnes/v1/admin.mcp.oauth.logout') return { epoch: 1 }
      throw new Error(`unexpected request ${method}`)
    },
    mcp: {
      servers: {
        async get(params: Record<string, unknown>) {
          record('mcp.servers.get', params)
          return { serverId: 'docs', revision, definition, trust: 'trusted', desired: 'enabled' }
        },
        async update(params: Record<string, unknown>) {
          record('mcp.servers.update', params)
          definition = params.definition as Record<string, unknown>
          revision = UPDATED
          return receipt('op-update', 'succeeded')
        },
        async reconnect(params: Record<string, unknown>) {
          record('mcp.servers.reconnect', params)
          if (options.reconnect === 'throws') throw new Error('daemon went away')
          return options.reconnect === 'failed'
            ? receipt('op-reconnect', 'failed', { code: 'MCP_CONNECT_FAILED', message: 'could not connect' })
            : receipt('op-reconnect', 'succeeded')
        },
        oauth: {
          async statusSet(params: Record<string, unknown>) {
            record('mcp.servers.oauth.statusSet', params)
            return { authorizationStatus: params.status }
          },
          async signOut(params: Record<string, unknown>) {
            record('mcp.servers.oauth.signOut', params)
            return receipt('op-sign-out', 'succeeded')
          },
        },
      },
    },
    resources: {
      operation: {
        async get(params: { operationId: string }) {
          const operation = operations.get(params.operationId)
          return { operationId: params.operationId, ...operation }
        },
      },
    },
  }
  return {
    client: client as unknown as NodeClient,
    calls,
    names: () => calls.map(([name]) => name),
    params: (name: string) => calls.find(([called]) => called === name)?.[1],
  }
}

/**
 * Discovery, registration and nothing else: the token request is the daemon's. Every address is
 * https (the sign-in refuses anything else).
 */
export function fakeAuthorizationServer() {
  const paths: string[] = []
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    paths.push(url.href)
    if (url.href === 'https://mcp.example.test/.well-known/oauth-protected-resource/mcp')
      return Response.json({ resource: SERVER_URL, authorization_servers: ['https://auth.example.test/'] })
    if (url.href === 'https://auth.example.test/.well-known/oauth-authorization-server')
      return Response.json({
        issuer: 'https://auth.example.test/',
        authorization_endpoint: 'https://auth.example.test/authorize',
        token_endpoint: 'https://auth.example.test/token',
        registration_endpoint: 'https://auth.example.test/register',
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
      })
    if (url.href === 'https://auth.example.test/register')
      return Response.json(
        { client_id: 'dcr-client', redirect_uris: ['http://localhost/callback'] },
        { status: 201 },
      )
    return new Response('', { status: 404 })
  }
  return { fetchImpl, paths }
}

/** Plays the authorization server's redirect back to the loopback callback. */
export function browserReturning(code: string | undefined, query = '') {
  const visits: string[] = []
  const open = (url: string) => {
    visits.push(url)
    const authorization = new URL(url)
    const redirect = new URL(authorization.searchParams.get('redirect_uri') as string)
    redirect.hostname = '127.0.0.1'
    if (code) redirect.searchParams.set('code', code)
    redirect.searchParams.set('state', authorization.searchParams.get('state') as string)
    void fetch(`${redirect.href}${query}`).catch(() => undefined)
  }
  return { open, visits }
}
