import { afterEach, describe, expect, it } from 'vitest'
import { McpOAuthNeedsReconnectError } from '../src/mcp.js'
import { createMcpOAuthAuthorizer } from '../src/mcp-oauth-authorizer.js'
import type { McpOAuthRead, McpOAuthRecord, McpOAuthStore } from '../src/mcp-oauth-store.js'
import { type FakeOAuthServer, startFakeOAuthServer } from './helpers/fake-oauth.js'
import { createMemoryOAuthStore } from './helpers/memory-oauth-store.js'

const SERVER_ID = 'docs'
const NOW = 1_700_000_000_000
const HOUR = 3_600_000

describe('createMcpOAuthAuthorizer', () => {
  let fake: FakeOAuthServer | undefined
  afterEach(async () => {
    await fake?.close()
    fake = undefined
  })

  async function start(): Promise<FakeOAuthServer> {
    fake = await startFakeOAuthServer({ prm: { resource: '/mcp', scopes: ['read'] } })
    return fake
  }

  function recordFor(server: FakeOAuthServer, patch: Partial<McpOAuthRecord> = {}): McpOAuthRecord {
    return {
      version: 2,
      kind: 'oauth',
      epoch: 1,
      rev: 4,
      client: { clientId: 'client-1', redirectUri: 'http://localhost:1234/callback' },
      server: {
        endpoint: server.serverUrl.href,
        authorizationServer: server.httpsUrl.href,
        tokenEndpoint: `${server.httpsUrl.origin}/token`,
        issuer: server.httpsUrl.origin,
        resource: new URL('/mcp', server.url).href,
      },
      tokens: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: NOW + HOUR,
        scope: ['read'],
      },
      requiredScope: [],
      ...patch,
    }
  }

  function setup(
    server: FakeOAuthServer,
    record: McpOAuthRead = recordFor(server),
    options: { serverUrl?: URL; store?: McpOAuthStore } = {},
  ) {
    const memory = createMemoryOAuthStore()
    memory.seed(SERVER_ID, record)
    const store = options.store ?? memory
    const authorizer = createMcpOAuthAuthorizer({
      serverId: SERVER_ID,
      serverUrl: options.serverUrl ?? server.serverUrl,
      store,
      fetchImpl: server.fetchImpl,
      now: () => NOW,
    })
    return { authorizer, memory }
  }

  const refreshGrants = (server: FakeOAuthServer) =>
    server.requests().filter((request) => request.grantType === 'refresh_token')

  function refused(status: 401 | 403, challenge?: string): Response {
    return new Response(null, {
      status,
      ...(challenge ? { headers: { 'www-authenticate': challenge } } : {}),
    })
  }

  async function reason(promise: Promise<unknown>): Promise<string> {
    const error = await promise.then(
      () => undefined,
      (failure: unknown) => failure,
    )
    if (!(error instanceof McpOAuthNeedsReconnectError))
      throw new Error(`expected a sign-in error, got ${error}`)
    return error.reason
  }

  it('sends the stored token while it is not close to expiry', async () => {
    const server = await start()
    const { authorizer } = setup(server)
    expect(await authorizer.headers()).toEqual({ authorization: 'Bearer old-access' })
    expect(server.paths()).toEqual([])
  })

  it('refreshes within 30 s of expiry', async () => {
    const server = await start()
    const record = recordFor(server, {
      tokens: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: NOW + 20_000,
        scope: ['read'],
      },
    })
    const { authorizer, memory } = setup(server, record)
    expect(await authorizer.headers()).toEqual({ authorization: 'Bearer at-1' })
    expect(refreshGrants(server)).toHaveLength(1)
    expect(await memory.read(SERVER_ID)).toMatchObject({ rev: 5, epoch: 1, tokens: { accessToken: 'at-1' } })
  })

  it('logged-out record: login-required, nothing sent', async () => {
    const server = await start()
    const { authorizer } = setup(server, { version: 2, kind: 'oauth', epoch: 2, rev: 6, requiredScope: [] })
    expect(await reason(authorizer.headers())).toBe('login-required')
    expect(server.paths()).toEqual([])
  })

  it('no record or a credential written before the current format: login-required', async () => {
    const server = await start()
    expect(await reason(setup(server, null).authorizer.headers())).toBe('login-required')
    expect(await reason(setup(server, { legacy: true }).authorizer.headers())).toBe('login-required')
    expect(server.paths()).toEqual([])
  })

  it('epoch changed after the first request: login-required', async () => {
    const server = await start()
    const { authorizer, memory } = setup(server)
    await authorizer.headers()
    // Signed out and in again elsewhere: a new token, but this connection must not carry it.
    memory.seed(SERVER_ID, recordFor(server, { epoch: 2, rev: 6 }))
    expect(await reason(authorizer.headers())).toBe('login-required')
  })

  it('rev moved by another process: uses the new token without a token request', async () => {
    const server = await start()
    const { authorizer, memory } = setup(server)
    const sent = await authorizer.headers()
    const moved = recordFor(server, {
      rev: 5,
      tokens: {
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresAt: NOW + HOUR,
        scope: ['read'],
      },
    })
    memory.seed(SERVER_ID, moved)
    // A 401 for the old token after someone else wrote a new one: resend with the new one.
    expect(await authorizer.rejected(refused(401), sent)).toBe('retry')
    expect(await authorizer.headers()).toEqual({ authorization: 'Bearer new-access' })
    expect(server.requests()).toEqual([])
  })

  it('401: refreshes once and asks for one resend', async () => {
    const server = await start()
    const { authorizer, memory } = setup(server)
    const sent = await authorizer.headers()
    expect(await authorizer.rejected(refused(401, 'Bearer error="invalid_token"'), sent)).toBe('retry')
    expect(refreshGrants(server)).toHaveLength(1)
    expect(await authorizer.headers()).toEqual({ authorization: 'Bearer at-1' })
    expect(await memory.read(SERVER_ID)).toMatchObject({ rev: 5, requiredScope: [] })
  })

  it('401 for a token this request just refreshed: login-required, no second refresh', async () => {
    const server = await start()
    const record = recordFor(server, {
      tokens: { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: NOW - 1, scope: ['read'] },
    })
    const { authorizer } = setup(server, record)
    const sent = await authorizer.headers()
    expect(await reason(authorizer.rejected(refused(401), sent))).toBe('login-required')
    expect(refreshGrants(server)).toHaveLength(1)
  })

  it('401 that cannot be refreshed: login-required', async () => {
    const server = await start()
    server.setTokenResponse(() => ({ error: 'invalid_grant' }))
    const { authorizer, memory } = setup(server)
    const sent = await authorizer.headers()
    expect(await reason(authorizer.rejected(refused(401), sent))).toBe('login-required')
    expect((await memory.read(SERVER_ID)) as McpOAuthRecord).not.toHaveProperty('tokens')
  })

  it('401 without a refresh token looks once more and uses a sign-in made elsewhere', async () => {
    const server = await start()
    const memory = createMemoryOAuthStore()
    const noRefresh = recordFor(server, {
      tokens: { accessToken: 'old-access', expiresAt: NOW + HOUR, scope: ['read'] },
    })
    memory.seed(SERVER_ID, noRefresh)
    let reads = 0
    // The second read (inside rejected) sees the old record; then another process signs in again.
    const store: McpOAuthStore = {
      update: memory.update,
      async read(serverId) {
        const value = await memory.read(serverId)
        reads += 1
        if (reads === 2)
          memory.seed(
            SERVER_ID,
            recordFor(server, {
              rev: 5,
              tokens: { accessToken: 'again', refreshToken: 'r', expiresAt: NOW + HOUR, scope: ['read'] },
            }),
          )
        return value
      },
    }
    const { authorizer } = setup(server, noRefresh, { store })
    const sent = await authorizer.headers()
    expect(await authorizer.rejected(refused(401), sent)).toBe('retry')
    expect(await authorizer.headers()).toEqual({ authorization: 'Bearer again' })
    expect(server.requests()).toEqual([])
  })

  it('401 with a scope it was not granted records that scope before refreshing', async () => {
    const server = await start()
    const { authorizer, memory } = setup(server)
    const sent = await authorizer.headers()
    expect(
      await authorizer.rejected(refused(401, 'Bearer error="invalid_token", scope="read extra"'), sent),
    ).toBe('retry')
    expect(refreshGrants(server)).toHaveLength(1)
    expect(await memory.read(SERVER_ID)).toMatchObject({ epoch: 1, rev: 6, requiredScope: ['extra'] })
  })

  it('403 insufficient_scope records requiredScope and throws insufficient-scope', async () => {
    const server = await start()
    const { authorizer, memory } = setup(server, recordFor(server, { requiredScope: ['write'] }))
    const sent = await authorizer.headers()
    const answer = authorizer.rejected(
      refused(403, 'Bearer error="insufficient_scope", scope="write admin"'),
      sent,
    )
    expect(await reason(answer)).toBe('insufficient-scope')
    expect(await memory.read(SERVER_ID)).toMatchObject({
      epoch: 1,
      rev: 5,
      requiredScope: ['write', 'admin'],
      tokens: { accessToken: 'old-access' },
    })
    expect(memory.writes(SERVER_ID)).toBe(1)
    expect(server.requests()).toEqual([])
  })

  it('any other 403 is the server refusing, not a sign-in matter', async () => {
    const server = await start()
    const { authorizer, memory } = setup(server)
    const sent = await authorizer.headers()
    expect(await authorizer.rejected(refused(403), sent)).toBe('fail')
    expect(await authorizer.rejected(refused(403, 'Bearer error="invalid_request"'), sent)).toBe('fail')
    expect(memory.writes(SERVER_ID)).toBe(0)
  })

  it('endpoint differs: endpoint-changed', async () => {
    const server = await start()
    const { authorizer } = setup(server, recordFor(server), { serverUrl: new URL('/other', server.url) })
    expect(await reason(authorizer.headers())).toBe('endpoint-changed')
    expect(server.paths()).toEqual([])
  })

  it('a store that cannot be read means sign-in, with the failure kept as the cause', async () => {
    const server = await start()
    const failure = new Error('database is locked')
    const store: McpOAuthStore = {
      update: createMemoryOAuthStore().update,
      read: async () => Promise.reject(failure),
    }
    const { authorizer } = setup(server, null, { store })
    const error = await authorizer.headers().then(
      () => undefined,
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(McpOAuthNeedsReconnectError)
    expect((error as Error).cause).toBe(failure)
  })

  it('two requests due at once spend the refresh token once', async () => {
    const server = await start()
    const record = recordFor(server, {
      tokens: { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: NOW - 1, scope: ['read'] },
    })
    const { authorizer } = setup(server, record)
    const [first, second] = await Promise.all([authorizer.headers(), authorizer.headers()])
    expect(first).toEqual({ authorization: 'Bearer at-1' })
    expect(second).toEqual({ authorization: 'Bearer at-1' })
    expect(refreshGrants(server)).toHaveLength(1)
  })
})
