import { afterEach, describe, expect, it } from 'vitest'
import {
  beginMcpOAuthLogin,
  completeMcpOAuthLogin,
  type McpOAuthLoginStart,
  McpOAuthLoginSuperseded,
  type McpOAuthSummary,
  summarizeMcpOAuth,
} from '../src/mcp-oauth-login.js'
import type { McpOAuthRecord } from '../src/mcp-oauth-store.js'
import { type FakeOAuthOptions, type FakeOAuthServer, startFakeOAuthServer } from './helpers/fake-oauth.js'
import { createMemoryOAuthStore, type MemoryOAuthStore } from './helpers/memory-oauth-store.js'

const SERVER_ID = 'docs'
const NOW = 1_700_000_000_000
const REDIRECT = 'http://127.0.0.1:4177/oauth/docs/callback'
const EMPTY: McpOAuthSummary = { epoch: 0, signedIn: false, refreshable: false, scope: [], requiredScope: [] }

describe('MCP OAuth sign-in', () => {
  let fake: FakeOAuthServer | undefined
  afterEach(async () => {
    await fake?.close()
    fake = undefined
  })

  async function start(options: FakeOAuthOptions = {}): Promise<FakeOAuthServer> {
    fake = await startFakeOAuthServer({ prm: { resource: '/mcp', scopes: ['read'] }, ...options })
    return fake
  }

  function begin(
    server: FakeOAuthServer,
    extra: { summary?: McpOAuthSummary; staticClientId?: string; redirectUri?: string } = {},
  ) {
    return beginMcpOAuthLogin({
      serverId: SERVER_ID,
      serverUrl: server.serverUrl,
      summary: extra.summary ?? EMPTY,
      redirectUri: extra.redirectUri ?? REDIRECT,
      fetchImpl: server.fetchImpl,
      ...(extra.staticClientId ? { staticClientId: extra.staticClientId } : {}),
    })
  }

  function started(result: Awaited<ReturnType<typeof beginMcpOAuthLogin>>): McpOAuthLoginStart {
    if ('pendingClientId' in result) throw new Error('expected an authorization URL')
    return result
  }

  /** Plays the browser: follows the authorization URL and returns the code the server redirects with. */
  async function authorize(server: FakeOAuthServer, login: McpOAuthLoginStart): Promise<string> {
    const response = await server.fetchImpl(login.authorizationUrl.href, { redirect: 'manual' })
    const location = response.headers.get('location')
    if (!location) throw new Error(`authorize answered ${response.status}`)
    const code = new URL(location).searchParams.get('code')
    if (!code) throw new Error('no code in the redirect')
    return code
  }

  function complete(
    server: FakeOAuthServer,
    store: MemoryOAuthStore,
    login: McpOAuthLoginStart,
    code: string,
    staticClient?: { clientId: string; clientSecret?: string },
  ) {
    return completeMcpOAuthLogin({
      serverId: SERVER_ID,
      serverUrl: server.serverUrl,
      expectedEpoch: login.expectedEpoch,
      code,
      codeVerifier: login.codeVerifier,
      redirectUri: REDIRECT,
      client: login.client,
      requestedScope: login.requestedScope,
      store,
      fetchImpl: server.fetchImpl,
      now: () => NOW,
      ...(staticClient ? { staticClient } : {}),
    })
  }

  async function record(store: MemoryOAuthStore): Promise<McpOAuthRecord> {
    const read = await store.read(SERVER_ID)
    if (!read || 'legacy' in read) throw new Error('no v2 record')
    return read
  }

  it('begin asks for scope, offline_access and resource', async () => {
    const server = await start({ asScopes: ['read', 'offline_access'] })
    const login = started(await begin(server))

    const url = login.authorizationUrl
    expect(url.searchParams.get('scope')?.split(' ')).toEqual(['read', 'offline_access'])
    expect(url.searchParams.get('resource')).toBe(new URL('/mcp', server.url).href)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT)
    expect(login.requestedScope).toEqual(['read', 'offline_access'])
    expect(login.expectedEpoch).toBe(0)
    expect(login.client.clientId).toBe('fake-client')
  })

  it('begin leaves offline_access out when the authorization server does not support it', async () => {
    const server = await start()
    const login = started(await begin(server))
    expect(login.authorizationUrl.searchParams.get('scope')).toBe('read')
  })

  it('begin asks for granted plus required scope after a 403', async () => {
    const server = await start()
    const summary: McpOAuthSummary = {
      ...EMPTY,
      epoch: 3,
      signedIn: true,
      scope: ['a'],
      requiredScope: ['b'],
    }
    const login = started(await begin(server, { summary }))

    const scope = login.authorizationUrl.searchParams.get('scope')?.split(' ') ?? []
    expect([...scope].sort()).toEqual(['a', 'b'])
    expect(login.expectedEpoch).toBe(3)
  })

  it('begin reuses the stored DCR client when the redirect URI matches', async () => {
    const server = await start()
    const summary: McpOAuthSummary = { ...EMPTY, client: { clientId: 'kept-client', redirectUri: REDIRECT } }
    const login = started(await begin(server, { summary }))

    expect(login.client).toEqual({ clientId: 'kept-client' })
    expect(server.paths()).not.toContain('/register')
  })

  it('begin registers again when the stored client was registered for another redirect URI', async () => {
    const server = await start({ registration: { clientId: 'new-client', clientSecret: 'dcr-secret' } })
    const summary: McpOAuthSummary = {
      ...EMPTY,
      client: { clientId: 'kept-client', redirectUri: 'http://127.0.0.1:9999/oauth/docs/callback' },
    }
    const login = started(await begin(server, { summary }))

    expect(login.client).toEqual({ clientId: 'new-client', clientSecret: 'dcr-secret' })
    expect(server.paths()).toContain('/register')
  })

  it('begin prefers a static client ID over registration', async () => {
    const server = await start()
    const login = started(await begin(server, { staticClientId: 'static-client' }))
    expect(login.client).toEqual({ clientId: 'static-client' })
    expect(server.paths()).not.toContain('/register')
  })

  it('complete sends the same resource and the chosen client auth, writes a v2 record', async () => {
    const server = await start({
      authMethods: ['client_secret_post'],
      registration: {
        clientId: 'dcr-client',
        clientSecret: 'dcr-secret',
        tokenEndpointAuthMethod: 'client_secret_post',
      },
    })
    const store = createMemoryOAuthStore()
    store.seed(SERVER_ID, { version: 2, kind: 'oauth', epoch: 4, rev: 7, requiredScope: [] })
    const login = started(await begin(server, { summary: { ...EMPTY, epoch: 4 } }))
    expect(login.client).toEqual({
      clientId: 'dcr-client',
      clientSecret: 'dcr-secret',
      tokenEndpointAuthMethod: 'client_secret_post',
    })

    await complete(server, store, login, await authorize(server, login))

    const [request] = server.requests()
    expect(request?.grantType).toBe('authorization_code')
    expect(request?.form.resource).toBe(login.authorizationUrl.searchParams.get('resource'))
    expect(request?.form.client_id).toBe('dcr-client')
    expect(request?.form.client_secret).toBe('dcr-secret')
    expect(request?.headers.authorization).toBeUndefined()

    const written = await record(store)
    expect(written.epoch).toBe(4)
    expect(written.rev).toBe(8)
    expect(written.client).toEqual({
      clientId: 'dcr-client',
      clientSecret: 'dcr-secret',
      tokenEndpointAuthMethod: 'client_secret_post',
      redirectUri: REDIRECT,
    })
    expect(written.server).toEqual({
      endpoint: server.serverUrl.href,
      authorizationServer: server.httpsUrl.href,
      tokenEndpoint: `${server.httpsUrl.origin}/token`,
      issuer: server.httpsUrl.origin,
      resource: new URL('/mcp', server.url).href,
    })
    expect(written.tokens).toEqual({
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAt: NOW + 3_600_000,
      scope: ['read'],
    })
  })

  it('a static client sends its secret with basic auth and the secret is not stored', async () => {
    const server = await start()
    const store = createMemoryOAuthStore()
    const login = started(await begin(server, { staticClientId: 'static-client' }))

    await complete(server, store, login, await authorize(server, login), {
      clientId: 'static-client',
      clientSecret: 'static-secret',
    })

    const [request] = server.requests()
    expect(request?.headers.authorization).toBe(
      `Basic ${Buffer.from('static-client:static-secret').toString('base64')}`,
    )
    expect(request?.form.client_secret).toBeUndefined()
    const written = await record(store)
    expect(written.client).toEqual({ clientId: 'static-client', redirectUri: REDIRECT })
    expect(JSON.stringify(written)).not.toContain('static-secret')
  })

  it('a reused DCR client takes its secret and method from the stored record', async () => {
    const server = await start({ authMethods: ['client_secret_post', 'client_secret_basic'] })
    const store = createMemoryOAuthStore()
    store.seed(SERVER_ID, {
      version: 2,
      kind: 'oauth',
      epoch: 1,
      rev: 2,
      client: {
        clientId: 'kept-client',
        clientSecret: 'kept-secret',
        tokenEndpointAuthMethod: 'client_secret_post',
        redirectUri: REDIRECT,
      },
      requiredScope: [],
    })
    const summary = summarizeMcpOAuth(await store.read(SERVER_ID))
    const login = started(await begin(server, { summary }))
    expect(login.client).toEqual({ clientId: 'kept-client' })

    await complete(server, store, login, await authorize(server, login))

    const [request] = server.requests()
    expect(request?.form.client_secret).toBe('kept-secret')
    expect((await record(store)).client?.clientSecret).toBe('kept-secret')
  })

  it('complete after a sign-out writes nothing', async () => {
    const server = await start()
    const store = createMemoryOAuthStore()
    store.seed(SERVER_ID, { version: 2, kind: 'oauth', epoch: 1, rev: 3, requiredScope: [] })
    const login = started(await begin(server, { summary: summarizeMcpOAuth(await store.read(SERVER_ID)) }))
    const code = await authorize(server, login)
    // Sign-out while the browser was away.
    store.seed(SERVER_ID, { version: 2, kind: 'oauth', epoch: 2, rev: 4, requiredScope: [] })
    const before = await store.read(SERVER_ID)

    const error = await complete(server, store, login, code).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(McpOAuthLoginSuperseded)
    expect((error as McpOAuthLoginSuperseded).code).toBe('MCP_OAUTH_LOGIN_SUPERSEDED')
    expect(await store.read(SERVER_ID)).toEqual(before)
    expect(store.writes(SERVER_ID)).toBe(0)
    expect(server.requests()).toEqual([])
  })

  it('a sign-out during the token request still wins', async () => {
    const server = await start()
    const store = createMemoryOAuthStore()
    const login = started(await begin(server))
    const code = await authorize(server, login)
    server.setTokenResponse(() => {
      store.seed(SERVER_ID, { version: 2, kind: 'oauth', epoch: 1, rev: 1, requiredScope: [] })
      return { access_token: 'late', token_type: 'Bearer', expires_in: 3600 }
    })

    await expect(complete(server, store, login, code)).rejects.toBeInstanceOf(McpOAuthLoginSuperseded)
    expect((await record(store)).tokens).toBeUndefined()
    expect(store.writes(SERVER_ID)).toBe(0)
  })

  it('requiredScope is cleared only when the new grant covers it', async () => {
    const server = await start()
    const store = createMemoryOAuthStore()
    const seed = (): void =>
      store.seed(SERVER_ID, { version: 2, kind: 'oauth', epoch: 0, rev: 1, requiredScope: ['b'] })
    const summary: McpOAuthSummary = { ...EMPTY, scope: ['a'], requiredScope: ['b'] }

    seed()
    server.setTokenResponse(() => ({ access_token: 'x', token_type: 'Bearer', scope: 'a' }))
    let login = started(await begin(server, { summary }))
    await complete(server, store, login, await authorize(server, login))
    expect((await record(store)).requiredScope).toEqual(['b'])

    seed()
    server.setTokenResponse(() => ({ access_token: 'y', token_type: 'Bearer', scope: 'a b' }))
    login = started(await begin(server, { summary }))
    await complete(server, store, login, await authorize(server, login))
    expect((await record(store)).requiredScope).toEqual([])
  })

  it('signs in without refresh_token or expires_in', async () => {
    const server = await start()
    const store = createMemoryOAuthStore()
    server.setTokenResponse(() => ({
      access_token: 'only-access',
      token_type: 'Bearer',
      scope: 'https://www.googleapis.com/auth/drive.readonly openid Read:All',
    }))
    const login = started(await begin(server))

    await complete(server, store, login, await authorize(server, login))

    const written = await record(store)
    expect(written.tokens).toEqual({
      accessToken: 'only-access',
      expiresAt: NOW + 3_600_000,
      scope: ['https://www.googleapis.com/auth/drive.readonly', 'openid', 'Read:All'],
    })
    expect(summarizeMcpOAuth(written)).toMatchObject({ signedIn: true, refreshable: false })
  })

  it('a fresh sign-in replaces a record that cannot be read', async () => {
    const server = await start()
    const store = createMemoryOAuthStore()
    store.seedUnreadable(SERVER_ID)
    await expect(store.read(SERVER_ID)).rejects.toThrow()
    const login = started(await begin(server))

    await complete(server, store, login, await authorize(server, login))

    const written = await record(store)
    expect(written.epoch).toBe(0)
    expect(written.tokens?.accessToken).toBe('at-1')
  })

  it('summary shows sign-in state without any token or secret', () => {
    const summary = summarizeMcpOAuth({
      version: 2,
      kind: 'oauth',
      epoch: 2,
      rev: 9,
      client: {
        clientId: 'c',
        clientSecret: 'dcr-secret',
        tokenEndpointAuthMethod: 'none',
        redirectUri: REDIRECT,
      },
      server: {
        endpoint: 'https://x/mcp',
        authorizationServer: 'https://x/',
        tokenEndpoint: 'https://x/token',
        resource: 'https://x/mcp',
      },
      tokens: { accessToken: 'secret-access', refreshToken: 'secret-refresh', expiresAt: 5, scope: ['read'] },
      requiredScope: ['write'],
    })
    expect(summary).toEqual({
      epoch: 2,
      signedIn: true,
      refreshable: true,
      expiresAt: 5,
      scope: ['read'],
      requiredScope: ['write'],
      client: { clientId: 'c', redirectUri: REDIRECT },
    })
    expect(summarizeMcpOAuth(null)).toEqual(EMPTY)
    expect(summarizeMcpOAuth({ legacy: true })).toEqual(EMPTY)
    expect(summarizeMcpOAuth({ version: 2, kind: 'oauth', epoch: 3, rev: 4, requiredScope: [] })).toEqual({
      ...EMPTY,
      epoch: 3,
    })
  })

  it('pendingClientId when there is no static client and no registration endpoint', async () => {
    const server = await start()
    const result = await beginMcpOAuthLogin({
      serverId: SERVER_ID,
      serverUrl: server.serverUrl,
      summary: EMPTY,
      redirectUri: REDIRECT,
      // Metadata fetches fail: no registration endpoint is known.
      fetchImpl: async (input, init) => {
        if (String(input).includes('oauth-authorization-server')) return new Response('', { status: 404 })
        return server.fetchImpl(input, init)
      },
    })
    expect(result).toEqual({ pendingClientId: true })
  })
})
