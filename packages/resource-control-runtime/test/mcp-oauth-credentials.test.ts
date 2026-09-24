import { createServer, type Server as HttpServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createMcpOAuthCredentialResolver,
  type McpOAuthCredentialStore,
} from '../src/mcp-oauth-credentials.js'
import { credentialRefFor } from '../src/oauth-http-handler.js'

/**
 * Real `node:http` fixture authorization server (RFC 8414 discovery + `/token`), same pattern
 * oauth-http-handler.test.ts and oauth-client.test.ts already establish - no mocking of the SDK's
 * own OAuth functions. Covers `createMcpOAuthCredentialResolver()`, the real worker-side
 * implementation `resolvedConfig()`'s `oauthCredentials` option is filled with in production
 * (packages/worker-runtime/src/main.ts via resource-control-worker/src/runtime-bootstrap.ts).
 */
describe('mcp-oauth-credentials', () => {
  const cleanup: Array<() => Promise<void>> = []
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((close) => close()))
  })

  function listen(server: HttpServer): Promise<URL> {
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('missing fixture address')
        resolve(new URL(`http://127.0.0.1:${address.port}`))
      })
    })
  }

  function closeHttpServer(server: HttpServer): Promise<void> {
    server.closeAllConnections()
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }

  type TokenResponse = { status: number; body: unknown }

  async function startFixtureAuthServer(): Promise<{
    url: URL
    tokenRequests: URLSearchParams[]
    setTokenResponse(response: TokenResponse | undefined): void
    setTokenRedirect(location: string | undefined): void
  }> {
    const tokenRequests: URLSearchParams[] = []
    let tokenResponse: TokenResponse | undefined
    let tokenRedirect: string | undefined
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '', 'http://127.0.0.1')
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            issuer: serverUrl().toString(),
            authorization_endpoint: new URL('/authorize', serverUrl()).toString(),
            token_endpoint: new URL('/token', serverUrl()).toString(),
            response_types_supported: ['code'],
            code_challenge_methods_supported: ['S256'],
          }),
        )
        return
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        let body = ''
        req.on('data', (chunk) => {
          body += String(chunk)
        })
        req.on('end', () => {
          tokenRequests.push(new URLSearchParams(body))
          if (tokenRedirect) {
            res.writeHead(307, { location: tokenRedirect }).end()
            return
          }
          if (!tokenResponse) {
            res.writeHead(404).end()
            return
          }
          res
            .writeHead(tokenResponse.status, { 'content-type': 'application/json' })
            .end(JSON.stringify(tokenResponse.body))
        })
        return
      }
      res.writeHead(404).end()
    })
    let boundUrl: URL | undefined
    const serverUrl = () => {
      if (!boundUrl) throw new Error('fixture not yet bound')
      return boundUrl
    }
    boundUrl = await listen(server)
    cleanup.push(() => closeHttpServer(server))
    return {
      url: boundUrl,
      tokenRequests,
      setTokenResponse: (response) => {
        tokenResponse = response
      },
      setTokenRedirect: (location) => {
        tokenRedirect = location
      },
    }
  }

  /** Stands in for "the arbitrary internal host an attacker-compromised token endpoint could bounce
   * this daemon-side request to" - same role as oauth-http-handler.test.ts's own victim server. */
  async function startVictimServer(): Promise<{ url: URL; requestCount: () => number }> {
    let count = 0
    const server = createServer((_req, res) => {
      count++
      res.writeHead(404).end()
    })
    const url = await listen(server)
    cleanup.push(() => closeHttpServer(server))
    return { url, requestCount: () => count }
  }

  function fakeCredentialStore(
    initial?: Record<string, Record<string, unknown> | undefined>,
  ): McpOAuthCredentialStore & { putOAuth: ReturnType<typeof vi.fn> } {
    const store = new Map<string, Record<string, unknown>>(
      Object.entries(initial ?? {}).filter(([, v]) => v) as never,
    )
    return {
      read: async (ref: string) => (store.has(ref) ? (store.get(ref) as never) : null),
      putOAuth: vi.fn(async (ref: string, value: Record<string, unknown>) => {
        store.set(ref, { kind: 'oauth', ...value })
      }),
    }
  }

  it('returns undefined when no credential is stored for this server', async () => {
    const resolver = createMcpOAuthCredentialResolver({ credentialStore: fakeCredentialStore() })
    const result = await resolver(
      'srv-1',
      new AbortController().signal,
      new URL('https://mcp.example.com'),
      undefined,
    )
    expect(result).toBeUndefined()
  })

  it('returns undefined for a non-oauth stored credential (kind mismatch)', async () => {
    const store = fakeCredentialStore({
      [credentialRefFor('srv-1')]: { kind: 'api-key', version: 1, provider: 'x', value: 'k' },
    })
    const resolver = createMcpOAuthCredentialResolver({ credentialStore: store })
    const result = await resolver(
      'srv-1',
      new AbortController().signal,
      new URL('https://mcp.example.com'),
      undefined,
    )
    expect(result).toBeUndefined()
  })

  it('resolves the stored credential without any network call', async () => {
    const store = fakeCredentialStore({
      [credentialRefFor('srv-1')]: {
        kind: 'oauth',
        version: 1,
        provider: 'mcp-oauth',
        accessToken: 'tok-1',
        refreshToken: 'refresh-1',
        expiresAt: Date.now() + 60_000,
        scope: ['a'],
        grantId: 'srv-1',
      },
    })
    const resolver = createMcpOAuthCredentialResolver({ credentialStore: store })
    const result = await resolver(
      'srv-1',
      new AbortController().signal,
      new URL('https://mcp.example.com'),
      undefined,
    )
    expect(result?.credential.accessToken).toBe('tok-1')
    expect(result?.credential.refreshToken).toBe('refresh-1')
  })

  it('refresh() discovers the authorization server, POSTs the refresh grant, and persists the result', async () => {
    const fixture = await startFixtureAuthServer()
    fixture.setTokenResponse({
      status: 200,
      body: { access_token: 'tok-2', refresh_token: 'refresh-2', expires_in: 3600, token_type: 'Bearer' },
    })
    const store = fakeCredentialStore({
      [credentialRefFor('srv-1')]: {
        kind: 'oauth',
        version: 1,
        provider: 'mcp-oauth',
        accessToken: 'tok-1',
        refreshToken: 'refresh-1',
        expiresAt: Date.now() - 1_000,
        scope: [],
        grantId: 'srv-1',
      },
    })
    const resolver = createMcpOAuthCredentialResolver({ credentialStore: store })
    const result = await resolver('srv-1', new AbortController().signal, fixture.url, 'static-client-id')
    const refreshed = await result?.refresh()

    expect(refreshed?.accessToken).toBe('tok-2')
    expect(refreshed?.refreshToken).toBe('refresh-2')
    expect(fixture.tokenRequests[0]?.get('grant_type')).toBe('refresh_token')
    expect(fixture.tokenRequests[0]?.get('refresh_token')).toBe('refresh-1')
    expect(store.putOAuth).toHaveBeenCalledWith(
      credentialRefFor('srv-1'),
      expect.objectContaining({ accessToken: 'tok-2', refreshToken: 'refresh-2' }),
    )
  })

  it('refresh() throws and does not persist anything when the response omits expires_in', async () => {
    const fixture = await startFixtureAuthServer()
    fixture.setTokenResponse({
      status: 200,
      body: { access_token: 'tok-2', refresh_token: 'refresh-2', token_type: 'Bearer' },
    })
    const store = fakeCredentialStore({
      [credentialRefFor('srv-1')]: {
        kind: 'oauth',
        version: 1,
        provider: 'mcp-oauth',
        accessToken: 'tok-1',
        refreshToken: 'refresh-1',
        expiresAt: Date.now() - 1_000,
        scope: [],
        grantId: 'srv-1',
      },
    })
    const resolver = createMcpOAuthCredentialResolver({ credentialStore: store })
    const result = await resolver('srv-1', new AbortController().signal, fixture.url, 'static-client-id')
    await expect(result?.refresh()).rejects.toThrow()
    expect(store.putOAuth).not.toHaveBeenCalled()
  })

  it('preserves the original refresh token when the response omits refresh_token (RFC 6749 §5.1, SDK default)', async () => {
    // The SDK's own refreshAuthorization() falls back to the request's refreshToken when the
    // server's response does not include a new one ("Preserve original refresh token if server
    // didn't return a new one" - see the installed SDK's client/auth.js) - this is not this
    // module's own logic, but the resulting persisted value is: confirms the fallback flows
    // through to what actually gets written to the credential store.
    const fixture = await startFixtureAuthServer()
    fixture.setTokenResponse({
      status: 200,
      body: { access_token: 'tok-2', expires_in: 3600, token_type: 'Bearer' },
    })
    const store = fakeCredentialStore({
      [credentialRefFor('srv-1')]: {
        kind: 'oauth',
        version: 1,
        provider: 'mcp-oauth',
        accessToken: 'tok-1',
        refreshToken: 'refresh-1',
        expiresAt: Date.now() - 1_000,
        scope: [],
        grantId: 'srv-1',
      },
    })
    const resolver = createMcpOAuthCredentialResolver({ credentialStore: store })
    const result = await resolver('srv-1', new AbortController().signal, fixture.url, 'static-client-id')
    const refreshed = await result?.refresh()
    expect(refreshed?.refreshToken).toBe('refresh-1')
    expect(store.putOAuth).toHaveBeenCalledWith(
      credentialRefFor('srv-1'),
      expect.objectContaining({ refreshToken: 'refresh-1' }),
    )
  })

  it('refresh() fails fast with no network call when no staticClientId is configured (DCR client_id gap)', async () => {
    // Known, documented gap (see mcp-oauth-credentials.ts's refresh() comment and this task's
    // report): a DCR-registered client_id is never persisted anywhere this worker-process resolver
    // can reach, and refreshAuthorization() requires clientInformation. Asserting zero requests
    // (not just "it throws") is the point of this test -- proves this fails BEFORE ever contacting
    // the authorization server, not via some downstream 401 that would still leak a request.
    const fixture = await startFixtureAuthServer()
    fixture.setTokenResponse({
      status: 200,
      body: { access_token: 'tok-2', refresh_token: 'refresh-2', expires_in: 3600, token_type: 'Bearer' },
    })
    const store = fakeCredentialStore({
      [credentialRefFor('srv-1')]: {
        kind: 'oauth',
        version: 1,
        provider: 'mcp-oauth',
        accessToken: 'tok-1',
        refreshToken: 'refresh-1',
        expiresAt: Date.now() - 1_000,
        scope: [],
        grantId: 'srv-1',
      },
    })
    const resolver = createMcpOAuthCredentialResolver({ credentialStore: store })
    const result = await resolver('srv-1', new AbortController().signal, fixture.url, undefined)
    await expect(result?.refresh()).rejects.toThrow()
    expect(fixture.tokenRequests).toHaveLength(0)
    expect(store.putOAuth).not.toHaveBeenCalled()
  })

  it('refuses to follow a redirect from the token endpoint (SSRF guard, same discipline as oauth-http-handler.ts)', async () => {
    const fixture = await startFixtureAuthServer()
    const victim = await startVictimServer()
    fixture.setTokenRedirect(victim.url.toString())
    const store = fakeCredentialStore({
      [credentialRefFor('srv-1')]: {
        kind: 'oauth',
        version: 1,
        provider: 'mcp-oauth',
        accessToken: 'tok-1',
        refreshToken: 'refresh-1',
        expiresAt: Date.now() - 1_000,
        scope: [],
        grantId: 'srv-1',
      },
    })
    const resolver = createMcpOAuthCredentialResolver({ credentialStore: store })
    const result = await resolver('srv-1', new AbortController().signal, fixture.url, 'static-client-id')
    await expect(result?.refresh()).rejects.toThrow()
    expect(victim.requestCount()).toBe(0)
    expect(store.putOAuth).not.toHaveBeenCalled()
  })
})
