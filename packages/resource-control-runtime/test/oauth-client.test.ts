import { createServer, type Server as HttpServer, type IncomingMessage } from 'node:http'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createAgnesOAuthClientProvider,
  type OAuthCredential,
  registerOAuthClient,
  resolveAuthorizationServerUrl,
  tryDiscoverAuthorizationServerMetadata,
} from '../src/oauth-client.js'

/**
 * Real `node:http` fixture "authorization server" - no mocking of the SDK's own discovery /
 * registration functions (`discoverAuthorizationServerMetadata`, `registerClient`, ...). Every
 * test drives `registerOAuthClient` against an actual server on 127.0.0.1 and asserts on what
 * that server actually received, mirroring the pattern already established in
 * packages/base/test/mcp/register.test.ts.
 */
describe('oauth-client', () => {
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

  type RequestLog = { method: string; url: string }
  type RegistrationResponse = { status: number; body: unknown }

  /**
   * Plays both the MCP resource server and its authorization server at the same origin (the
   * brief's own test sketch uses a single `http://127.0.0.1:PORT`). No
   * `/.well-known/oauth-protected-resource` handler is registered, so
   * `discoverOAuthProtectedResourceMetadata` always 404s and `registerOAuthClient` falls back to
   * the legacy MCP 2025-03-26 behavior (the server's own origin is the authorization server) -
   * that fallback is exactly what routes requests to the `/.well-known/oauth-authorization-server`
   * handler configured here.
   *
   * Metadata/registration responses are set *after* the server is listening (via the returned
   * setters), since RFC 8414 metadata must self-reference the fixture's own origin (`issuer`,
   * `authorization_endpoint`, ...) which is only known once `listen()` resolves.
   */
  async function startFixtureAuthServer(): Promise<{
    url: URL
    requests: RequestLog[]
    setMetadata(metadata: Record<string, unknown> | undefined): void
    setRegistration(registration: RegistrationResponse | undefined): void
  }> {
    const requests: RequestLog[] = []
    let metadata: Record<string, unknown> | undefined
    let registration: RegistrationResponse | undefined
    const server = createServer((req: IncomingMessage, res) => {
      requests.push({ method: req.method ?? '', url: req.url ?? '' })
      const url = req.url ?? ''
      if (url === '/.well-known/oauth-authorization-server') {
        if (!metadata) {
          res.writeHead(404).end()
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(metadata))
        return
      }
      if (url === '/register' && req.method === 'POST') {
        if (!registration) {
          res.writeHead(404).end()
          return
        }
        res
          .writeHead(registration.status, { 'content-type': 'application/json' })
          .end(JSON.stringify(registration.body))
        return
      }
      res.writeHead(404).end()
    })
    const url = await listen(server)
    cleanup.push(() => closeHttpServer(server))
    return {
      url,
      requests,
      setMetadata: (m) => {
        metadata = m
      },
      setRegistration: (r) => {
        registration = r
      },
    }
  }

  /** Minimal RFC 8414 metadata satisfying the SDK's own `OAuthMetadataSchema` - issuer, both
   * endpoints and response_types_supported are all required there; omitting any of them makes
   * discovery throw and every case below would silently degenerate into "discovery failed". Built
   * from `httpsBase` (see below), not the fixture's own plain-http `base`, so `token_endpoint`
   * satisfies `tryDiscoverAuthorizationServerMetadata`'s SSRF guard (added by independent security
   * review - see that function's doc comment) and every test below keeps exercising real
   * registration/discovery instead of silently degrading to "metadata discarded". */
  function asMetadata(base: URL, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const httpsBase = httpsAlias(base)
    return {
      issuer: httpsBase.toString(),
      authorization_endpoint: new URL('/authorize', httpsBase).toString(),
      token_endpoint: new URL('/token', httpsBase).toString(),
      response_types_supported: ['code'],
      ...extra,
    }
  }

  /** Same-origin URL with the scheme swapped to `https:` - used only to build metadata field
   * *values* (never to actually dial TLS; see `httpsAliasFetch` below). */
  function httpsAlias(url: URL): URL {
    const alias = new URL(url.toString())
    alias.protocol = 'https:'
    return alias
  }

  /**
   * Test-only `fetchImpl`: transparently downgrades an `https:` target back to `http:` before
   * making the real request, so a fixture-declared endpoint can carry a real `https:` scheme
   * (satisfying the SSRF guards added to `resolveAuthorizationServerUrl`/
   * `tryDiscoverAuthorizationServerMetadata` by independent security review) while the fixture
   * server underneath keeps running plain `node:http`, matching this suite's existing convention
   * (see the file header comment) rather than introducing TLS/certificate ceremony this suite has
   * never needed before. This never talks to a real network - only ever the fixture's own
   * 127.0.0.1 port - so it is not a meaningful weakening of anything: the production code path
   * this simulates always uses the real global `fetch`, never this function.
   */
  function httpsAliasFetch(): FetchLike {
    return (async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.toString())
      if (url.protocol === 'https:') url.protocol = 'http:'
      return fetch(url, init)
    }) as FetchLike
  }

  describe('registerOAuthClient', () => {
    it('uses staticClientId when CIMD and DCR both fail and one is supplied', async () => {
      const fixture = await startFixtureAuthServer()
      fixture.setMetadata(asMetadata(fixture.url))
      fixture.setRegistration({ status: 404, body: { error: 'not_found' } })

      const result = await registerOAuthClient(fixture.url, { staticClientId: 'manual-id' })

      expect(result).toEqual({ clientId: 'manual-id' })
      // Pre-registered client information takes priority over discovery entirely (this is the
      // real MCP spec's priority order - see the module header comment) - proven here by the
      // fixture never receiving a single request, not merely by the final result matching.
      expect(fixture.requests).toEqual([])
    })

    it('returns pendingClientId when everything fails and no static id given', async () => {
      const fixture = await startFixtureAuthServer()
      fixture.setMetadata(
        asMetadata(fixture.url, {
          registration_endpoint: new URL('/register', httpsAlias(fixture.url)).toString(),
        }),
      )
      fixture.setRegistration({ status: 404, body: { error: 'not_found' } })

      const result = await registerOAuthClient(fixture.url, {
        redirectUri: 'http://127.0.0.1:9/callback',
        fetchImpl: httpsAliasFetch(),
      })

      expect(result).toEqual({ pendingClientId: true })
      // DCR really was attempted (not skipped) and really did fail - not merely absent.
      expect(fixture.requests.some((r) => r.method === 'POST' && r.url === '/register')).toBe(true)
    })

    it('prefers dynamic client registration when the server supports it', async () => {
      const fixture = await startFixtureAuthServer()
      fixture.setMetadata(
        asMetadata(fixture.url, {
          registration_endpoint: new URL('/register', httpsAlias(fixture.url)).toString(),
        }),
      )
      fixture.setRegistration({
        status: 201,
        body: { client_id: 'dcr-issued-id', redirect_uris: ['http://127.0.0.1:9/callback'] },
      })

      const result = await registerOAuthClient(fixture.url, {
        redirectUri: 'http://127.0.0.1:9/callback',
        fetchImpl: httpsAliasFetch(),
      })

      expect(result).toHaveProperty('clientId')
      expect(result).toEqual({ clientId: 'dcr-issued-id', clientSecret: undefined })
      expect(fixture.requests.some((r) => r.method === 'POST' && r.url === '/register')).toBe(true)
    })

    it('prefers CIMD over DCR when the authorization server advertises support for both', async () => {
      const fixture = await startFixtureAuthServer()
      fixture.setMetadata(
        asMetadata(fixture.url, {
          registration_endpoint: new URL('/register', httpsAlias(fixture.url)).toString(),
          client_id_metadata_document_supported: true,
        }),
      )
      fixture.setRegistration({
        status: 201,
        body: { client_id: 'dcr-issued-id', redirect_uris: ['http://127.0.0.1:9/callback'] },
      })

      const result = await registerOAuthClient(fixture.url, {
        redirectUri: 'http://127.0.0.1:9/callback',
        clientMetadataUrl: 'https://client.example.com/oauth/client-metadata.json',
        fetchImpl: httpsAliasFetch(),
      })

      expect(result).toEqual({ clientId: 'https://client.example.com/oauth/client-metadata.json' })
      // CIMD's client_id IS the metadata URL itself - the authorization server fetches it lazily
      // at authorize time (per spec), the client never calls a registration endpoint for it.
      expect(fixture.requests.some((r) => r.url === '/register')).toBe(false)
    })

    it('does not use CIMD when the authorization server does not advertise support for it, even if a clientMetadataUrl is configured', async () => {
      const fixture = await startFixtureAuthServer()
      fixture.setMetadata(
        asMetadata(fixture.url, {
          registration_endpoint: new URL('/register', httpsAlias(fixture.url)).toString(),
        }),
      )
      fixture.setRegistration({
        status: 201,
        body: { client_id: 'dcr-issued-id', redirect_uris: ['http://127.0.0.1:9/callback'] },
      })

      const result = await registerOAuthClient(fixture.url, {
        redirectUri: 'http://127.0.0.1:9/callback',
        clientMetadataUrl: 'https://client.example.com/oauth/client-metadata.json',
        fetchImpl: httpsAliasFetch(),
      })

      expect(result).toEqual({ clientId: 'dcr-issued-id', clientSecret: undefined })
    })

    it('skips DCR (and returns pendingClientId) when no redirectUri is available to register', async () => {
      const fixture = await startFixtureAuthServer()
      fixture.setMetadata(
        asMetadata(fixture.url, {
          registration_endpoint: new URL('/register', httpsAlias(fixture.url)).toString(),
        }),
      )
      fixture.setRegistration({
        status: 201,
        body: { client_id: 'dcr-issued-id', redirect_uris: ['http://127.0.0.1:9/callback'] },
      })

      const result = await registerOAuthClient(fixture.url, { fetchImpl: httpsAliasFetch() })

      expect(result).toEqual({ pendingClientId: true })
      expect(fixture.requests.some((r) => r.url === '/register')).toBe(false)
    })

    it('falls back to pendingClientId when the authorization server has no discovery metadata at all', async () => {
      const fixture = await startFixtureAuthServer()
      // Neither setMetadata nor setRegistration called: every fixture route 404s.

      const result = await registerOAuthClient(fixture.url, { redirectUri: 'http://127.0.0.1:9/callback' })

      expect(result).toEqual({ pendingClientId: true })
    })
  })

  /**
   * Regression tests for a BLOCKING finding from independent security review of Task 4: neither
   * `resolveAuthorizationServerUrl` nor `tryDiscoverAuthorizationServerMetadata` used to validate
   * the URLs a PRM/RFC 8414 response body names before handing them to a caller that fetches them -
   * a malicious or compromised MCP resource server could name an arbitrary internal host as its
   * `authorization_servers[0]`, `token_endpoint` or `registration_endpoint` and have this daemon
   * fetch it from inside its own network position (SSRF), before any real user consent ever
   * happens at the far end. Each test below drives the exact attack path the review traced and
   * asserts the "victim" target that would only ever receive a request if the guard failed
   * actually receives zero requests - not just that a function returns some expected value.
   */
  describe('SSRF guards on dynamically-discovered endpoint URLs', () => {
    /** A server that only counts the requests it receives - stands in for "the arbitrary internal
     * host an attacker-controlled response body names", so a test can assert it was never
     * reached. */
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

    /** A resource server whose PRM response's `authorization_servers[0]` is caller-controlled -
     * lets a test name the victim server as the "authorization server" the real attack would. */
    async function startResourceServerWithPrm(
      authorizationServers: string[],
    ): Promise<{ url: URL; requests: RequestLog[] }> {
      const requests: RequestLog[] = []
      let ownOrigin: string | undefined
      const server = createServer((req, res) => {
        requests.push({ method: req.method ?? '', url: req.url ?? '' })
        if (req.url === '/.well-known/oauth-protected-resource') {
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              // `resource` must be a real URL per OAuthProtectedResourceMetadataSchema - `ownOrigin`
              // is only known once listen() resolves below, same ordering as
              // startFixtureAuthServer's own metadata setters.
              resource: `${ownOrigin}/`,
              authorization_servers: authorizationServers,
            }),
          )
          return
        }
        res.writeHead(404).end()
      })
      const url = await listen(server)
      ownOrigin = url.origin
      cleanup.push(() => closeHttpServer(server))
      return { url, requests }
    }

    it('resolveAuthorizationServerUrl refuses a PRM-declared authorization server that is not HTTPS, and never contacts it', async () => {
      const victim = await startVictimServer()
      const resourceServer = await startResourceServerWithPrm([victim.url.toString()])

      const result = await resolveAuthorizationServerUrl(resourceServer.url)

      // Falls back to the resource server's own origin - the same safe default used when a
      // resource server implements no PRM at all - rather than the attacker-named target.
      expect(result.origin).toBe(resourceServer.url.origin)
      expect(result.toString()).not.toContain(String(victim.url.port))
      expect(victim.requestCount()).toBe(0)
    })

    it('resolveAuthorizationServerUrl accepts a PRM-declared authorization server that is a safe HTTPS target', async () => {
      const legitimate = httpsAlias(new URL('http://127.0.0.1:1'))
      const resourceServer = await startResourceServerWithPrm([legitimate.toString()])

      const result = await resolveAuthorizationServerUrl(resourceServer.url)

      expect(result.toString()).toBe(legitimate.toString())
    })

    it('tryDiscoverAuthorizationServerMetadata discards the entire metadata document when token_endpoint is not HTTPS', async () => {
      const victim = await startVictimServer()
      const fixture = await startFixtureAuthServer()
      fixture.setMetadata({
        issuer: httpsAlias(fixture.url).toString(),
        authorization_endpoint: new URL('/authorize', httpsAlias(fixture.url)).toString(),
        // The attack: a malicious/compromised authorization server names an arbitrary internal
        // host as its own token endpoint.
        token_endpoint: victim.url.toString(),
        response_types_supported: ['code'],
      })

      const metadata = await tryDiscoverAuthorizationServerMetadata(fixture.url, httpsAliasFetch())

      expect(metadata).toBeUndefined()
      expect(victim.requestCount()).toBe(0)
    })

    it('tryDiscoverAuthorizationServerMetadata discards the entire metadata document when registration_endpoint is not HTTPS, even with a safe token_endpoint', async () => {
      const victim = await startVictimServer()
      const fixture = await startFixtureAuthServer()
      fixture.setMetadata(
        asMetadata(fixture.url, {
          // token_endpoint here is safe (via asMetadata's httpsAlias) - only registration_endpoint
          // is the attack.
          registration_endpoint: victim.url.toString(),
        }),
      )

      const metadata = await tryDiscoverAuthorizationServerMetadata(fixture.url, httpsAliasFetch())

      expect(metadata).toBeUndefined()
      expect(victim.requestCount()).toBe(0)
    })

    it('tryDiscoverAuthorizationServerMetadata accepts a metadata document whose endpoints are all safe HTTPS targets', async () => {
      const fixture = await startFixtureAuthServer()
      fixture.setMetadata(
        asMetadata(fixture.url, {
          registration_endpoint: new URL('/register', httpsAlias(fixture.url)).toString(),
        }),
      )

      const metadata = await tryDiscoverAuthorizationServerMetadata(fixture.url, httpsAliasFetch())

      expect(metadata).toBeDefined()
      expect(metadata?.token_endpoint).toBe(new URL('/token', httpsAlias(fixture.url)).toString())
    })
  })

  describe('createAgnesOAuthClientProvider', () => {
    function fakeCredentialsStore() {
      let stored: OAuthCredential | undefined
      return {
        read: async () => stored,
        write: async (value: OAuthCredential) => {
          stored = value
        },
        peek: () => stored,
      }
    }

    it('clientInformation reflects the pre-resolved clientId/clientSecret without any discovery', async () => {
      const store = fakeCredentialsStore()
      const provider = createAgnesOAuthClientProvider({
        clientId: 'resolved-id',
        clientSecret: 'shh',
        redirectUri: 'http://127.0.0.1:9/callback',
        credentials: store,
      })

      // clientInformation() is synchronous in this adapter (the interface allows either) since the
      // client_id is already resolved by the time the provider is constructed - no await needed.
      expect(provider.clientInformation()).toEqual({
        client_id: 'resolved-id',
        client_secret: 'shh',
      })
    })

    it('redirectToAuthorization stores the URL for the caller instead of navigating anywhere', async () => {
      const store = fakeCredentialsStore()
      const provider = createAgnesOAuthClientProvider({
        clientId: 'resolved-id',
        redirectUri: 'http://127.0.0.1:9/callback',
        credentials: store,
      })
      expect(provider.authorizationUrl).toBeUndefined()

      const target = new URL('https://as.example.com/authorize?client_id=resolved-id')
      await provider.redirectToAuthorization(target)

      expect(provider.authorizationUrl).toBe(target)
    })

    it('round-trips full tokens (including refresh_token) through the credentials callbacks', async () => {
      const store = fakeCredentialsStore()
      const provider = createAgnesOAuthClientProvider({
        clientId: 'resolved-id',
        redirectUri: 'http://127.0.0.1:9/callback',
        credentials: store,
      })

      await provider.saveTokens({
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        token_type: 'bearer',
        expires_in: 3600,
        scope: 'files:read',
      })

      const stored = store.peek()
      expect(stored?.accessToken).toBe('access-1')
      expect(stored?.refreshToken).toBe('refresh-1')

      const tokens = await provider.tokens()
      expect(tokens?.access_token).toBe('access-1')
      expect(tokens?.refresh_token).toBe('refresh-1')
      expect(tokens?.token_type).toBe('bearer')
      expect(tokens?.scope).toBe('files:read')
      // expires_in is recomputed from a stored absolute expiresAt - allow generous scheduling slop.
      expect(tokens?.expires_in).toBeGreaterThan(3500)
      expect(tokens?.expires_in).toBeLessThanOrEqual(3600)
    })

    it('handles an authorization server that issues no refresh_token without losing or fabricating one', async () => {
      const store = fakeCredentialsStore()
      const provider = createAgnesOAuthClientProvider({
        clientId: 'resolved-id',
        redirectUri: 'http://127.0.0.1:9/callback',
        credentials: store,
      })

      await provider.saveTokens({ access_token: 'access-only', token_type: 'bearer' })

      const stored = store.peek()
      expect(stored?.accessToken).toBe('access-only')
      expect(stored?.refreshToken).toBeUndefined()

      const tokens = await provider.tokens()
      expect(tokens?.access_token).toBe('access-only')
      expect(tokens?.refresh_token).toBeUndefined()
    })

    it('tokens() returns undefined when nothing has been saved yet', async () => {
      const store = fakeCredentialsStore()
      const provider = createAgnesOAuthClientProvider({
        clientId: 'resolved-id',
        redirectUri: 'http://127.0.0.1:9/callback',
        credentials: store,
      })

      await expect(provider.tokens()).resolves.toBeUndefined()
    })
  })
})
