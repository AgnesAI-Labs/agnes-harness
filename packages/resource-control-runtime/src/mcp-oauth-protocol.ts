import type { AddClientAuthentication } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { OAUTH_REFRESH_LEEWAY_MS } from './mcp-oauth-error.js'
import type { McpOAuthTokens } from './mcp-oauth-store.js'

/** Token lifetime assumed when the token response carries no `expires_in`. */
const DEFAULT_EXPIRES_IN_MS = 3_600_000
/**
 * Shortest lifetime stored for a token: twice the early-refresh window, so a token the server
 * calls short-lived is never already due for refresh the moment it is stored (every request checks
 * the expiry, so that would turn each request into a token request).
 */
const MIN_LIFETIME_MS = OAUTH_REFRESH_LEEWAY_MS * 2
const MAX_SCOPE_TOKEN_LENGTH = 1024
const MAX_SCOPE_TOKENS = 128
/** RFC 6749 scope-token: `%x21 / %x23-5B / %x5D-7E` (printable ASCII without space, `"` and `\`). */
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/

/**
 * Comparable form of an address: scheme and host in lower case, default port dropped, no fragment,
 * and no trailing slash on the path (the root path stays `/`).
 */
export function canonicalUrl(value: string | URL): string {
  const url = new URL(typeof value === 'string' ? value : value.href)
  url.hash = ''
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  return url.href
}

/** Splits a space-separated scope string and checks each token against RFC 6749. */
export function parseScope(value: string | undefined): string[] {
  const tokens = [...new Set((value ?? '').split(/[ \t\r\n]+/).filter((token) => token.length > 0))]
  if (tokens.length > MAX_SCOPE_TOKENS) throw new Error(`scope has more than ${MAX_SCOPE_TOKENS} tokens`)
  for (const token of tokens) {
    if (token.length > MAX_SCOPE_TOKEN_LENGTH || !SCOPE_TOKEN.test(token))
      throw new Error('scope contains a token that is not valid under RFC 6749')
  }
  return tokens
}

/**
 * Scope to ask for. Something required (after a refused call) asks for it together with what was
 * already granted; otherwise the resource's advertised scopes. `offline_access` is added when the
 * authorization server supports it, so a refresh token comes back.
 */
export function requestedScope(input: {
  granted: readonly string[]
  required: readonly string[]
  scopesSupported: readonly string[]
  offlineAccess: boolean
}): string[] {
  const scope = new Set(
    input.required.length > 0 ? [...input.required, ...input.granted] : input.scopesSupported,
  )
  if (input.offlineAccess) scope.add('offline_access')
  return [...scope]
}

/**
 * Turns a token response into the stored shape. A missing `expires_in` means one hour, a missing
 * `refresh_token` keeps the previous one, and a missing `scope` keeps the previous grant (or what
 * was asked for when there is no previous grant).
 */
export function tokensFromResponse(
  response: OAuthTokens,
  input: { now: number; previous?: McpOAuthTokens; requested: readonly string[] },
): McpOAuthTokens {
  const refreshToken = response.refresh_token ?? input.previous?.refreshToken
  const previousScope = input.previous?.scope ?? []
  const scope = response.scope
    ? parseScope(response.scope)
    : previousScope.length > 0
      ? [...previousScope]
      : [...input.requested]
  return {
    accessToken: response.access_token,
    ...(refreshToken ? { refreshToken } : {}),
    expiresAt: input.now + lifetimeMs(response.expires_in),
    scope,
  }
}

/** A missing, zero, negative or non-finite `expires_in` means one hour; anything short is raised to the minimum. */
function lifetimeMs(expiresIn: number | undefined): number {
  if (expiresIn === undefined || !Number.isFinite(expiresIn) || expiresIn <= 0) return DEFAULT_EXPIRES_IN_MS
  return Math.max(expiresIn * 1000, MIN_LIFETIME_MS)
}

export class McpOAuthClientAuthUnsupported extends Error {
  readonly code = 'MCP_OAUTH_CLIENT_AUTH_UNSUPPORTED'
  readonly method: string
  constructor(method: string) {
    super(
      `The authorization server requires a client authentication method that Agnes does not support: ${method}`,
    )
    this.name = 'McpOAuthClientAuthUnsupported'
    this.method = method
  }
}

type SupportedMethod = 'client_secret_basic' | 'client_secret_post' | 'none'

function isSupportedMethod(method: string): method is SupportedMethod {
  return method === 'client_secret_basic' || method === 'client_secret_post' || method === 'none'
}

/**
 * Chooses how the client proves itself at the token endpoint, once, when the hook is built:
 * 1. the method the registration settled on, if it is one Agnes can do and the server lists it
 *    (or lists nothing);
 * 2. otherwise, with a secret: basic when the server lists no methods at all or lists basic, else
 *    post when listed, else unsupported;
 * 3. without a secret: `none` (only `client_id`).
 * The SDK's own selection is bypassed, so a server that lists something else is never sent a
 * method it did not list. Throws `McpOAuthClientAuthUnsupported` before any request is made.
 */
export function clientAuthentication(input: {
  clientId: string
  clientSecret?: string
  registeredMethod?: string
  supportedMethods?: readonly string[]
}): AddClientAuthentication {
  const { clientId, clientSecret, supportedMethods } = input
  const method = chooseMethod(input)
  return (headers, params) => {
    switch (method) {
      case 'client_secret_basic':
        headers.set(
          'Authorization',
          `Basic ${Buffer.from(`${clientId}:${clientSecret ?? ''}`).toString('base64')}`,
        )
        return
      case 'client_secret_post':
        params.set('client_id', clientId)
        if (clientSecret) params.set('client_secret', clientSecret)
        return
      case 'none':
        params.set('client_id', clientId)
    }
  }

  function chooseMethod(options: typeof input): SupportedMethod {
    if (options.registeredMethod !== undefined) {
      const registered = options.registeredMethod
      if (!isSupportedMethod(registered) || (supportedMethods && !supportedMethods.includes(registered)))
        throw new McpOAuthClientAuthUnsupported(registered)
      if (registered === 'client_secret_basic' && !clientSecret)
        throw new McpOAuthClientAuthUnsupported(registered)
      return registered
    }
    if (!clientSecret) return 'none'
    if (!supportedMethods) return 'client_secret_basic'
    if (supportedMethods.includes('client_secret_basic')) return 'client_secret_basic'
    if (supportedMethods.includes('client_secret_post')) return 'client_secret_post'
    throw new McpOAuthClientAuthUnsupported(supportedMethods.join(', ') || 'none listed')
  }
}
