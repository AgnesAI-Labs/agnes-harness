import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'

/**
 * A real `node:http` server that plays the MCP resource server and its authorization server on one
 * origin: protected resource metadata, RFC 8414 metadata, `/register`, `/authorize` and `/token`.
 * Metadata advertises `https:` addresses (the production code refuses plain http endpoints), and
 * `fetchImpl` rewrites those back to the plain-http listener, so no TLS is involved.
 */
export type FakeOAuthOptions = Readonly<{
  /** `token_endpoint_auth_methods_supported`; the field is left out when undefined. */
  authMethods?: string[]
  /** Authorization server `scopes_supported`; the field is left out when undefined. */
  asScopes?: string[]
  /** Protected resource metadata. `resource` is an absolute URL or a path on this server. */
  prm?: Readonly<{ resource: string; scopes?: string[] }>
  /** What `/register` hands back. */
  registration?: Readonly<{ clientId?: string; clientSecret?: string; tokenEndpointAuthMethod?: string }>
  /** Token endpoint response. An object with an `error` field is sent as a 400. */
  tokenResponse?: (grant: FakeGrant) => object
}>

export type FakeGrant = Readonly<{
  grantType: string
  form: Readonly<Record<string, string>>
  headers: Readonly<Record<string, string>>
}>

export type FakeTokenRequest = FakeGrant & Readonly<{ method: string; path: string }>

export type FakeOAuthServer = Readonly<{
  /** Plain-http origin the listener is bound to. */
  url: URL
  /** The same origin with an `https:` scheme, as advertised in metadata. */
  httpsUrl: URL
  /** `<url>/mcp`: the address a test passes as the MCP server URL. */
  serverUrl: URL
  /** Fetch that maps `https:` targets back onto the listener. */
  fetchImpl: FetchLike
  /** Token requests in arrival order. */
  requests(): FakeTokenRequest[]
  /** Every request path in arrival order (discovery, register, authorize, token). */
  paths(): string[]
  setTokenResponse(next: ((grant: FakeGrant) => object) | undefined): void
  close(): Promise<void>
}>

export async function startFakeOAuthServer(options: FakeOAuthOptions = {}): Promise<FakeOAuthServer> {
  const tokenRequests: FakeTokenRequest[] = []
  const paths: string[] = []
  const codes = new Map<string, { challenge: string; redirectUri: string }>()
  let tokenResponse = options.tokenResponse
  let issued = 0
  let origin = ''
  let httpsOrigin = ''

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      res.writeHead(500).end(String(error))
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', origin)
    paths.push(url.pathname)
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    }

    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      if (!options.prm) return void res.writeHead(404).end()
      const resource = options.prm.resource.startsWith('/')
        ? new URL(options.prm.resource, origin).toString()
        : options.prm.resource
      return send(200, {
        resource,
        authorization_servers: [httpsOrigin],
        ...(options.prm.scopes ? { scopes_supported: options.prm.scopes } : {}),
      })
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return send(200, {
        issuer: httpsOrigin,
        authorization_endpoint: `${httpsOrigin}/authorize`,
        token_endpoint: `${httpsOrigin}/token`,
        registration_endpoint: `${httpsOrigin}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        ...(options.authMethods ? { token_endpoint_auth_methods_supported: options.authMethods } : {}),
        ...(options.asScopes ? { scopes_supported: options.asScopes } : {}),
      })
    }
    if (url.pathname === '/register' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as { redirect_uris?: string[] }
      const registration = options.registration ?? {}
      return send(201, {
        client_id: registration.clientId ?? 'fake-client',
        ...(registration.clientSecret ? { client_secret: registration.clientSecret } : {}),
        ...(registration.tokenEndpointAuthMethod
          ? { token_endpoint_auth_method: registration.tokenEndpointAuthMethod }
          : {}),
        redirect_uris: body.redirect_uris ?? [],
      })
    }
    if (url.pathname === '/authorize' && req.method === 'GET') {
      const redirectUri = url.searchParams.get('redirect_uri')
      const challenge = url.searchParams.get('code_challenge')
      if (
        url.searchParams.get('response_type') !== 'code' ||
        url.searchParams.get('code_challenge_method') !== 'S256' ||
        !redirectUri ||
        !challenge
      )
        return send(400, { error: 'invalid_request' })
      const code = randomBytes(8).toString('hex')
      codes.set(code, { challenge, redirectUri })
      const target = new URL(redirectUri)
      target.searchParams.set('code', code)
      const state = url.searchParams.get('state')
      if (state) target.searchParams.set('state', state)
      return void res.writeHead(302, { location: target.toString() }).end()
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const form = Object.fromEntries(new URLSearchParams(await readBody(req)))
      const headers = Object.fromEntries(
        Object.entries(req.headers).flatMap(([name, value]) =>
          typeof value === 'string' ? [[name, value]] : [],
        ),
      )
      const grant: FakeGrant = { grantType: form.grant_type ?? '', form, headers }
      tokenRequests.push({ ...grant, method: req.method, path: url.pathname })
      if (grant.grantType === 'authorization_code') {
        const issuedCode = codes.get(form.code ?? '')
        const verifier = form.code_verifier ?? ''
        const expected = createHash('sha256').update(verifier).digest('base64url')
        if (!issuedCode || issuedCode.challenge !== expected || issuedCode.redirectUri !== form.redirect_uri)
          return send(400, { error: 'invalid_grant' })
        codes.delete(form.code ?? '')
      } else if (grant.grantType !== 'refresh_token') {
        return send(400, { error: 'unsupported_grant_type' })
      }
      issued += 1
      const body = tokenResponse?.(grant) ?? {
        access_token: `at-${issued}`,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: `rt-${issued}`,
      }
      return send('error' in body ? 400 : 200, body)
    }
    res.writeHead(404).end()
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing fake oauth address')
  origin = `http://127.0.0.1:${address.port}`
  httpsOrigin = `https://127.0.0.1:${address.port}`

  const fetchImpl: FetchLike = async (input, init) => {
    const target = new URL(typeof input === 'string' ? input : input.toString())
    if (target.protocol === 'https:') target.protocol = 'http:'
    return fetch(target, init)
  }

  return {
    url: new URL(origin),
    httpsUrl: new URL(httpsOrigin),
    serverUrl: new URL('/mcp', origin),
    fetchImpl,
    requests: () => [...tokenRequests],
    paths: () => [...paths],
    setTokenResponse(next) {
      tokenResponse = next
    },
    close() {
      server.closeAllConnections()
      return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    },
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}
