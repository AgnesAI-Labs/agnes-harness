import { refreshAuthorization } from '@modelcontextprotocol/sdk/client/auth.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpOAuthCredential, McpOAuthCredentialResolver } from './mcp.js'
import { resolveAuthorizationServerUrl, tryDiscoverAuthorizationServerMetadata } from './oauth-client.js'
import { credentialRefFor, withTimeout } from './oauth-http-handler.js'

/**
 * The real, worker-side implementation of `mcp.ts`'s `McpOAuthCredentialResolver` - Task 6's
 * companion to Task 4's `oauth-http-handler.ts` (the daemon-side HTTP callback endpoints) and built
 * on the same Task 3 `oauth-client.ts` generic discovery layer. Split into its own file rather than
 * folded into `mcp.ts` (which only declares the abstract `Options.oauthCredentials` shape and the
 * lazy-refresh *decision* logic) or into `oauth-client.ts` (deliberately MCP-agnostic, per that
 * file's own header) because importing `oauth-client.ts` from `mcp.ts` directly would be circular -
 * `oauth-client.ts` already imports `validateManagedHttpUrl` from `mcp.ts`. This file depends on
 * both `mcp.ts` and `oauth-client.ts`/`oauth-http-handler.ts` one-directionally instead.
 *
 * Reads the stored
 * `OAuthCredential` (structurally, not by importing `@agnes/host` - see `McpOAuthCredentialStore`'s
 * doc comment), and on `refresh()`, re-runs the same PRM/RFC 8414 discovery Task 4's `/start` route
 * uses before calling the SDK's `refreshAuthorization`. Every network call this makes goes through
 * `oauth-http-handler.ts`'s exported `withTimeout` - the exact same timeout + `redirect: 'error'`
 * guard every other SDK call in this OAuth flow uses (see that file's "SHARP EDGE" checklist
 * comment, which now also names this file) - never the SDK's own unguarded default `fetch`.
 */

/** Structural subset of `packages/host/src/adapters/credential-store.ts`'s `CredentialStore`
 * (`read`/`putOAuth` only). Deliberately NOT importing that type from `@agnes/host` - same
 * decoupling reasoning as `oauth-http-handler.ts`'s own `OAuthCredentialStoreWriter`/
 * `OAuthStoredCredential` types (this package has no dependency on `@agnes/host` today). `read()`'s
 * result type is intentionally loose (`kind: string`, every oauth-shaped field optional) rather than
 * reusing `McpOAuthCredential` directly: the real store's `read()` can also return an api-key
 * credential (a completely different shape, sharing only `kind`/`version`), and this resolver must
 * be able to recognize and reject that case at runtime instead of failing to type-check against it.
 */
export type McpOAuthCredentialStore = Readonly<{
  read(ref: string): Promise<Readonly<{
    kind: string
    provider?: string
    accessToken?: string
    refreshToken?: string
    expiresAt?: number
    scope?: readonly string[]
    grantId?: string
  }> | null>
  putOAuth(
    ref: string,
    value: Readonly<{
      provider: string
      accessToken: string
      refreshToken: string
      expiresAt: number
      scope: readonly string[]
      grantId: string
    }>,
  ): Promise<void>
}>

export type CreateMcpOAuthCredentialResolverOptions = Readonly<{
  credentialStore: McpOAuthCredentialStore
  /** Test seam; production leaves this unset and gets the SDK's own default (global `fetch`),
   * wrapped by `withTimeout` regardless (see module header). */
  fetchImpl?: FetchLike
  /** Bounds every network call this resolver's `refresh()` makes (discovery, token refresh).
   * Matches `oauth-http-handler.ts`'s own `DEFAULT_REQUEST_TIMEOUT_MS` for the identical reason: a
   * slow or malicious authorization server must not be able to hang the session worker process that
   * calls this indefinitely. */
  requestTimeoutMs?: number
}>

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000

function isStoredOAuthCredential(
  stored: Awaited<ReturnType<McpOAuthCredentialStore['read']>>,
): stored is Readonly<{
  kind: 'oauth'
  provider?: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  scope?: readonly string[]
  grantId?: string
}> {
  return (
    stored !== null &&
    stored.kind === 'oauth' &&
    typeof stored.accessToken === 'string' &&
    typeof stored.refreshToken === 'string' &&
    typeof stored.expiresAt === 'number'
  )
}

/**
 * Builds the real `McpOAuthCredentialResolver` `resolvedConfig()` calls: reads the stored credential
 * for `serverId` (`undefined` when none exists or it is not oauth-shaped - `resolvedConfig()` treats
 * that as "needs re-authorization", not a hard error) and, on `refresh()`, discovers the
 * authorization server and exchanges the stored refresh token for a new access token, persisting the
 * result before returning it.
 */
export function createMcpOAuthCredentialResolver(
  opts: CreateMcpOAuthCredentialResolverOptions,
): McpOAuthCredentialResolver {
  const fetchImpl = withTimeout(opts.fetchImpl, opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)

  return async (serverId, signal, serverUrl, staticClientId) => {
    if (signal.aborted) throw new DOMException('operation aborted', 'AbortError')
    const ref = credentialRefFor(serverId)
    const stored = await opts.credentialStore.read(ref)
    if (!isStoredOAuthCredential(stored)) return undefined

    const provider = stored.provider ?? 'mcp-oauth'
    const grantId = stored.grantId ?? serverId
    const refreshToken = stored.refreshToken
    const credential: McpOAuthCredential = {
      provider,
      accessToken: stored.accessToken,
      refreshToken,
      expiresAt: stored.expiresAt,
      scope: stored.scope ?? [],
      grantId,
    }

    return {
      credential,
      async refresh(): Promise<McpOAuthCredential> {
        if (signal.aborted) throw new DOMException('operation aborted', 'AbortError')
        // The SDK's refreshAuthorization() requires `clientInformation` (its options type has no
        // `?` on that field, unlike exchangeAuthorization's) and this resolver only ever knows a
        // client_id when the definition supplied a staticClientId (McpOAuthSecretBinding).
        // KNOWN, DELIBERATE GAP (see this task's report): a DCR-registered client's client_id lives
        // only in oauth-http-handler.ts's in-process `pendingRegistrations` map -- a *different*
        // process (the daemon's HTTP callback handler), discarded once the callback that consumed
        // it returns -- and is never persisted anywhere this worker-process resolver can reach.
        // Fabricating a client_id (empty string, the serverId, ...) would be actively wrong, not a
        // safe default, so this fails fast and explicitly instead: resolvedConfig()'s existing
        // optimistic-retry-then-needs-reconnect path treats this exactly like any other refresh
        // failure, surfacing as a real (not silent) "needs re-authorization" outcome.
        if (!staticClientId)
          throw new Error(
            `oauth refresh for server "${serverId}" has no client_id available in this worker process ` +
              '(DCR-registered client_id is not persisted for refresh -- see mcp-oauth-credentials.ts)',
          )
        const authorizationServerUrl = await resolveAuthorizationServerUrl(serverUrl, fetchImpl)
        const metadata = await tryDiscoverAuthorizationServerMetadata(authorizationServerUrl, fetchImpl)
        const tokens = await refreshAuthorization(authorizationServerUrl, {
          ...(metadata ? { metadata } : {}),
          clientInformation: { client_id: staticClientId },
          refreshToken,
          fetchFn: fetchImpl,
        })
        // Same hard requirement as oauth-http-handler.ts's handleCallback (design §3.5):
        // credential-store.ts's isOAuthInput requires both refreshToken and expiresAt, and that
        // validation is explicitly out of scope to change. A response missing either cannot be
        // persisted - treated as a refresh failure, not silently degraded or dropped.
        if (!tokens.refresh_token || tokens.expires_in === undefined)
          throw new Error(
            `oauth refresh response for server "${serverId}" omitted refresh_token or expires_in`,
          )
        const refreshed: McpOAuthCredential = {
          provider,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: Date.now() + tokens.expires_in * 1000,
          scope: tokens.scope
            ? tokens.scope.split(/\s+/).filter((value) => value.length > 0)
            : credential.scope,
          grantId,
        }
        await opts.credentialStore.putOAuth(ref, refreshed)
        return refreshed
      },
    }
  }
}
