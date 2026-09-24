import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOAuthHttpHandler, type OAuthCredentialStoreWriter } from '../src/oauth-http-handler.js'
import { sealOAuthState } from '../src/oauth-state.js'

/**
 * Real `node:http` throughout - both the fixture "authorization server" this handler talks to, and
 * the `IncomingMessage`/`ServerResponse` pair the handler itself receives (via a tiny real HTTP
 * server that does nothing but delegate to the handler and capture what it did, mirroring the
 * pattern already established in packages/resource-control-runtime/test/oauth-client.test.ts and
 * packages/web/test/serve.test.ts, which both drive real listeners with `fetch()` rather than
 * mocking `IncomingMessage`/`ServerResponse` by hand).
 */
describe('oauth-http-handler', () => {
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

  /** Wraps a handler under test (the `(req,res)=>Promise<boolean>` shape `handleAdmin` also uses)
   * in a real listening `node:http` server, so callers drive it with `fetch()` and inspect real
   * status/headers, and 404 when the handler declines (returns false) - matching how server.ts's
   * own fallback would behave. `url` is the bare origin (`URL.origin`, no trailing slash) rather
   * than a `URL` object, specifically so every call site below can safely template-concatenate a
   * path onto it (``${served.url}/oauth/...``) without accidentally producing a double-slash
   * path from `URL#toString()`'s own trailing `/` on a path-less origin - a `//oauth/...` pathname
   * would silently fail this handler's own route regex and every assertion below would degrade to
   * "not found" without saying why. */
  function serveHandler(
    handler: (request: IncomingMessage, response: ServerResponse) => Promise<boolean>,
  ): Promise<{ url: string; close(): Promise<void> }> {
    const server = createServer((req, res) => {
      void handler(req, res).then((handled) => {
        if (!handled) res.writeHead(404).end()
      })
    })
    return listen(server).then((url) => {
      cleanup.push(() => closeHttpServer(server))
      return { url: url.origin, close: () => closeHttpServer(server) }
    })
  }

  type TokenResponse = { status: number; body: unknown }

  /** Plays both the MCP resource server's own origin (no PRM handler is registered unless
   * `setProtectedResourceMetadata` is called, matching oauth-client.test.ts's fixture's default
   * legacy 2025-03-26 fallback) and the authorization server: RFC 8414 discovery + `/authorize`
   * (records the request, does not itself redirect anywhere - the test simulates user consent by
   * reading the query off the recorded request) + `/token`. */
  async function startFixtureAuthServer(): Promise<{
    url: URL
    authorizeRequests: URL[]
    tokenRequests: URLSearchParams[]
    setTokenResponse(response: TokenResponse | undefined): void
    /** Makes `/token` respond with a 307 redirect to `location` instead of a normal response -
     * lets a test drive the token-endpoint half of the redirect-following SSRF finding, the same
     * way `setProtectedResourceMetadata` drives the discovery-endpoint half. */
    setTokenRedirect(location: string | undefined): void
    /** Opts this fixture into also serving RFC 9728 Protected Resource Metadata naming
     * `authorizationServers` as its `authorization_servers` - lets a test drive `/start` against a
     * resource server that names an arbitrary (e.g. attacker-controlled) authorization server. */
    setProtectedResourceMetadata(authorizationServers: string[] | undefined): void
  }> {
    const authorizeRequests: URL[] = []
    const tokenRequests: URLSearchParams[] = []
    let tokenResponse: TokenResponse | undefined
    let tokenRedirect: string | undefined
    let protectedResourceAuthorizationServers: string[] | undefined
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '', 'http://127.0.0.1')
      if (url.pathname === '/.well-known/oauth-protected-resource') {
        if (!protectedResourceAuthorizationServers) {
          res.writeHead(404).end()
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            resource: `${server_url().toString()}/`,
            authorization_servers: protectedResourceAuthorizationServers,
          }),
        )
        return
      }
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            issuer: server_url().toString(),
            authorization_endpoint: new URL('/authorize', server_url()).toString(),
            token_endpoint: new URL('/token', server_url()).toString(),
            response_types_supported: ['code'],
            code_challenge_methods_supported: ['S256'],
          }),
        )
        return
      }
      if (url.pathname === '/authorize') {
        authorizeRequests.push(url)
        res.writeHead(200).end('consent page')
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
    const server_url = () => {
      if (!boundUrl) throw new Error('fixture not yet bound')
      return boundUrl
    }
    boundUrl = await listen(server)
    cleanup.push(() => closeHttpServer(server))
    return {
      url: boundUrl,
      authorizeRequests,
      tokenRequests,
      setTokenResponse: (response) => {
        tokenResponse = response
      },
      setTokenRedirect: (location) => {
        tokenRedirect = location
      },
      setProtectedResourceMetadata: (authorizationServers) => {
        protectedResourceAuthorizationServers = authorizationServers
      },
    }
  }

  /** A server that only counts the requests it receives - stands in for "the arbitrary internal
   * host an attacker-controlled response body names", so a test can assert it was never reached.
   * Same helper as oauth-client.test.ts's own (SSRF guard regression tests, independent security
   * review finding). */
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

  function fakeCredentialStore(): OAuthCredentialStoreWriter & { putOAuth: ReturnType<typeof vi.fn> } {
    return { putOAuth: vi.fn(async () => undefined) }
  }

  const SECRET = 'test-secret-32-bytes-minimum-xxxxxxxxxxxx'

  describe('start', () => {
    it('issues a signed state and a redirect to the authorization endpoint', async () => {
      const fixture = await startFixtureAuthServer()
      const credentialStore = fakeCredentialStore()
      const handler = createOAuthHttpHandler({
        secret: SECRET,
        credentialStore,
        baseUrl: new URL('http://127.0.0.1:4177'),
        resolveServer: async (serverId) =>
          serverId === 'srv-1' ? { serverUrl: fixture.url, staticClientId: 'static-client-id' } : undefined,
      })
      const served = await serveHandler(handler)

      const response = await fetch(`${served.url}/oauth/srv-1/start`, { redirect: 'manual' })

      expect(response.status).toBe(302)
      const location = response.headers.get('location')
      expect(location).toBeTruthy()
      const redirectUrl = new URL(location as string)
      expect(redirectUrl.origin).toBe(fixture.url.origin)
      expect(redirectUrl.pathname).toBe('/authorize')
      expect(redirectUrl.searchParams.get('state')).toMatch(/^.+\..+$/)
      expect(redirectUrl.searchParams.get('client_id')).toBe('static-client-id')
      expect(redirectUrl.searchParams.get('code_challenge_method')).toBe('S256')
      expect(redirectUrl.searchParams.get('code_challenge')).toBeTruthy()
      expect(redirectUrl.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:4177/oauth/srv-1/callback')
      expect(credentialStore.putOAuth).not.toHaveBeenCalled()
    })

    it('returns 404 without contacting any authorization server when the server is unknown', async () => {
      const resolveServer = vi.fn(async () => undefined)
      const handler = createOAuthHttpHandler({
        secret: SECRET,
        credentialStore: fakeCredentialStore(),
        baseUrl: new URL('http://127.0.0.1:4177'),
        resolveServer,
      })
      const served = await serveHandler(handler)

      const response = await fetch(`${served.url}/oauth/unknown-server/start`)

      expect(response.status).toBe(404)
      expect(resolveServer).toHaveBeenCalledWith('unknown-server')
    })

    it('returns a client-registration-required response when no client_id can be resolved', async () => {
      const fixture = await startFixtureAuthServer()
      const handler = createOAuthHttpHandler({
        secret: SECRET,
        credentialStore: fakeCredentialStore(),
        baseUrl: new URL('http://127.0.0.1:4177'),
        // No staticClientId, and the fixture's metadata has no registration_endpoint - DCR is
        // skipped, not attempted, so registerOAuthClient must fall back to pendingClientId.
        resolveServer: async () => ({ serverUrl: fixture.url }),
      })
      const served = await serveHandler(handler)

      const response = await fetch(`${served.url}/oauth/srv-1/start`, { redirect: 'manual' })

      expect(response.status).toBe(409)
      expect(fixture.authorizeRequests).toEqual([])
    })

    it('declines a request outside its own route space, leaving server.ts free to keep looking', async () => {
      const handler = createOAuthHttpHandler({
        secret: SECRET,
        credentialStore: fakeCredentialStore(),
        baseUrl: new URL('http://127.0.0.1:4177'),
        resolveServer: async () => undefined,
      })
      const served = await serveHandler(handler)
      const response = await fetch(`${served.url}/admin/plugins`)
      expect(response.status).toBe(404)
    })

    // Regression test for a BLOCKING finding from independent security review: the reviewer traced
    // a concrete SSRF path through this exact endpoint - `resolveServer(serverId)` returns an
    // already-validated `serverUrl`, but the resource server's own PRM response can name an
    // arbitrary `authorization_servers[0]`, which used to flow unvalidated into every subsequent
    // discovery/registration/token-exchange fetch. This drives the real end-to-end path (not just
    // the lower-level oauth-client.test.ts unit tests) and asserts the attacker-named "victim"
    // target receives zero requests - not merely that some function returns an expected value.
    it("never contacts a PRM-declared authorization server that fails the SSRF guard, and still completes safely via the resource server's own origin", async () => {
      const victim = await startVictimServer()
      const fixture = await startFixtureAuthServer()
      // The attack: a malicious or compromised MCP server's own PRM response names an arbitrary
      // internal host (the victim fixture) as "the authorization server" for this resource.
      fixture.setProtectedResourceMetadata([victim.url.toString()])

      const handler = createOAuthHttpHandler({
        secret: SECRET,
        credentialStore: fakeCredentialStore(),
        baseUrl: new URL('http://127.0.0.1:4177'),
        resolveServer: async (serverId) =>
          serverId === 'srv-1' ? { serverUrl: fixture.url, staticClientId: 'static-client-id' } : undefined,
      })
      const served = await serveHandler(handler)

      const response = await fetch(`${served.url}/oauth/srv-1/start`, { redirect: 'manual' })

      // The SSRF guard makes the PRM-declared authorization server unusable, so resolution falls
      // back to the resource server's own origin (the same safe default used when a server
      // implements no PRM at all) - the flow still succeeds, just never through the attacker's
      // named target.
      expect(response.status).toBe(302)
      const redirectUrl = new URL(response.headers.get('location') as string)
      expect(redirectUrl.origin).toBe(fixture.url.origin)
      expect(victim.requestCount()).toBe(0)
    })

    // Second half of the same SSRF finding: initial-target validation alone is not enough if a
    // redirect response's own Location header is silently followed afterwards (fetch's own
    // default). A compromised discovery endpoint could otherwise bounce this daemon-side request
    // to an arbitrary internal host *after* the validated URL was already dialed.
    it('refuses to follow a redirect from the discovery endpoint instead of silently bouncing there', async () => {
      const victim = await startVictimServer()
      const redirectingServer = createServer((req, res) => {
        if (req.url === '/.well-known/oauth-authorization-server') {
          res.writeHead(302, { location: victim.url.toString() }).end()
          return
        }
        res.writeHead(404).end()
      })
      const redirectingUrl = await listen(redirectingServer)
      cleanup.push(() => closeHttpServer(redirectingServer))

      const handler = createOAuthHttpHandler({
        secret: SECRET,
        credentialStore: fakeCredentialStore(),
        baseUrl: new URL('http://127.0.0.1:4177'),
        resolveServer: async () => ({ serverUrl: redirectingUrl, staticClientId: 'static-client-id' }),
      })
      const served = await serveHandler(handler)

      const response = await fetch(`${served.url}/oauth/srv-1/start`, { redirect: 'manual' })

      // The refused redirect makes RFC 8414 discovery fail, which `tryDiscoverAuthorizationServerMetadata`
      // already treats as "no metadata" (same as a server never implementing discovery at all -
      // an expected, not exceptional, outcome) - the flow still succeeds via the safe fallback
      // authorize URL (this server's own origin), just never through wherever the redirect
      // pointed.
      expect(response.status).toBe(302)
      const redirectUrl = new URL(response.headers.get('location') as string)
      expect(redirectUrl.origin).toBe(redirectingUrl.origin)
      expect(victim.requestCount()).toBe(0)
    })

    // Regression test for the second BLOCKING finding: `/start` had no CSRF/origin protection, so
    // any page the user has open could trigger it via `<img>`/`fetch()`/a hidden `<iframe>` with
    // zero user interaction - a real browser sends `sec-fetch-site: cross-site` for exactly that.
    it('rejects a cross-site request (the drive-by attack a malicious page would actually send)', async () => {
      const resolveServer = vi.fn(async () => undefined)
      const handler = createOAuthHttpHandler({
        secret: SECRET,
        credentialStore: fakeCredentialStore(),
        baseUrl: new URL('http://127.0.0.1:4177'),
        resolveServer,
      })
      const served = await serveHandler(handler)

      const response = await fetch(`${served.url}/oauth/srv-1/start`, {
        headers: { 'sec-fetch-site': 'cross-site' },
      })

      expect(response.status).toBe(403)
      // The origin check happens before any server lookup at all.
      expect(resolveServer).not.toHaveBeenCalled()
    })

    it("rejects a request whose Origin header does not match this server's own origin", async () => {
      const resolveServer = vi.fn(async () => undefined)
      const handler = createOAuthHttpHandler({
        secret: SECRET,
        credentialStore: fakeCredentialStore(),
        baseUrl: new URL('http://127.0.0.1:4177'),
        resolveServer,
      })
      const served = await serveHandler(handler)

      const response = await fetch(`${served.url}/oauth/srv-1/start`, {
        headers: { origin: 'http://evil.example.com' },
      })

      expect(response.status).toBe(403)
      expect(resolveServer).not.toHaveBeenCalled()
    })

    it('allows a same-origin navigation (sec-fetch-site: same-origin) through to the normal flow', async () => {
      const fixture = await startFixtureAuthServer()
      const handler = createOAuthHttpHandler({
        secret: SECRET,
        credentialStore: fakeCredentialStore(),
        baseUrl: new URL('http://127.0.0.1:4177'),
        resolveServer: async () => ({ serverUrl: fixture.url, staticClientId: 'static-client-id' }),
      })
      const served = await serveHandler(handler)

      const response = await fetch(`${served.url}/oauth/srv-1/start`, {
        headers: { 'sec-fetch-site': 'same-origin' },
        redirect: 'manual',
      })

      expect(response.status).toBe(302)
    })
  })

  // Task 5 (mcp-oauth-authorization plan): the JSON-returning twin of `GET /start`, added for
  // `mcp.servers.oauth.start`. `beginAuthorization` is the one function both `handleStart` and
  // `startAuthorization` call into (see oauth-http-handler.ts's `OAuthHttpHandler` doc comment for
  // why this is a plain function on the returned handler rather than a second HTTP route or a daemon
  // RPC method), so every test below has a direct HTTP-path sibling above it: the point of this
  // block is proving the *same* security properties hold on this second entry point, not
  // re-deriving them from scratch.
  describe('startAuthorization (JSON capability)', () => {
    it('returns an authorizeUrl carrying a signed state, mirroring the HTTP /start redirect target exactly', async () => {
      const fixture = await startFixtureAuthServer()
      const credentialStore = fakeCredentialStore()
      const handler = createOAuthHttpHandler({
        secret: SECRET,
        credentialStore,
        baseUrl: new URL('http://127.0.0.1:4177'),
        resolveServer: async (serverId) =>
          serverId === 'srv-1' ? { serverUrl: fixture.url, staticClientId: 'static-client-id' } : undefined,
      })

      const result = await handler.startAuthorization('srv-1')

      expect(result).toHaveProperty('authorizeUrl')
      const authorizeUrl = new URL((result as { authorizeUrl: string }).authorizeUrl)
      expect(authorizeUrl.protocol).toMatch(/^https?:$/)
      expect(authorizeUrl.origin).toBe(fixture.url.origin)
      expect(authorizeUrl.pathname).toBe('/authorize')
      expect(authorizeUrl.searchParams.get('state')).toMatch(/^.+\..+$/)
      expect(authorizeUrl.searchParams.get('client_id')).toBe('static-client-id')
      expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256')
      expect(authorizeUrl.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:4177/oauth/srv-1/callback')
      expect(credentialStore.putOAuth).not.toHaveBeenCalled()
    })

    it('returns {error: mcp_server_not_found} without contacting any authorization server for an unknown serverId', async () => {
      const resolveServer = vi.fn(async () => undefined)
      const handler = createOAuthHttpHandler({
        secret: SECRET,
        credentialStore: fakeCredentialStore(),
        baseUrl: new URL('http://127.0.0.1:4177'),
        resolveServer,
      })

      const result = await handler.startAuthorization('unknown-server')

      expect(result).toEqual({ error: 'mcp_server_not_found' })
      expect(resolveServer).toHaveBeenCalledWith('unknown-server')
    })

    it('rejects a syntactically invalid serverId the same way the HTTP route does, before ever calling resolveServer', async () => {
      const resolveServer = vi.fn(async () => undefined)
      const handler = createOAuthHttpHandler({
        secret: SECRET,
        credentialStore: fakeCredentialStore(),
        baseUrl: new URL('http://127.0.0.1:4177'),
        resolveServer,
      })

      const result = await handler.startAuthorization('Not A Valid Server Id')

      expect(result).toEqual({ error: 'mcp_server_not_found' })
      expect(resolveServer).not.toHaveBeenCalled()
    })

    it("returns {pendingClientId: true} when auto-registration fails, exactly like the HTTP route's 409", async () => {
      const fixture = await startFixtureAuthServer()
      const handler = createOAuthHttpHandler({
        secret: SECRET,
        credentialStore: fakeCredentialStore(),
        baseUrl: new URL('http://127.0.0.1:4177'),
        // No staticClientId, and the fixture's metadata has no registration_endpoint - DCR is
        // skipped, matching the HTTP route's own equivalent test.
        resolveServer: async () => ({ serverUrl: fixture.url }),
      })

      const result = await handler.startAuthorization('srv-1')

      expect(result).toEqual({ pendingClientId: true })
      expect(fixture.authorizeRequests).toEqual([])
    })

    // Load-bearing proof for the whole "shared logic, not duplicated" design: an authorizeUrl minted
    // by this JSON capability must complete through this *same handler instance's* HTTP /callback -
    // the exact reason startAuthorization is a capability on the returned handler rather than a
    // second, independently-constructed handler. If pendingRegistrations/secret ever diverged
    // between the two entry points, this would fail with invalid_oauth_state or a 409.
    it("an authorizeUrl minted here completes through this same instance's HTTP /callback", async () => {
      const fixture = await startFixtureAuthServer()
      const credentialStore = fakeCredentialStore()
      const handler = createOAuthHttpHandler({
        secret: SECRET,
        credentialStore,
        baseUrl: new URL('http://127.0.0.1:4177'),
        resolveServer: async () => ({ serverUrl: fixture.url, staticClientId: 'static-client-id' }),
      })
      const served = await serveHandler(handler)

      const result = await handler.startAuthorization('srv-1')
      const authorizeUrl = new URL((result as { authorizeUrl: string }).authorizeUrl)
      const state = authorizeUrl.searchParams.get('state') as string
      fixture.setTokenResponse({
        status: 200,
        body: {
          access_token: 'tok',
          refresh_token: 'refresh',
          token_type: 'bearer',
          expires_in: 3600,
          scope: 'read',
        },
      })

      const callbackUrl = new URL(`${served.url}/oauth/srv-1/callback`)
      callbackUrl.searchParams.set('state', state)
      callbackUrl.searchParams.set('code', 'auth-code-1')
      const response = await fetch(callbackUrl, { redirect: 'manual' })

      expect(response.status).toBe(302)
      expect(credentialStore.putOAuth).toHaveBeenCalledWith(
        'secret://mcp-oauth/srv-1',
        expect.objectContaining({ accessToken: 'tok', refreshToken: 'refresh' }),
      )
    })

    // Same SSRF regression as the HTTP /start test above (`never contacts a PRM-declared
    // authorization server that fails the SSRF guard...`), driven through startAuthorization
    // instead: proves the guard lives in the shared beginAuthorization() function both entry points
    // call, not duplicated (and possibly forgotten) on only one of them.
    it('never contacts a PRM-declared authorization server that fails the SSRF guard, matching the HTTP /start path', async () => {
      const victim = await startVictimServer()
      const fixture = await startFixtureAuthServer()
      fixture.setProtectedResourceMetadata([victim.url.toString()])
      const handler = createOAuthHttpHandler({
        secret: SECRET,
        credentialStore: fakeCredentialStore(),
        baseUrl: new URL('http://127.0.0.1:4177'),
        resolveServer: async (serverId) =>
          serverId === 'srv-1' ? { serverUrl: fixture.url, staticClientId: 'static-client-id' } : undefined,
      })

      const result = await handler.startAuthorization('srv-1')

      expect(result).toHaveProperty('authorizeUrl')
      const authorizeUrl = new URL((result as { authorizeUrl: string }).authorizeUrl)
      expect(authorizeUrl.origin).toBe(fixture.url.origin)
      expect(victim.requestCount()).toBe(0)
    })
  })

  describe('callback', () => {
    /** Drives a full start -> (simulated consent) -> callback round trip and returns the pieces a
     * test needs to then tamper with the state or replay it. */
    async function completeStart(opts: {
      fixture: Awaited<ReturnType<typeof startFixtureAuthServer>>
      credentialStore: OAuthCredentialStoreWriter
      served: { url: string }
      onAuthorizationStatus?: (serverId: string, status: string) => Promise<void>
      returnTo?: string
    }) {
      const startUrl = new URL(`${opts.served.url}/oauth/srv-1/start`)
      if (opts.returnTo) startUrl.searchParams.set('returnTo', opts.returnTo)
      const startResponse = await fetch(startUrl, { redirect: 'manual' })
      const authorizeUrl = new URL(startResponse.headers.get('location') as string)
      const state = authorizeUrl.searchParams.get('state') as string
      return { state }
    }

    async function setupHandler(opts?: {
      onAuthorizationStatus?: (serverId: string, status: string) => Promise<void>
    }) {
      const fixture = await startFixtureAuthServer()
      const credentialStore = fakeCredentialStore()
      const handler = createOAuthHttpHandler({
        secret: SECRET,
        credentialStore,
        baseUrl: new URL('http://127.0.0.1:4177'),
        resolveServer: async (serverId) =>
          serverId === 'srv-1' ? { serverUrl: fixture.url, staticClientId: 'static-client-id' } : undefined,
        ...(opts?.onAuthorizationStatus ? { onAuthorizationStatus: opts.onAuthorizationStatus } : {}),
      })
      const served = await serveHandler(handler)
      return { fixture, credentialStore, served }
    }

    it('rejects a tampered state before touching the credential store', async () => {
      const { served, credentialStore } = await setupHandler()

      const response = await fetch(`${served.url}/oauth/srv-1/callback?code=abc&state=tampered`)

      expect(response.status).toBe(400)
      expect(credentialStore.putOAuth).not.toHaveBeenCalled()
    })

    it('rejects a state whose sealed payload names a different serverId than the URL', async () => {
      const { fixture, served, credentialStore } = await setupHandler()
      const { state } = await completeStart({ fixture, credentialStore, served })

      // The state really was issued for srv-1 (proven by the happy-path test below reusing the
      // identical flow successfully) - only the callback URL's serverId segment is switched.
      const response = await fetch(`${served.url}/oauth/srv-2/callback?code=abc&state=${state}`)

      expect(response.status).toBe(400)
      expect(credentialStore.putOAuth).not.toHaveBeenCalled()
    })

    it('rejects a replayed state on the second use', async () => {
      const { fixture, served, credentialStore } = await setupHandler()
      fixture.setTokenResponse({
        status: 200,
        body: { access_token: 'at-1', refresh_token: 'rt-1', token_type: 'bearer', expires_in: 3600 },
      })
      const { state } = await completeStart({ fixture, credentialStore, served })

      const first = await fetch(`${served.url}/oauth/srv-1/callback?code=auth-code-1&state=${state}`, {
        redirect: 'manual',
      })
      expect(first.status).toBe(302)
      expect(credentialStore.putOAuth).toHaveBeenCalledTimes(1)

      const second = await fetch(`${served.url}/oauth/srv-1/callback?code=auth-code-1&state=${state}`, {
        redirect: 'manual',
      })
      expect(second.status).toBe(400)
      // The replay must not touch the credential store a second time.
      expect(credentialStore.putOAuth).toHaveBeenCalledTimes(1)
    })

    it('completes the full round trip: stores the exchanged credential under a secret:// ref and redirects back', async () => {
      const statusUpdates: Array<{ serverId: string; status: string }> = []
      const { fixture, served, credentialStore } = await setupHandler({
        onAuthorizationStatus: async (serverId, status) => {
          statusUpdates.push({ serverId, status })
        },
      })
      fixture.setTokenResponse({
        status: 200,
        body: {
          access_token: 'access-token-value',
          refresh_token: 'refresh-token-value',
          token_type: 'bearer',
          expires_in: 3600,
          scope: 'read write',
        },
      })
      const { state } = await completeStart({
        fixture,
        credentialStore,
        served,
        returnTo: '/admin/resources',
      })

      const response = await fetch(`${served.url}/oauth/srv-1/callback?code=auth-code-1&state=${state}`, {
        redirect: 'manual',
      })

      expect(response.status).toBe(302)
      const redirectLocation = new URL(response.headers.get('location') as string)
      expect(redirectLocation.pathname).toBe('/admin/resources')

      expect(credentialStore.putOAuth).toHaveBeenCalledTimes(1)
      const [ref, value] = credentialStore.putOAuth.mock.calls[0] as [string, Record<string, unknown>]
      expect(ref).toBe('secret://mcp-oauth/srv-1')
      expect(value).toMatchObject({
        accessToken: 'access-token-value',
        refreshToken: 'refresh-token-value',
        scope: ['read', 'write'],
      })
      expect(typeof value.expiresAt).toBe('number')
      expect(value.expiresAt as number).toBeGreaterThan(Date.now())

      // Token exchange really carried the PKCE verifier and the exact redirect_uri used at start -
      // not merely "some POST happened".
      const tokenRequest = fixture.tokenRequests.at(-1) as URLSearchParams
      expect(tokenRequest.get('grant_type')).toBe('authorization_code')
      expect(tokenRequest.get('code')).toBe('auth-code-1')
      expect(tokenRequest.get('redirect_uri')).toBe('http://127.0.0.1:4177/oauth/srv-1/callback')
      expect(tokenRequest.get('code_verifier')).toBeTruthy()

      expect(statusUpdates).toEqual([{ serverId: 'srv-1', status: 'authorized' }])
    })

    // `/callback` deliberately gets none of the `/start` cross-origin check added for the CSRF
    // finding above: a real callback IS a cross-site top-level navigation (the browser following
    // the authorization server's own 302 back to us after the user consents), so a same-origin
    // check here would incorrectly reject the legitimate flow. Its own protection - the signed,
    // replay-protected `state` - is what actually authenticates it; this proves that holds even
    // when every Fetch Metadata signal says "cross-site", not merely that no check was added.
    it('completes successfully even when sec-fetch-site/origin say cross-site, exactly like a real redirect back from the authorization server', async () => {
      const { fixture, served, credentialStore } = await setupHandler()
      fixture.setTokenResponse({
        status: 200,
        body: { access_token: 'at', refresh_token: 'rt', token_type: 'bearer', expires_in: 3600 },
      })
      const { state } = await completeStart({ fixture, credentialStore, served })

      const response = await fetch(`${served.url}/oauth/srv-1/callback?code=auth-code-1&state=${state}`, {
        redirect: 'manual',
        headers: { 'sec-fetch-site': 'cross-site', origin: fixture.url.origin },
      })

      expect(response.status).toBe(302)
      expect(credentialStore.putOAuth).toHaveBeenCalledTimes(1)
    })

    it('rejects a request with a syntactically valid but unsigned state', async () => {
      const { served, credentialStore } = await setupHandler()
      const forged = Buffer.from(JSON.stringify({ serverId: 'srv-1' })).toString('base64url')

      const response = await fetch(
        `${served.url}/oauth/srv-1/callback?code=abc&state=${forged}.not-a-real-signature`,
      )

      expect(response.status).toBe(400)
      expect(credentialStore.putOAuth).not.toHaveBeenCalled()
    })

    it('marks the server as needing attention and redirects back without storing anything when the token exchange fails', async () => {
      const statusUpdates: Array<{ serverId: string; status: string }> = []
      const { fixture, served, credentialStore } = await setupHandler({
        onAuthorizationStatus: async (serverId, status) => {
          statusUpdates.push({ serverId, status })
        },
      })
      fixture.setTokenResponse({ status: 400, body: { error: 'invalid_grant' } })
      const { state } = await completeStart({ fixture, credentialStore, served })

      const response = await fetch(`${served.url}/oauth/srv-1/callback?code=auth-code-1&state=${state}`, {
        redirect: 'manual',
      })

      expect(response.status).toBe(302)
      expect(credentialStore.putOAuth).not.toHaveBeenCalled()
      expect(statusUpdates).toEqual([{ serverId: 'srv-1', status: 'error' }])
    })

    // Regression test for a second-round BLOCKING finding from independent security review: the
    // token-endpoint half of the same redirect-following SSRF the "refuses to follow a redirect
    // from the discovery endpoint" test (in the `start` block above) already covers for discovery.
    // `exchangeAuthorization` was missing `fetchFn: fetchImpl` entirely, so this - the single most
    // sensitive request in the whole flow, carrying the authorization code, PKCE `code_verifier`
    // and any client secret - was exempt from both the timeout and the redirect:'error' guard
    // every other fetch in this file gets. The reviewer's own PoC confirmed a redirected token
    // endpoint leaks the full POST body (code, code_verifier, client_id) to wherever it points.
    it('refuses to follow a redirect from the token endpoint instead of leaking the authorization code there', async () => {
      const victim = await startVictimServer()
      const { fixture, served, credentialStore } = await setupHandler()
      const { state } = await completeStart({ fixture, credentialStore, served })
      fixture.setTokenRedirect(victim.url.toString())

      const response = await fetch(`${served.url}/oauth/srv-1/callback?code=auth-code-1&state=${state}`, {
        redirect: 'manual',
      })

      // The refused redirect makes the token exchange fail closed (same "mark as error, redirect
      // back" path as any other exchange failure) - never a silent leak to wherever it pointed.
      expect(response.status).toBe(302)
      expect(credentialStore.putOAuth).not.toHaveBeenCalled()
      expect(victim.requestCount()).toBe(0)
    })

    it('treats a provider-side denial (error query param) as a failure without exchanging any code', async () => {
      const statusUpdates: Array<{ serverId: string; status: string }> = []
      const { fixture, served, credentialStore } = await setupHandler({
        onAuthorizationStatus: async (serverId, status) => {
          statusUpdates.push({ serverId, status })
        },
      })
      const { state } = await completeStart({ fixture, credentialStore, served })

      const response = await fetch(`${served.url}/oauth/srv-1/callback?error=access_denied&state=${state}`, {
        redirect: 'manual',
      })

      expect(response.status).toBe(302)
      expect(credentialStore.putOAuth).not.toHaveBeenCalled()
      expect(fixture.tokenRequests).toEqual([])
      expect(statusUpdates).toEqual([{ serverId: 'srv-1', status: 'error' }])
    })

    it('never redirects to an attacker-supplied off-origin returnTo target', async () => {
      const { fixture, served, credentialStore } = await setupHandler()
      fixture.setTokenResponse({
        status: 200,
        body: { access_token: 'at', refresh_token: 'rt', token_type: 'bearer', expires_in: 3600 },
      })
      const { state } = await completeStart({
        fixture,
        credentialStore,
        served,
        returnTo: 'https://evil.example.com/steal',
      })

      const response = await fetch(`${served.url}/oauth/srv-1/callback?code=auth-code-1&state=${state}`, {
        redirect: 'manual',
      })

      expect(response.status).toBe(302)
      const redirectLocation = response.headers.get('location') as string
      expect(redirectLocation.startsWith('http://127.0.0.1:4177/')).toBe(true)
      expect(redirectLocation).not.toContain('evil.example.com')
    })

    // The test above proves the end-to-end behavior, but `/start` already strips an off-origin
    // `returnTo` before it is ever sealed into the state (see the matching filter in
    // `handleStart`) - so that test alone never actually exercises the callback's OWN independent
    // `safeReturnTo` check. A mutation that deletes `safeReturnTo`'s guard still leaves the test
    // above green, because the malicious value never reaches it. This test closes that gap by
    // sealing a state whose `returnTo` is off-origin directly (bypassing `/start`'s filter, as a
    // second, independent line of defense should assume a future bug in that filter might), and
    // asserts the callback's own check catches it - proven by a real reverse mutation on
    // `safeReturnTo` during implementation (see the Task 4 report).
    it("the callback's own safeReturnTo check independently rejects an off-origin returnTo, even if it reached state some other way", async () => {
      const secret = 'test-secret-32-bytes-minimum-xxxxxxxxxxxx'
      const credentialStore = fakeCredentialStore()
      const handler = createOAuthHttpHandler({
        secret,
        credentialStore,
        baseUrl: new URL('http://127.0.0.1:4177'),
        resolveServer: async () => undefined,
      })
      const served = await serveHandler(handler)
      // No matching pendingRegistrations entry exists (this state was never issued by `/start`),
      // so the callback takes its "no pending registration" failure branch - which still redirects
      // through `safeReturnTo(payload.returnTo, baseUrl)`, exercising exactly the code under test.
      const state = await sealOAuthState(
        {
          serverId: 'srv-1',
          redirectUri: 'http://127.0.0.1:4177/oauth/srv-1/callback',
          codeVerifier: 'verifier',
          nonce: 'nonce-bypassing-start',
          issuedAt: Date.now(),
          returnTo: 'https://evil.example.com/steal',
        },
        { secret },
      )

      const response = await fetch(`${served.url}/oauth/srv-1/callback?code=abc&state=${state}`, {
        redirect: 'manual',
      })

      expect(response.status).toBe(302)
      const redirectLocation = response.headers.get('location') as string
      expect(redirectLocation.startsWith('http://127.0.0.1:4177/')).toBe(true)
      expect(redirectLocation).not.toContain('evil.example.com')
    })
  })
})
