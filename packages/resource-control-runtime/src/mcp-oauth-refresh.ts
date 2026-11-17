import { refreshAuthorization } from '@modelcontextprotocol/sdk/client/auth.js'
import { InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { McpOAuthNeedsReconnectError } from './mcp-oauth-error.js'
import {
  canonicalUrl,
  clientAuthentication,
  McpOAuthClientAuthUnsupported,
  tokensFromResponse,
} from './mcp-oauth-protocol.js'
import type { McpOAuthNext, McpOAuthRecord, McpOAuthServer, McpOAuthStore } from './mcp-oauth-store.js'
import { discoverMcpOAuth, type McpOAuthDiscovery } from './oauth-client.js'
import { withTimeout } from './oauth-fetch.js'

const REQUEST_TIMEOUT_MS = 10_000

type Outcome = Readonly<{ record: McpOAuthRecord }> | Readonly<{ error: unknown }>

/**
 * Exchanges the stored refresh token for new tokens and writes them back, so that several
 * processes sharing one credential never spend a rotating refresh token twice.
 *
 * Discovery runs first, outside the store's lock, and is compared with what the login recorded;
 * only then does the locked step run: re-read, return the stored record when someone else already
 * wrote a new token (or `epoch` moved), otherwise make the one token request and write the result.
 * Failures that need the user (`McpOAuthNeedsReconnectError`) never leave a half-written record:
 * `invalid_grant` drops the tokens and keeps the client and server; a network failure or any other
 * error leaves everything as it was.
 */
export async function refreshMcpOAuth(input: {
  serverId: string
  serverUrl: URL
  seen: McpOAuthRecord
  store: McpOAuthStore
  staticClient?: Readonly<{ clientId: string; clientSecret?: string }>
  fetchImpl: FetchLike
  now?: () => number
}): Promise<McpOAuthRecord> {
  const { serverId, serverUrl, seen, store } = input
  const now = input.now ?? Date.now
  const fetchImpl = withTimeout(input.fetchImpl, REQUEST_TIMEOUT_MS)
  const needsLogin = (reason: 'login-required' | 'endpoint-changed', cause?: unknown) =>
    new McpOAuthNeedsReconnectError(serverId, reason, cause === undefined ? undefined : { cause })

  if (!seen.client || !seen.server || !seen.tokens?.refreshToken) throw needsLogin('login-required')
  if (canonicalUrl(seen.server.endpoint) !== canonicalUrl(serverUrl)) throw needsLogin('endpoint-changed')

  let discovery: McpOAuthDiscovery
  try {
    discovery = await discoverMcpOAuth(serverUrl, fetchImpl)
  } catch (cause) {
    throw needsLogin('endpoint-changed', cause)
  }
  // The login found authorization server metadata but this round found none: the server could not be
  // reached, which says nothing about whether it moved. Keep the tokens and ask for a retry.
  if (!discovery.metadata && seen.server.issuer)
    throw needsLogin('login-required', new Error('authorization server metadata could not be fetched'))
  if (serverDrifted(seen.server, discovery)) throw needsLogin('endpoint-changed')

  const outcome = await store.update<Outcome>(serverId, async (current) => {
    if (!current || 'legacy' in current || !current.client || !current.server || !current.tokens)
      return { value: { error: needsLogin('login-required') } }
    // Another writer left a new token (or a sign-out and in): use it. A write that only changed
    // something else, such as `requiredScope`, leaves the same token, which still needs a refresh.
    if (current.epoch !== seen.epoch || current.tokens.accessToken !== seen.tokens?.accessToken)
      return { value: { record: current } }
    const { client, server, tokens } = current
    if (!tokens.refreshToken) return { value: { error: needsLogin('login-required') } }

    const keep: McpOAuthNext = { epoch: current.epoch, client, server, requiredScope: current.requiredScope }
    const clientSecret =
      input.staticClient?.clientId === client.clientId
        ? (input.staticClient.clientSecret ?? client.clientSecret)
        : client.clientSecret
    try {
      const addClientAuthentication = clientAuthentication({
        clientId: client.clientId,
        ...(clientSecret ? { clientSecret } : {}),
        ...(client.tokenEndpointAuthMethod ? { registeredMethod: client.tokenEndpointAuthMethod } : {}),
        ...(discovery.metadata?.token_endpoint_auth_methods_supported
          ? { supportedMethods: discovery.metadata.token_endpoint_auth_methods_supported }
          : {}),
      })
      const response = await refreshAuthorization(discovery.authorizationServer, {
        ...(discovery.metadata ? { metadata: discovery.metadata } : {}),
        clientInformation: {
          client_id: client.clientId,
          ...(clientSecret ? { client_secret: clientSecret } : {}),
        },
        refreshToken: tokens.refreshToken,
        resource: new URL(server.resource),
        addClientAuthentication,
        fetchFn: fetchImpl,
      })
      const next: McpOAuthNext = {
        ...keep,
        tokens: tokensFromResponse(response, { now: now(), previous: tokens, requested: tokens.scope }),
      }
      return { value: { record: { ...next, version: 2, kind: 'oauth', rev: current.rev + 1 } }, next }
    } catch (error) {
      // The refresh token is spent or revoked: forget the tokens, keep who we are and where.
      if (error instanceof InvalidGrantError)
        return { value: { error: needsLogin('login-required', error) }, next: keep }
      if (error instanceof McpOAuthClientAuthUnsupported) return { value: { error } }
      // Network failure, timeout, server error: keep the tokens and try again next time.
      return { value: { error: needsLogin('login-required', error) } }
    }
  })
  if ('error' in outcome) throw outcome.error
  return outcome.record
}

/** Whether discovery now names another token endpoint, issuer or resource than the one recorded. */
export function serverDrifted(
  recorded: Pick<McpOAuthServer, 'tokenEndpoint' | 'issuer' | 'resource'>,
  found: McpOAuthDiscovery,
): boolean {
  return (
    canonicalUrl(recorded.tokenEndpoint) !== canonicalUrl(found.tokenEndpoint) ||
    recorded.issuer !== found.issuer ||
    canonicalUrl(recorded.resource) !== canonicalUrl(found.resource)
  )
}
