import { resourceUrlFromServerUrl } from '@modelcontextprotocol/sdk/shared/auth-utils.js'
import { afterEach, describe, expect, it } from 'vitest'
import { OAUTH_REFRESH_LEEWAY_MS } from '../src/mcp.js'
import {
  canonicalUrl,
  clientAuthentication,
  McpOAuthClientAuthUnsupported,
  parseScope,
  requestedScope,
  tokensFromResponse,
} from '../src/mcp-oauth-protocol.js'
import { discoverMcpOAuth } from '../src/oauth-client.js'
import { type FakeOAuthServer, startFakeOAuthServer } from './helpers/fake-oauth.js'

async function applyAuth(
  add: ReturnType<typeof clientAuthentication>,
): Promise<{ headers: Headers; params: URLSearchParams }> {
  const headers = new Headers()
  const params = new URLSearchParams({ grant_type: 'refresh_token' })
  await add(headers, params, 'https://as.example/token')
  return { headers, params }
}

describe('clientAuthentication', () => {
  it('no supported-methods field: basic', async () => {
    const { headers, params } = await applyAuth(
      clientAuthentication({ clientId: 'id', clientSecret: 'secret' }),
    )
    expect(headers.get('authorization')).toBe(`Basic ${Buffer.from('id:secret').toString('base64')}`)
    expect(params.has('client_secret')).toBe(false)
  })

  it('only post listed: post', async () => {
    const { headers, params } = await applyAuth(
      clientAuthentication({
        clientId: 'id',
        clientSecret: 'secret',
        supportedMethods: ['client_secret_post'],
      }),
    )
    expect(headers.has('authorization')).toBe(false)
    expect(params.get('client_id')).toBe('id')
    expect(params.get('client_secret')).toBe('secret')
  })

  it('only private_key_jwt listed: unsupported', () => {
    const build = () =>
      clientAuthentication({ clientId: 'id', clientSecret: 'secret', supportedMethods: ['private_key_jwt'] })
    expect(build).toThrow(McpOAuthClientAuthUnsupported)
    try {
      build()
    } catch (error) {
      expect((error as McpOAuthClientAuthUnsupported).code).toBe('MCP_OAUTH_CLIENT_AUTH_UNSUPPORTED')
    }
  })

  it('registered post beats a server that prefers basic', async () => {
    const { headers, params } = await applyAuth(
      clientAuthentication({
        clientId: 'id',
        clientSecret: 'secret',
        registeredMethod: 'client_secret_post',
        supportedMethods: ['client_secret_basic', 'client_secret_post'],
      }),
    )
    expect(headers.has('authorization')).toBe(false)
    expect(params.get('client_secret')).toBe('secret')
  })

  it('registered private_key_jwt: unsupported', () => {
    expect(() =>
      clientAuthentication({ clientId: 'id', clientSecret: 'secret', registeredMethod: 'private_key_jwt' }),
    ).toThrow(McpOAuthClientAuthUnsupported)
  })

  it('registered method the server does not list: unsupported', () => {
    expect(() =>
      clientAuthentication({
        clientId: 'id',
        clientSecret: 'secret',
        registeredMethod: 'client_secret_basic',
        supportedMethods: ['client_secret_post'],
      }),
    ).toThrow(McpOAuthClientAuthUnsupported)
  })

  it('a registered public client uses none even when the server does not list none', async () => {
    // Keycloak registers a public client for `none` but never lists `none` among its methods.
    const { headers, params } = await applyAuth(
      clientAuthentication({
        clientId: 'id',
        registeredMethod: 'none',
        supportedMethods: ['client_secret_basic', 'client_secret_post', 'private_key_jwt'],
      }),
    )
    expect(headers.has('authorization')).toBe(false)
    expect(params.get('client_id')).toBe('id')
    expect(params.has('client_secret')).toBe(false)
  })

  it('no secret: none sends client_id in the form', async () => {
    const { headers, params } = await applyAuth(clientAuthentication({ clientId: 'id' }))
    expect(headers.has('authorization')).toBe(false)
    expect(params.get('client_id')).toBe('id')
    expect(params.has('client_secret')).toBe(false)
  })

  it('secret with a server listing only none: unsupported', () => {
    expect(() =>
      clientAuthentication({ clientId: 'id', clientSecret: 'secret', supportedMethods: ['none'] }),
    ).toThrow(McpOAuthClientAuthUnsupported)
  })
})

describe('parseScope', () => {
  it('accepts plain and url-shaped scope tokens', () => {
    expect(parseScope('Mail.Read https://www.googleapis.com/auth/drive')).toEqual([
      'Mail.Read',
      'https://www.googleapis.com/auth/drive',
    ])
    expect(parseScope(undefined)).toEqual([])
    expect(parseScope('')).toEqual([])
  })

  it('rejects quotes and backslashes', () => {
    expect(() => parseScope('a"b')).toThrow()
    expect(() => parseScope('a\\b')).toThrow()
  })

  it('rejects tokens over 1024 characters and lists over 128 tokens', () => {
    expect(() => parseScope('a'.repeat(1025))).toThrow()
    expect(parseScope('a'.repeat(1024))).toHaveLength(1)
    expect(() => parseScope(Array.from({ length: 129 }, (_, i) => `s${i}`).join(' '))).toThrow()
  })
})

describe('tokensFromResponse', () => {
  const response = { access_token: 'at', token_type: 'Bearer' }

  it('without expires_in the token lasts one hour', () => {
    expect(tokensFromResponse(response, { now: 1_000, requested: [] }).expiresAt).toBe(1_000 + 3_600_000)
    expect(tokensFromResponse({ ...response, expires_in: 60 }, { now: 1_000, requested: [] }).expiresAt).toBe(
      61_000,
    )
  })

  it('a zero, negative or tiny expires_in does not land inside the early-refresh window', () => {
    const leeway = OAUTH_REFRESH_LEEWAY_MS
    for (const expiresIn of [0, -5, Number.NaN, 5]) {
      const { expiresAt } = tokensFromResponse(
        { ...response, expires_in: expiresIn },
        { now: 0, requested: [] },
      )
      expect(expiresAt).toBeGreaterThan(leeway)
    }
    expect(tokensFromResponse({ ...response, expires_in: 0 }, { now: 0, requested: [] }).expiresAt).toBe(
      3_600_000,
    )
  })

  it('without refresh_token keeps the previous one', () => {
    const previous = { accessToken: 'old', refreshToken: 'rt-old', expiresAt: 1, scope: ['a'] }
    expect(tokensFromResponse(response, { now: 0, previous, requested: [] }).refreshToken).toBe('rt-old')
    expect(
      tokensFromResponse({ ...response, refresh_token: 'rt-new' }, { now: 0, previous, requested: [] })
        .refreshToken,
    ).toBe('rt-new')
    expect(tokensFromResponse(response, { now: 0, requested: [] }).refreshToken).toBeUndefined()
  })

  it('without scope uses the previous scope, then the requested one', () => {
    const previous = { accessToken: 'old', expiresAt: 1, scope: ['prev'] }
    expect(tokensFromResponse(response, { now: 0, previous, requested: ['asked'] }).scope).toEqual(['prev'])
    expect(tokensFromResponse(response, { now: 0, requested: ['asked'] }).scope).toEqual(['asked'])
    expect(
      tokensFromResponse({ ...response, scope: 'x y' }, { now: 0, previous, requested: [] }).scope,
    ).toEqual(['x', 'y'])
  })
})

describe('requestedScope', () => {
  it('uses required plus granted when something is required, else the supported scopes', () => {
    expect(
      requestedScope({ granted: ['a'], required: ['b'], scopesSupported: ['s'], offlineAccess: false }),
    ).toEqual(['b', 'a'])
    expect(
      requestedScope({ granted: ['a'], required: [], scopesSupported: ['s', 't'], offlineAccess: false }),
    ).toEqual(['s', 't'])
  })

  it('adds offline_access once', () => {
    expect(
      requestedScope({ granted: [], required: [], scopesSupported: ['s'], offlineAccess: true }),
    ).toEqual(['s', 'offline_access'])
    expect(
      requestedScope({ granted: [], required: [], scopesSupported: ['offline_access'], offlineAccess: true }),
    ).toEqual(['offline_access'])
    expect(
      requestedScope({ granted: ['a', 'a'], required: ['a'], scopesSupported: [], offlineAccess: false }),
    ).toEqual(['a'])
  })
})

describe('canonicalUrl', () => {
  it('canonical comparison ignores case, default port and trailing slash', () => {
    expect(canonicalUrl('HTTPS://X.com:443/mcp/')).toBe(canonicalUrl('https://x.com/mcp'))
    expect(canonicalUrl(new URL('https://x.com/mcp#frag'))).toBe(canonicalUrl('https://x.com/mcp'))
    expect(canonicalUrl('https://x.com/mcp')).not.toBe(canonicalUrl('https://x.com/other'))
    expect(canonicalUrl('https://x.com:8443/mcp')).not.toBe(canonicalUrl('https://x.com/mcp'))
  })
})

describe('discoverMcpOAuth', () => {
  let fake: FakeOAuthServer | undefined
  afterEach(async () => {
    await fake?.close()
    fake = undefined
  })

  it('adopts a protected resource on the same origin whose path is a prefix', async () => {
    fake = await startFakeOAuthServer({ prm: { resource: '/mcp', scopes: ['read', 'write'] } })
    const serverUrl = new URL('/mcp/v1', fake.url)
    const found = await discoverMcpOAuth(serverUrl, fake.fetchImpl)
    expect(found.resource.href).toBe(new URL('/mcp', fake.url).href)
    expect(found.scopesSupported).toEqual(['read', 'write'])
    expect(found.tokenEndpoint.href).toBe(new URL('/token', fake.httpsUrl).href)
    expect(found.authorizationServer.href).toBe(`${fake.httpsUrl.href}`)
    expect(found.issuer).toBe(fake.httpsUrl.origin)
    expect(found.metadata?.token_endpoint).toBe(found.tokenEndpoint.href)
  })

  it('refuses a protected resource on another origin', async () => {
    fake = await startFakeOAuthServer({ prm: { resource: 'https://elsewhere.example/mcp' } })
    await expect(discoverMcpOAuth(fake.serverUrl, fake.fetchImpl)).rejects.toThrow()
  })

  it('refuses a protected resource that is not a path prefix of the server', async () => {
    fake = await startFakeOAuthServer({ prm: { resource: '/other' } })
    await expect(discoverMcpOAuth(fake.serverUrl, fake.fetchImpl)).rejects.toThrow()
  })

  it('without protected resource metadata the resource is the canonical server address', async () => {
    fake = await startFakeOAuthServer()
    const serverUrl = new URL('/mcp/', fake.url)
    const found = await discoverMcpOAuth(serverUrl, fake.fetchImpl)
    expect(found.resource.href).toBe(resourceUrlFromServerUrl(serverUrl).href)
    expect(found.resource.href).toBe(serverUrl.href)
    expect(found.scopesSupported).toEqual([])
  })

  it('without authorization server metadata the token endpoint is /token on the server origin', async () => {
    const found = await discoverMcpOAuth(
      new URL('https://nometa.example/mcp'),
      (async () => new Response(null, { status: 404 })) as typeof fetch,
    )
    expect(found.tokenEndpoint.href).toBe('https://nometa.example/token')
    expect(found.metadata).toBeUndefined()
    expect(found.issuer).toBeUndefined()
    expect(found.resource.href).toBe('https://nometa.example/mcp')
  })

  describe('an authorization side that is refused', () => {
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    const metadata = (tokenEndpoint: string) => ({
      issuer: 'https://as.example',
      authorization_endpoint: 'https://as.example/authorize',
      token_endpoint: tokenEndpoint,
      response_types_supported: ['code'],
    })
    const serving =
      (authorizationServer: string, tokenEndpoint: string): typeof fetch =>
      async (input) => {
        const path = new URL(String(input)).pathname
        if (path.startsWith('/.well-known/oauth-protected-resource'))
          return json({ resource: 'https://mcp.example/mcp', authorization_servers: [authorizationServer] })
        if (path.startsWith('/.well-known/oauth-authorization-server')) return json(metadata(tokenEndpoint))
        return new Response(null, { status: 404 })
      }

    it('is recorded when the protected resource names a plain http authorization server', async () => {
      const found = await discoverMcpOAuth(
        new URL('https://mcp.example/mcp'),
        serving('http://localhost:3911/', 'http://localhost:3911/token'),
      )
      expect(found.refusedEndpoint).toBe('http://localhost:3911/')
    })

    it('is recorded when the authorization server metadata names a plain http endpoint', async () => {
      const found = await discoverMcpOAuth(
        new URL('https://mcp.example/mcp'),
        serving('https://as.example/', 'http://as.example/token'),
      )
      expect(found.refusedEndpoint).toBe('http://as.example/token')
    })

    it('is absent for an https authorization side', async () => {
      const found = await discoverMcpOAuth(
        new URL('https://mcp.example/mcp'),
        serving('https://as.example/', 'https://as.example/token'),
      )
      expect(found.refusedEndpoint).toBeUndefined()
    })
  })
})
