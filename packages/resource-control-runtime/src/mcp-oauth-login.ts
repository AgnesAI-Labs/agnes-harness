import { exchangeAuthorization, startAuthorization } from '@modelcontextprotocol/sdk/client/auth.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { clientAuthentication, requestedScope, tokensFromResponse } from './mcp-oauth-protocol.js'
import { serverDrifted } from './mcp-oauth-refresh.js'
import type { McpOAuthClient, McpOAuthNext, McpOAuthRead, McpOAuthStore } from './mcp-oauth-store.js'
import { discoverMcpOAuth, type McpOAuthDiscovery, registerDynamicClient } from './oauth-client.js'
import { withTimeout } from './oauth-fetch.js'

const REQUEST_TIMEOUT_MS = 10_000

/** What a client may know about a server's sign-in: never a token or a secret. */
export type McpOAuthSummary = Readonly<{
  epoch: number
  signedIn: boolean
  refreshable: boolean
  expiresAt?: number
  scope: readonly string[]
  requiredScope: readonly string[]
  client?: Readonly<{ clientId: string; redirectUri: string }>
}>

/** The authorization side a sign-in started with; the code may only be spent there. */
export type McpOAuthLoginAuthorization = Readonly<{
  tokenEndpoint: string
  issuer?: string
  resource: string
}>

/** Everything the browser step needs, plus what the completion must send back unchanged. */
export type McpOAuthLoginStart = Readonly<{
  authorizationUrl: URL
  codeVerifier: string
  client: Readonly<{ clientId: string; clientSecret?: string; tokenEndpointAuthMethod?: string }>
  requestedScope: readonly string[]
  expectedEpoch: number
  authorization: McpOAuthLoginAuthorization
}>

/** The daemon's sign-in completion request, without the profile. */
export type McpOAuthCompleteParams = Readonly<{
  serverId: string
  expectedEpoch: number
  code: string
  codeVerifier: string
  redirectUri: string
  client: McpOAuthLoginStart['client']
  requestedScope: readonly string[]
  authorization: McpOAuthLoginAuthorization
}>

/** The user signed out (or signed in again elsewhere) while this sign-in was in the browser. */
export class McpOAuthLoginSuperseded extends Error {
  readonly code = 'MCP_OAUTH_LOGIN_SUPERSEDED'
  constructor(serverId: string) {
    super(`MCP server "${serverId}" was signed out during this sign-in; sign in again`)
    this.name = 'McpOAuthLoginSuperseded'
  }
}

/**
 * The server's authorization side (token endpoint, issuer or resource) is not the one the sign-in
 * started with, so the authorization code is not sent anywhere.
 */
export class McpOAuthLoginEndpointChanged extends Error {
  readonly code = 'MCP_OAUTH_LOGIN_ENDPOINT_CHANGED'
  constructor(serverId: string) {
    super(`The OAuth settings of MCP server "${serverId}" changed during this sign-in; sign in again`)
    this.name = 'McpOAuthLoginEndpointChanged'
  }
}

/** The server's protected resource metadata does not cover the server address. */
export class McpOAuthDiscoveryFailed extends Error {
  readonly code = 'MCP_OAUTH_DISCOVERY_FAILED'
  constructor(options?: { cause?: unknown }) {
    super('The server OAuth metadata could not be used', options)
    this.name = 'McpOAuthDiscoveryFailed'
  }
}

export function summarizeMcpOAuth(read: McpOAuthRead): McpOAuthSummary {
  if (!read || 'legacy' in read)
    return { epoch: 0, signedIn: false, refreshable: false, scope: [], requiredScope: [] }
  const { client, server, tokens } = read
  const signedIn = !!(client && server && tokens)
  return {
    epoch: read.epoch,
    signedIn,
    refreshable: signedIn && !!tokens?.refreshToken,
    ...(tokens ? { expiresAt: tokens.expiresAt } : {}),
    scope: tokens ? [...tokens.scope] : [],
    requiredScope: [...read.requiredScope],
    ...(client ? { client: { clientId: client.clientId, redirectUri: client.redirectUri } } : {}),
  }
}

/**
 * Builds the authorization request. The client is, in order: the static client ID, the client a
 * previous registration stored for the same redirect address, or a new dynamic registration;
 * without any of them the caller must ask for a client ID. Scope is what was granted plus what a
 * refused call required, else what the resource advertises, with `offline_access` when the
 * authorization server supports it. `resource` is always sent.
 */
export async function beginMcpOAuthLogin(input: {
  serverId: string
  serverUrl: URL
  staticClientId?: string
  summary: McpOAuthSummary
  redirectUri: string
  fetchImpl: FetchLike
}): Promise<McpOAuthLoginStart | Readonly<{ pendingClientId: true }>> {
  const fetchImpl = withTimeout(input.fetchImpl, REQUEST_TIMEOUT_MS)
  const discovery = await discover(input.serverUrl, fetchImpl)
  const { summary } = input

  let client: McpOAuthLoginStart['client']
  if (input.staticClientId) client = { clientId: input.staticClientId }
  else if (summary.client && summary.client.redirectUri === input.redirectUri)
    client = { clientId: summary.client.clientId }
  else {
    const registered = await registerDynamicClient(
      discovery.authorizationServer,
      discovery.metadata,
      input.redirectUri,
      fetchImpl,
    )
    if ('pendingClientId' in registered) return { pendingClientId: true }
    client = {
      clientId: registered.clientId,
      ...(registered.clientSecret ? { clientSecret: registered.clientSecret } : {}),
      ...(registered.tokenEndpointAuthMethod
        ? { tokenEndpointAuthMethod: registered.tokenEndpointAuthMethod }
        : {}),
    }
  }

  const scope = requestedScope({
    granted: summary.scope,
    required: summary.requiredScope,
    scopesSupported: discovery.scopesSupported,
    offlineAccess: discovery.metadata?.scopes_supported?.includes('offline_access') ?? false,
  })
  // The SDK refuses a server that lists PKCE methods without S256.
  const started = await startAuthorization(discovery.authorizationServer, {
    ...(discovery.metadata ? { metadata: discovery.metadata } : {}),
    clientInformation: { client_id: client.clientId },
    redirectUrl: input.redirectUri,
    ...(scope.length > 0 ? { scope: scope.join(' ') } : {}),
    resource: discovery.resource,
  })
  return {
    authorizationUrl: started.authorizationUrl,
    codeVerifier: started.codeVerifier,
    client,
    requestedScope: scope,
    expectedEpoch: summary.epoch,
    authorization: {
      tokenEndpoint: discovery.tokenEndpoint.href,
      ...(discovery.issuer ? { issuer: discovery.issuer } : {}),
      resource: discovery.resource.href,
    },
  }
}

/**
 * Exchanges the authorization code and writes the credential. The sign-in is dropped, with nothing
 * written, when the stored `epoch` is no longer the one the sign-in started from (the user signed
 * out meanwhile); this is checked before the code is spent and again under the store's lock. It is
 * also refused, before any token request, when discovery now names another token endpoint, issuer
 * or resource than the sign-in started with. A file that cannot be read is replaced. `requiredScope` is cleared only when the new grant covers
 * it. A static client's secret is used for the request but never stored; a registered client's
 * secret and method are stored, and taken from the stored record when the caller has none.
 */
export async function completeMcpOAuthLogin(input: {
  serverId: string
  serverUrl: URL
  staticClient?: Readonly<{ clientId: string; clientSecret?: string }>
  expectedEpoch: number
  code: string
  codeVerifier: string
  redirectUri: string
  client: McpOAuthLoginStart['client']
  requestedScope: readonly string[]
  authorization: McpOAuthLoginAuthorization
  store: McpOAuthStore
  fetchImpl: FetchLike
  now?: () => number
}): Promise<void> {
  const { serverId, store, client } = input
  const now = input.now ?? Date.now
  const fetchImpl = withTimeout(input.fetchImpl, REQUEST_TIMEOUT_MS)

  const before = await store.update(
    serverId,
    async (current) => ({ value: { epoch: epochOf(current), client: clientOf(current) } }),
    { replaceUnreadable: true },
  )
  if (before.epoch !== input.expectedEpoch) throw new McpOAuthLoginSuperseded(serverId)

  const isStatic = input.staticClient?.clientId === client.clientId
  const kept = before.client?.clientId === client.clientId ? before.client : undefined
  const clientSecret = isStatic
    ? input.staticClient?.clientSecret
    : (client.clientSecret ?? kept?.clientSecret)
  const registeredMethod = isStatic
    ? undefined
    : (client.tokenEndpointAuthMethod ?? kept?.tokenEndpointAuthMethod)

  const discovery = await discover(input.serverUrl, fetchImpl)
  // The code, the PKCE verifier and any client secret go only to the token endpoint the sign-in
  // started with, for the same resource.
  if (serverDrifted(input.authorization, discovery)) throw new McpOAuthLoginEndpointChanged(serverId)
  const response = await exchangeAuthorization(discovery.authorizationServer, {
    ...(discovery.metadata ? { metadata: discovery.metadata } : {}),
    clientInformation: {
      client_id: client.clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
    },
    authorizationCode: input.code,
    codeVerifier: input.codeVerifier,
    redirectUri: input.redirectUri,
    resource: discovery.resource,
    addClientAuthentication: clientAuthentication({
      clientId: client.clientId,
      ...(clientSecret ? { clientSecret } : {}),
      ...(registeredMethod ? { registeredMethod } : {}),
      ...(discovery.metadata?.token_endpoint_auth_methods_supported
        ? { supportedMethods: discovery.metadata.token_endpoint_auth_methods_supported }
        : {}),
    }),
    fetchFn: fetchImpl,
  })
  const tokens = tokensFromResponse(response, { now: now(), requested: input.requestedScope })

  const storedClient: McpOAuthClient = {
    clientId: client.clientId,
    ...(!isStatic && clientSecret ? { clientSecret } : {}),
    ...(registeredMethod ? { tokenEndpointAuthMethod: registeredMethod } : {}),
    redirectUri: input.redirectUri,
  }
  const written = await store.update(
    serverId,
    async (current) => {
      const epoch = epochOf(current)
      if (epoch !== input.expectedEpoch) return { value: false }
      const required = current && !('legacy' in current) ? current.requiredScope : []
      const covered = required.every((scope) => tokens.scope.includes(scope))
      const next: McpOAuthNext = {
        epoch,
        client: storedClient,
        server: {
          endpoint: input.serverUrl.href,
          authorizationServer: discovery.authorizationServer.href,
          tokenEndpoint: discovery.tokenEndpoint.href,
          ...(discovery.issuer ? { issuer: discovery.issuer } : {}),
          resource: discovery.resource.href,
        },
        tokens,
        requiredScope: covered ? [] : [...required],
      }
      return { value: true, next }
    },
    { replaceUnreadable: true },
  )
  if (!written) throw new McpOAuthLoginSuperseded(serverId)
}

async function discover(serverUrl: URL, fetchImpl: FetchLike): Promise<McpOAuthDiscovery> {
  try {
    return await discoverMcpOAuth(serverUrl, fetchImpl)
  } catch (cause) {
    throw new McpOAuthDiscoveryFailed({ cause })
  }
}

function epochOf(read: McpOAuthRead): number {
  return read && !('legacy' in read) ? read.epoch : 0
}

function clientOf(read: McpOAuthRead): McpOAuthClient | undefined {
  return read && !('legacy' in read) ? read.client : undefined
}
