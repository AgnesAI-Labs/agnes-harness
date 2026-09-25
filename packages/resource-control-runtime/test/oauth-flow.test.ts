import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server as HttpServer } from 'node:http'
import { createRequire } from 'node:module'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { resolvedConfig } from '../src/mcp.js'
import {
  createMcpOAuthCredentialResolver,
  type McpOAuthCredentialStore,
} from '../src/mcp-oauth-credentials.js'
import {
  createOAuthHttpHandler,
  credentialRefFor,
  type OAuthCredentialStoreWriter,
} from '../src/oauth-http-handler.js'

// Loaded via createRequire (untyped) rather than a static import: the SDK's server-side
// StreamableHTTPServerTransport options are not exactOptionalPropertyTypes-clean (the
// `sessionIdGenerator: undefined` stateless-mode idiom the SDK's own docs recommend does not
// typecheck under a static import) - same established workaround
// packages/base/test/mcp/register.test.ts and
// packages/worker-runtime/test/{oauth,http}-bootstrap.test.ts already use for this exact SDK
// surface. The client-side pieces below (`Client`/`StreamableHTTPClientTransport`) stay statically
// imported - packages/base/src/mcp/connect.ts (production code) already proves
// those typecheck cleanly when optional fields are passed via conditional spread instead of an
// explicit `undefined`.
const sdkRequire = createRequire(import.meta.url)
const { Server } = sdkRequire('@modelcontextprotocol/sdk/server/index.js')
const { StreamableHTTPServerTransport } = sdkRequire('@modelcontextprotocol/sdk/server/streamableHttp.js')
const { ListToolsRequestSchema } = sdkRequire('@modelcontextprotocol/sdk/types.js')

/**
 * Task 7 (mcp-oauth-authorization plan): the one test in this plan that drives the *whole*
 * authorization_code chain end-to-end through the real production entry points Tasks 2-6 each built
 * and unit-tested in isolation - not a rehearsal of any single task's own fixture. Per this task's
 * brief and the dispatcher's correction to it: `mcp.servers.oauth.start` is NOT a daemon RPC method
 * (Task 5 confirmed this is a genuine process-boundary constraint, not a missing feature - a
 * daemon-signed `state` could never pass `/callback`'s verification, which only ever runs inside the
 * `agnes serve` launcher process's own in-memory secret + `pendingRegistrations` map). This test
 * therefore calls `createOAuthHttpHandler(...).startAuthorization` directly - the JSON capability
 * Task 5 built for exactly this purpose - instead of a nonexistent RPC method.
 *
 * Everything below is real, matching every earlier task's own established convention (no mocking of
 * SDK internals):
 * - A real `node:http` fixture that plays BOTH roles a genuine remote MCP server with built-in OAuth
 *   would: the OAuth authorization server (RFC 8414 discovery + `/authorize` + `/token`, on the SAME
 *   origin - the realistic case `oauth-client.ts`'s same-origin legacy fallback exists for) AND the
 *   MCP resource server itself (a real StreamableHTTP `/mcp` endpoint that records the
 *   `Authorization` header it actually received).
 * - `/token` performs REAL PKCE verification (SHA-256(code_verifier) base64url must equal the
 *   `code_challenge` captured at `/authorize`) - no earlier task's fixture in this plan ever checked
 *   this relationship; every one of them just recorded the request and always answered 200/302,
 *   proving the code got redirected to the right places but never that the S256 challenge/verifier
 *   pairing genuinely round-trips through a server that actually enforces it (design §1.3's hard
 *   PKCE requirement).
 * - The credential store is one real, shared, Map-backed object (not a per-task-isolated fake)
 *   satisfying BOTH `OAuthCredentialStoreWriter` (`oauth-http-handler.ts`'s callback write path) and
 *   `McpOAuthCredentialStore` (`mcp-oauth-credentials.ts`'s worker-side read path) - the exact
 *   structural interface both modules already deliberately depend on instead of importing
 *   `@agnes/host`'s concrete `CredentialStore` type (see both files' own doc comments on that
 *   decoupling). Using the SAME instance for both proves the write path and the read path genuinely
 *   agree on the ref format (`credentialRefFor`) and the stored shape - something no earlier task's
 *   test could prove, because each one only ever exercised its own half against its own store.
 * - The final connection is a real `@modelcontextprotocol/sdk` `Client` over a real
 *   `StreamableHTTPClientTransport`, constructed the same way `packages/base/src/mcp/connect.ts`'s
 *   `createHttpTransport` builds one in production
 *   (`new StreamableHTTPClientTransport(url, { requestInit: { headers } })`).
 *
 * Not covered here:
 * - A real browser driving the `/authorize` consent screen.
 * - Dynamic Client Registration/CIMD (this test
 * uses a `staticClientId`, matching `oauth-client.ts`'s own documented "pre-registered client_id is
 * priority 1, requires zero network calls" path - DCR/CIMD are exercised by oauth-client.test.ts).
 */
describe('oauth end-to-end: authorization_code flow produces a working, bearer-authenticated MCP connection', () => {
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

  type PendingAuthorization = Readonly<{ codeChallenge: string; redirectUri: string; clientId: string }>
  type TokenIssuance = Readonly<{
    accessToken: string
    refreshToken: string
    expiresIn: number
    scope?: string
  }>

  /**
   * One real `node:http` server acting as both the MCP resource server (`/mcp`, StreamableHTTP) and
   * its own OAuth authorization server (RFC 8414 discovery + `/authorize` + `/token`) - the realistic
   * single-origin deployment shape `oauth-client.ts`'s same-origin fallback (no RFC 9728 PRM) exists
   * for, and the one `oauth-admin.ts`'s production `resolveServer` actually produces (it passes the
   * MCP server's own `transport.url` as `serverUrl` for discovery, with no separate PRM lookup layer
   * of its own).
   */
  async function startFixtureRemoteMcpServer(): Promise<{
    origin: URL
    mcpUrl: string
    mcpHeaders: Array<Record<string, string | string[] | undefined>>
    authorizeCount: () => number
    setTokenIssuance(issuance: TokenIssuance | undefined): void
  }> {
    const mcpHeaders: Array<Record<string, string | string[] | undefined>> = []
    let authorizeCount = 0
    let tokenIssuance: TokenIssuance | undefined
    const pending = new Map<string, PendingAuthorization>()

    const mcp = new Server({ name: 'oauth-e2e-fixture-mcp', version: '1' }, { capabilities: { tools: {} } })
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }))
    const mcpTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    await mcp.connect(mcpTransport)

    let boundOrigin: URL | undefined
    const origin = () => {
      if (!boundOrigin) throw new Error('fixture not yet bound')
      return boundOrigin
    }

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '', 'http://127.0.0.1')

      if (url.pathname === '/mcp') {
        mcpHeaders.push({ ...req.headers })
        void mcpTransport.handleRequest(req, res)
        return
      }

      if (url.pathname === '/.well-known/oauth-authorization-server') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            issuer: origin().toString(),
            authorization_endpoint: new URL('/authorize', origin()).toString(),
            token_endpoint: new URL('/token', origin()).toString(),
            response_types_supported: ['code'],
            code_challenge_methods_supported: ['S256'],
          }),
        )
        return
      }

      if (url.pathname === '/authorize') {
        authorizeCount++
        const clientId = url.searchParams.get('client_id') ?? ''
        const redirectUri = url.searchParams.get('redirect_uri') ?? ''
        const codeChallenge = url.searchParams.get('code_challenge') ?? ''
        const codeChallengeMethod = url.searchParams.get('code_challenge_method')
        const state = url.searchParams.get('state') ?? ''
        // A real authorization server enforces S256-only exactly like design §1.3 requires the
        // client to (this fixture is the other half of that contract, not merely a passive recorder).
        if (codeChallengeMethod !== 'S256' || !codeChallenge || !redirectUri) {
          res.writeHead(400).end('invalid_request')
          return
        }
        // Simulates the user reaching, and instantly consenting on, a real login/consent screen:
        // issues a one-time authorization code bound to exactly the PKCE challenge/redirect_uri/
        // client_id this request presented, then 302s back to the caller's own redirect_uri exactly
        // like a real authorization server's post-consent redirect - the test's simulateUserConsent
        // helper below follows this real redirect rather than splicing the callback URL together by
        // hand.
        const code = randomBytes(16).toString('hex')
        pending.set(code, { codeChallenge, redirectUri, clientId })
        const back = new URL(redirectUri)
        back.searchParams.set('code', code)
        back.searchParams.set('state', state)
        res.writeHead(302, { location: back.toString() }).end()
        return
      }

      if (url.pathname === '/token' && req.method === 'POST') {
        let body = ''
        req.on('data', (chunk) => {
          body += String(chunk)
        })
        req.on('end', () => {
          const params = new URLSearchParams(body)
          if (params.get('grant_type') !== 'authorization_code') {
            res
              .writeHead(400, { 'content-type': 'application/json' })
              .end(JSON.stringify({ error: 'unsupported_grant_type' }))
            return
          }
          const code = params.get('code') ?? ''
          const entry = pending.get(code)
          if (!entry) {
            res
              .writeHead(400, { 'content-type': 'application/json' })
              .end(JSON.stringify({ error: 'invalid_grant' }))
            return
          }
          const verifier = params.get('code_verifier') ?? ''
          // The load-bearing PKCE check: recompute S256(code_verifier) and require it to equal the
          // code_challenge this exact code was minted for. No earlier task's fixture in this plan
          // ever checked this - see this file's own header comment.
          const recomputed = createHash('sha256').update(verifier).digest('base64url')
          const redirectMatches = params.get('redirect_uri') === entry.redirectUri
          if (recomputed !== entry.codeChallenge || !redirectMatches) {
            res
              .writeHead(400, { 'content-type': 'application/json' })
              .end(JSON.stringify({ error: 'invalid_grant' }))
            return
          }
          // One-time use: a genuine authorization server never lets a code be exchanged twice.
          pending.delete(code)
          if (!tokenIssuance) {
            res.writeHead(404).end()
            return
          }
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              access_token: tokenIssuance.accessToken,
              refresh_token: tokenIssuance.refreshToken,
              token_type: 'bearer',
              expires_in: tokenIssuance.expiresIn,
              ...(tokenIssuance.scope ? { scope: tokenIssuance.scope } : {}),
            }),
          )
        })
        return
      }

      res.writeHead(404).end()
    })

    boundOrigin = await listen(server)
    cleanup.push(async () => {
      await mcp.close()
      await closeHttpServer(server)
    })

    return {
      origin: boundOrigin,
      mcpUrl: new URL('/mcp', boundOrigin).toString(),
      mcpHeaders,
      authorizeCount: () => authorizeCount,
      setTokenIssuance: (issuance) => {
        tokenIssuance = issuance
      },
    }
  }

  /** A real, shared, Map-backed credential store satisfying both the write-side interface
   * `oauth-http-handler.ts`'s callback route uses and the read-side interface
   * `mcp-oauth-credentials.ts`'s worker resolver uses - see this file's header comment for why using
   * one instance for both (rather than one fake per module, like every earlier task's own test) is
   * the actual point of this fixture. */
  function sharedCredentialStore(): OAuthCredentialStoreWriter &
    McpOAuthCredentialStore & {
      snapshot(ref: string): Promise<Awaited<ReturnType<McpOAuthCredentialStore['read']>>>
    } {
    const store = new Map<string, Record<string, unknown>>()
    return {
      async read(ref) {
        return store.has(ref) ? (store.get(ref) as never) : null
      },
      async putOAuth(ref, value) {
        store.set(ref, { kind: 'oauth', version: 1, ...value })
      },
      async snapshot(ref) {
        return store.has(ref) ? (store.get(ref) as never) : null
      },
    }
  }

  /** Real "browser" simulation: fetch the real `/authorize` URL `startAuthorization` minted, follow
   * the real 302 it sends back (this is the step no earlier task's test in this plan ever drove for
   * real - see oauth-http-handler.test.ts's own `completeStart` helper, which reads the state off the
   * recorded `/authorize` request instead of following an actual redirect, because its fixture's
   * `/authorize` never redirects anywhere). */
  async function simulateUserConsent(authorizeUrl: string): Promise<Response> {
    const authorizeResponse = await fetch(authorizeUrl, { redirect: 'manual' })
    if (authorizeResponse.status !== 302)
      throw new Error(`fixture /authorize did not redirect (status ${authorizeResponse.status})`)
    const callbackLocation = authorizeResponse.headers.get('location')
    if (!callbackLocation) throw new Error('fixture /authorize redirect missing Location header')
    return fetch(callbackLocation, { redirect: 'manual' })
  }

  const SECRET = 'oauth-e2e-test-secret-32-bytes-minimum-xxxxxxxxxxxxxxx'
  const STATIC_CLIENT_ID = 'agnes-e2e-test-client'
  const SERVER_ID = 'fixture-oauth-srv'

  it('a full authorization_code flow produces a working MCP connection', async () => {
    // 1. Real fixture MCP server that is also its own OAuth authorization server.
    const remote = await startFixtureRemoteMcpServer()
    remote.setTokenIssuance({
      accessToken: 'e2e-access-token-1',
      refreshToken: 'e2e-refresh-token-1',
      expiresIn: 3600,
      scope: 'mcp:read mcp:write',
    })

    // 2. The "daemon launcher" callback surface: a real node:http server hosting
    // createOAuthHttpHandler, bound first so baseUrl is the handler's genuine, dialable origin (not
    // a placeholder) - required for step 3's redirect to actually be followable.
    const oauthServer = createServer()
    const baseUrl = await listen(oauthServer)
    cleanup.push(() => closeHttpServer(oauthServer))

    // 3. Create an oauth-bound MCP server definition (Task 1's schema): a server whose secretBinding
    // is `{kind: 'oauth', staticClientId}`, matching what `oauth-admin.ts`'s production
    // `resolveServer` would build from a real `mcp.servers.get` descriptor.
    const store = sharedCredentialStore()
    const handler = createOAuthHttpHandler({
      secret: SECRET,
      credentialStore: store,
      baseUrl,
      resolveServer: async (serverId) =>
        serverId === SERVER_ID ? { serverUrl: remote.origin, staticClientId: STATIC_CLIENT_ID } : undefined,
    })
    oauthServer.on('request', (req, res) => {
      void handler(req, res).then((handled) => {
        if (!handled) res.writeHead(404).end()
      })
    })

    // 4. Begin authorization via the JSON capability directly - NOT `mcp.servers.oauth.start` (see
    // this file's header comment: that RPC method does not exist, by Task 5's confirmed design).
    const startResult = await handler.startAuthorization(SERVER_ID)
    if (!('authorizeUrl' in startResult))
      throw new Error(`expected {authorizeUrl}, got ${JSON.stringify(startResult)}`)

    // 5. Simulate the user consenting in a browser: real /authorize -> real 302 -> real /callback.
    const callbackResponse = await simulateUserConsent(startResult.authorizeUrl)
    expect(callbackResponse.status).toBe(302)
    expect(remote.authorizeCount()).toBe(1)

    // 6. Assert a real OAuthCredential actually landed in the credential store, under the exact ref
    // format both the write side (this handler) and the read side (step 7's resolver) share.
    const stored = await store.snapshot(credentialRefFor(SERVER_ID))
    expect(stored).toMatchObject({
      kind: 'oauth',
      provider: 'mcp-oauth',
      accessToken: 'e2e-access-token-1',
      refreshToken: 'e2e-refresh-token-1',
      scope: ['mcp:read', 'mcp:write'],
    })

    // 7. Assert resolvedConfig() (Task 6) can use that stored credential to build a live connection
    // config - through the real worker-side resolver (mcp-oauth-credentials.ts), not a stub.
    const oauthCredentials = createMcpOAuthCredentialResolver({ credentialStore: store })
    const failIfCalled = async (): Promise<string> => {
      throw new Error('oauth-bound MCP must not use the string SecretRef resolver')
    }
    const config = await resolvedConfig(
      {
        definition: {
          serverId: SERVER_ID,
          displayName: 'Fixture OAuth Server',
          transport: { kind: 'http', url: remote.mcpUrl },
          secretBinding: { kind: 'oauth', staticClientId: STATIC_CLIENT_ID },
          toolPolicy: { allow: [] },
        },
        revision: 'a'.repeat(64),
        desired: 'enabled',
        trust: 'trusted',
      },
      failIfCalled,
      new AbortController().signal,
      {},
      { stdioPolicy: { allowedExecutables: [] }, httpPolicy: { localDaemon: true, allowLoopbackHttp: true } },
      { oauthCredentials },
    )
    expect(config.headers?.authorization).toBe('Bearer e2e-access-token-1')
    expect(config.url).toBe(remote.mcpUrl)
    // Narrows `config.url`/`config.headers` from McpServerConfig's stdio-compatible optional types
    // (the 'http'/'sse' branch of resolvedConfig() always sets both, but the type is shared with the
    // stdio branch, which sets neither) - the two assertions just above already proved both are
    // actually present for this config at runtime.
    if (typeof config.url !== 'string') throw new Error('expected an http/sse McpServerConfig')
    const configUrl = config.url
    const configHeaders = config.headers

    // 8. Assert resolvedConfig()'s output genuinely connects: a real MCP SDK Client, over a real
    // StreamableHTTPClientTransport, constructed exactly the way
    // packages/base/src/mcp/connect.ts's createHttpTransport builds one in
    // production (`new StreamableHTTPClientTransport(url, { requestInit: { headers } })`) - proving
    // the bearer token minted by a real OAuth round trip actually arrives at the resource server.
    const client = new Client({ name: 'oauth-e2e-test-client', version: '1' })
    const clientTransport = new StreamableHTTPClientTransport(new URL(configUrl), {
      // Conditional spread (not `{ headers: configHeaders }` directly), matching connect.ts's own
      // `exactOptionalPropertyTypes`-safe idiom: RequestInit's `headers` property type has no
      // explicit `| undefined`, so passing a possibly-`undefined` value there (even though it is
      // provably defined here) does not typecheck.
      requestInit: configHeaders === undefined ? {} : { headers: configHeaders },
    })
    // Same cast packages/base/src/mcp/connect.ts's production code already needs
    // at its own `client.connect(transport)` call site: the SDK's own `Transport` interface and
    // `StreamableHTTPClientTransport`'s `sessionId` getter (`string | undefined` vs. `string`)
    // disagree under `exactOptionalPropertyTypes` - an SDK-internal type quirk, not something a
    // caller's own option shape can route around.
    await client.connect(clientTransport as Parameters<typeof client.connect>[0])
    try {
      const tools = await client.listTools()
      expect(tools.tools).toEqual([])
    } finally {
      await client.close()
    }

    expect(remote.mcpHeaders.length).toBeGreaterThanOrEqual(1)
    expect(remote.mcpHeaders.every((headers) => headers.authorization === 'Bearer e2e-access-token-1')).toBe(
      true,
    )
  })

  it('rejects the token exchange when the PKCE code_verifier does not match the code_challenge (fixture actually enforces PKCE, not just records it)', async () => {
    // This is the mutation-equivalent proof for the new PKCE check this file's fixture adds (see
    // header comment): rather than mutate production code, this test drives the fixture's /token
    // directly with a wrong verifier and asserts the fixture itself rejects it - demonstrating the
    // happy-path test above is not vacuously green because the fixture never actually checks PKCE.
    const remote = await startFixtureRemoteMcpServer()
    remote.setTokenIssuance({ accessToken: 'unused', refreshToken: 'unused', expiresIn: 3600 })
    const authorizeUrl = new URL('/authorize', remote.origin)
    authorizeUrl.searchParams.set('client_id', STATIC_CLIENT_ID)
    authorizeUrl.searchParams.set('redirect_uri', 'http://127.0.0.1:1/oauth/x/callback')
    authorizeUrl.searchParams.set('code_challenge', 'a-real-challenge-value')
    authorizeUrl.searchParams.set('code_challenge_method', 'S256')
    authorizeUrl.searchParams.set('state', 's')
    const authorizeResponse = await fetch(authorizeUrl, { redirect: 'manual' })
    const location = new URL(authorizeResponse.headers.get('location') as string)
    const code = location.searchParams.get('code') as string

    const tokenResponse = await fetch(new URL('/token', remote.origin), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: 'the-wrong-verifier-entirely',
        redirect_uri: 'http://127.0.0.1:1/oauth/x/callback',
        client_id: STATIC_CLIENT_ID,
      }),
    })

    expect(tokenResponse.status).toBe(400)
    const body = (await tokenResponse.json()) as { error: string }
    expect(body.error).toBe('invalid_grant')
  })
})
