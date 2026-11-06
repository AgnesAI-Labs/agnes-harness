import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { afterEach, describe, expect, it } from 'vitest'
import { McpOAuthNeedsReconnectError } from '../src/mcp.js'
import { McpOAuthClientAuthUnsupported } from '../src/mcp-oauth-protocol.js'
import { refreshMcpOAuth } from '../src/mcp-oauth-refresh.js'
import type { McpOAuthClient, McpOAuthRecord, McpOAuthServer } from '../src/mcp-oauth-store.js'
import { type FakeOAuthServer, startFakeOAuthServer } from './helpers/fake-oauth.js'
import { createMemoryOAuthStore } from './helpers/memory-oauth-store.js'

const SERVER_ID = 'docs'
const NOW = 1_700_000_000_000

describe('refreshMcpOAuth', () => {
  let fake: FakeOAuthServer | undefined
  afterEach(async () => {
    await fake?.close()
    fake = undefined
  })

  async function start(options: Parameters<typeof startFakeOAuthServer>[0] = {}): Promise<FakeOAuthServer> {
    fake = await startFakeOAuthServer({ prm: { resource: '/mcp', scopes: ['read'] }, ...options })
    return fake
  }

  function recordFor(server: FakeOAuthServer, patch: Partial<McpOAuthRecord> = {}): McpOAuthRecord {
    return {
      version: 2,
      kind: 'oauth',
      epoch: 2,
      rev: 5,
      client: {
        clientId: 'client-1',
        clientSecret: 'secret-1',
        tokenEndpointAuthMethod: 'client_secret_post',
        redirectUri: 'http://localhost:1234/callback',
      },
      server: {
        endpoint: server.serverUrl.href,
        authorizationServer: server.httpsUrl.href,
        tokenEndpoint: `${server.httpsUrl.origin}/token`,
        issuer: server.httpsUrl.origin,
        resource: new URL('/mcp', server.url).href,
      },
      tokens: { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: NOW - 1, scope: ['read'] },
      requiredScope: ['extra'],
      ...patch,
    }
  }

  function serverOf(record: McpOAuthRecord): McpOAuthServer {
    if (!record.server) throw new Error('record has no server')
    return record.server
  }

  function clientOf(record: McpOAuthRecord): McpOAuthClient {
    if (!record.client) throw new Error('record has no client')
    return record.client
  }

  function setup(server: FakeOAuthServer, record: McpOAuthRecord | null = recordFor(server)) {
    const store = createMemoryOAuthStore()
    store.seed(SERVER_ID, record)
    return {
      store,
      run: (
        seen: McpOAuthRecord,
        extra: { fetchImpl?: FetchLike; staticClient?: { clientId: string; clientSecret?: string } } = {},
      ) =>
        refreshMcpOAuth({
          serverId: SERVER_ID,
          serverUrl: server.serverUrl,
          seen,
          store,
          fetchImpl: extra.fetchImpl ?? server.fetchImpl,
          now: () => NOW,
          ...(extra.staticClient ? { staticClient: extra.staticClient } : {}),
        }),
    }
  }

  async function reconnectReason(promise: Promise<unknown>): Promise<string | undefined> {
    try {
      await promise
    } catch (error) {
      if (error instanceof McpOAuthNeedsReconnectError) return error.reason
      throw error
    }
    return undefined
  }

  it('sends the stored resource and the chosen client auth', async () => {
    const server = await start({ authMethods: ['client_secret_basic', 'client_secret_post'] })
    const seen = recordFor(server)
    const { store, run } = setup(server, seen)

    const next = await run(seen)

    const [request] = server.requests()
    expect(server.requests()).toHaveLength(1)
    expect(request?.form.grant_type).toBe('refresh_token')
    expect(request?.form.refresh_token).toBe('old-refresh')
    expect(request?.form.resource).toBe(seen.server?.resource)
    // The registered method wins over the server's preference for basic.
    expect(request?.form.client_secret).toBe('secret-1')
    expect(request?.headers.authorization).toBeUndefined()

    expect(next.rev).toBe(seen.rev + 1)
    expect(next.epoch).toBe(seen.epoch)
    expect(next.tokens?.accessToken).toBe('at-1')
    expect(next.tokens?.refreshToken).toBe('rt-1')
    expect(next.tokens?.expiresAt).toBe(NOW + 3_600_000)
    // The server named no scope, so the previous grant stays as it was.
    expect(next.tokens?.scope).toEqual(['read'])
    expect(next.requiredScope).toEqual(['extra'])
    expect(next.client).toEqual(seen.client)
    expect(next.server).toEqual(seen.server)
    expect(await store.read(SERVER_ID)).toEqual(next)
  })

  it('uses the static client secret when the record has none', async () => {
    const server = await start()
    const seen = recordFor(server, {
      client: { clientId: 'client-1', redirectUri: 'http://localhost:1234/callback' },
    })
    const { run } = setup(server, seen)

    await run(seen, { staticClient: { clientId: 'client-1', clientSecret: 'static-secret' } })

    const request = server.requests().at(-1)
    expect(request?.headers.authorization).toBe(
      `Basic ${Buffer.from('client-1:static-secret').toString('base64')}`,
    )
    expect(request?.form.client_secret).toBeUndefined()
  })

  it('rev moved: returns the stored record without a token request', async () => {
    const server = await start()
    const seen = recordFor(server)
    const moved = recordFor(server, {
      rev: seen.rev + 3,
      tokens: {
        accessToken: 'newer',
        refreshToken: 'newer-refresh',
        expiresAt: NOW + 600_000,
        scope: ['read'],
      },
    })
    const { store, run } = setup(server, moved)

    expect(await run(seen)).toEqual(moved)
    expect(server.requests()).toEqual([])
    expect(store.writes(SERVER_ID)).toBe(0)
  })

  it('a write that changed only requiredScope is no new token: the refresh still happens and keeps that write', async () => {
    const server = await start()
    const seen = recordFor(server)
    const { store, run } = setup(server, { ...seen, rev: seen.rev + 1, requiredScope: ['extra', 'more'] })

    const refreshed = await run(seen)

    expect(server.requests().filter((request) => request.grantType === 'refresh_token')).toHaveLength(1)
    expect(refreshed.tokens?.accessToken).toBe('at-1')
    expect(refreshed).toMatchObject({ rev: seen.rev + 2, requiredScope: ['extra', 'more'] })
    expect(await store.read(SERVER_ID)).toEqual(refreshed)
  })

  it('logged-out record: throws login-required without a token request', async () => {
    const server = await start()
    const loggedOut: McpOAuthRecord = { version: 2, kind: 'oauth', epoch: 3, rev: 6, requiredScope: [] }
    const seen = recordFor(server)
    const { store, run } = setup(server, loggedOut)

    expect(await reconnectReason(run(loggedOut))).toBe('login-required')
    // Logged out after the caller looked: the stored record decides.
    expect(await reconnectReason(run(seen))).toBe('login-required')
    expect(server.requests()).toEqual([])
    expect(store.writes(SERVER_ID)).toBe(0)
  })

  it('invalid_grant drops tokens, keeps client and server, throws login-required', async () => {
    const server = await start()
    server.setTokenResponse(() => ({ error: 'invalid_grant' }))
    const seen = recordFor(server)
    const { store, run } = setup(server, seen)

    expect(await reconnectReason(run(seen))).toBe('login-required')

    const stored = await store.read(SERVER_ID)
    expect(stored).toEqual({
      version: 2,
      kind: 'oauth',
      epoch: seen.epoch,
      rev: seen.rev + 1,
      client: seen.client,
      server: seen.server,
      requiredScope: seen.requiredScope,
    })
  })

  it('network failure keeps tokens and throws login-required', async () => {
    const server = await start()
    const seen = recordFor(server)
    const { store, run } = setup(server, seen)
    const failing: FetchLike = async (input, init) => {
      if (String(input).endsWith('/token')) throw new TypeError('fetch failed')
      return server.fetchImpl(input, init)
    }

    let caught: unknown
    try {
      await run(seen, { fetchImpl: failing })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(McpOAuthNeedsReconnectError)
    expect((caught as McpOAuthNeedsReconnectError).reason).toBe('login-required')
    expect((caught as McpOAuthNeedsReconnectError).cause).toBeInstanceOf(TypeError)
    expect(await store.read(SERVER_ID)).toEqual(seen)
    expect(store.writes(SERVER_ID)).toBe(0)
  })

  it.each([
    [
      'token endpoint',
      (r: McpOAuthRecord) => ({ ...serverOf(r), tokenEndpoint: 'https://other.example/token' }),
    ],
    ['issuer', (r: McpOAuthRecord) => ({ ...serverOf(r), issuer: 'https://other.example' })],
    ['resource', (r: McpOAuthRecord) => ({ ...serverOf(r), resource: 'http://127.0.0.1:1/other' })],
    ['server address', (r: McpOAuthRecord) => ({ ...serverOf(r), endpoint: 'https://moved.example/mcp' })],
  ])('discovered %s changed: throws endpoint-changed, no token request', async (_name, change) => {
    const server = await start()
    const base = recordFor(server)
    const seen = recordFor(server, { server: change(base) })
    const { store, run } = setup(server, seen)

    expect(await reconnectReason(run(seen))).toBe('endpoint-changed')
    expect(server.requests()).toEqual([])
    expect(store.writes(SERVER_ID)).toBe(0)
  })

  it('compares the stored resource in canonical form', async () => {
    const server = await start()
    const base = recordFor(server)
    const seen = recordFor(server, {
      server: { ...serverOf(base), resource: `${serverOf(base).resource.replace(/^http/, 'HTTP')}/` },
    })
    const { run } = setup(server, seen)

    const refreshed = await run(seen)
    expect(refreshed.rev).toBe(seen.rev + 1)
  })

  it('metadata outage reads as login-required, not endpoint-changed, and keeps the tokens', async () => {
    const server = await start()
    const seen = recordFor(server)
    const { store, run } = setup(server, seen)
    const outage: FetchLike = async (input, init) => {
      if (String(input).includes('/.well-known/')) throw new TypeError('fetch failed')
      return server.fetchImpl(input, init)
    }

    expect(await reconnectReason(run(seen, { fetchImpl: outage }))).toBe('login-required')
    expect(server.requests()).toEqual([])
    expect(await store.read(SERVER_ID)).toEqual(seen)
    expect(store.writes(SERVER_ID)).toBe(0)
  })

  it('no refresh token: throws login-required', async () => {
    const server = await start()
    const seen = recordFor(server, {
      tokens: { accessToken: 'a', expiresAt: NOW - 1, scope: ['read'] },
    })
    const { store, run } = setup(server, seen)

    expect(await reconnectReason(run(seen))).toBe('login-required')
    expect(server.requests()).toEqual([])
    expect(store.writes(SERVER_ID)).toBe(0)
  })

  it('an unsupported client authentication method is reported and no request is made', async () => {
    const server = await start()
    const base = recordFor(server)
    const seen = recordFor(server, {
      client: { ...clientOf(base), tokenEndpointAuthMethod: 'private_key_jwt' },
    })
    const { store, run } = setup(server, seen)

    await expect(run(seen)).rejects.toBeInstanceOf(McpOAuthClientAuthUnsupported)
    expect(server.requests()).toEqual([])
    expect(store.writes(SERVER_ID)).toBe(0)
  })

  it('discovery runs outside the lock', async () => {
    const server = await start()
    const seen = recordFor(server)
    const { store, run } = setup(server, seen)
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let discoveryStarted: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      discoveryStarted = resolve
    })
    const gated: FetchLike = async (input, init) => {
      if (String(input).includes('/.well-known/')) {
        discoveryStarted()
        await gate
      }
      return server.fetchImpl(input, init)
    }

    const refreshing = run(seen, { fetchImpl: gated })
    await started
    const other = await Promise.race([
      store.update(SERVER_ID, async () => ({ value: 'done' })),
      new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 1_000)),
    ])
    expect(other).toBe('done')
    release()
    expect((await refreshing).rev).toBe(seen.rev + 1)
  })
})
