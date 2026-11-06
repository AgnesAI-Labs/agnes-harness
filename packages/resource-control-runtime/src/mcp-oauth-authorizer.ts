import type { McpServerDefinitionInput } from '@agnes/protocol'
import { deploymentFetch } from '@agnes/system-node/deployment-network'
import { extractWWWAuthenticateParams } from '@modelcontextprotocol/sdk/client/auth.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpCredentialResolver, McpHttpAuthorizer } from './mcp.js'
import {
  type McpOAuthLoginReason,
  McpOAuthNeedsReconnectError,
  OAUTH_REFRESH_LEEWAY_MS,
} from './mcp-oauth-error.js'
import { canonicalUrl, parseScope } from './mcp-oauth-protocol.js'
import { refreshMcpOAuth } from './mcp-oauth-refresh.js'
import type { McpOAuthNext, McpOAuthRead, McpOAuthRecord, McpOAuthStore } from './mcp-oauth-store.js'

type Usable = McpOAuthRecord & Required<Pick<McpOAuthRecord, 'client' | 'server' | 'tokens'>>
/** What one request was sent with: the record revision its token came from, and whether getting it
 * took a refresh. */
type Sent = Readonly<{ rev: number; refreshed: boolean }>

/**
 * Credentials for one OAuth MCP server, looked up for every HTTP request of one connection.
 *
 * Each request reads the stored record, so a token written by any process (a refresh elsewhere, a
 * new sign-in) is used by the next request without reconnecting, and a sign-out stops the very
 * next request. A connection keeps the sign-in it started with: once the record's `epoch` moves
 * (signed out, perhaps signed in again), this connection sends nothing more and a new connection
 * picks up the new sign-in. The token goes only to the address it was granted for.
 *
 * Every refusal is a `McpOAuthNeedsReconnectError`; nothing is sent after one.
 */
export function createMcpOAuthAuthorizer(input: {
  serverId: string
  serverUrl: URL
  staticClient?: Readonly<{ clientId: string; clientSecret?: string }>
  store: McpOAuthStore
  fetchImpl: FetchLike
  now?: () => number
}): McpHttpAuthorizer {
  const { serverId, serverUrl, store } = input
  const now = input.now ?? Date.now
  const sent = new WeakMap<object, Sent>()
  let epoch: number | undefined
  const needsLogin = (reason: McpOAuthLoginReason = 'login-required', cause?: unknown) =>
    new McpOAuthNeedsReconnectError(serverId, reason, cause === undefined ? undefined : { cause })
  const due = (record: Usable) => record.tokens.expiresAt - OAUTH_REFRESH_LEEWAY_MS <= now()

  function usable(record: McpOAuthRead): Usable {
    if (!record || 'legacy' in record) throw needsLogin()
    epoch ??= record.epoch
    if (record.epoch !== epoch || !record.client || !record.server || !record.tokens) throw needsLogin()
    if (canonicalUrl(record.server.endpoint) !== canonicalUrl(serverUrl)) throw needsLogin('endpoint-changed')
    return record as Usable
  }

  async function read(): Promise<Usable> {
    let record: McpOAuthRead
    try {
      record = await store.read(serverId)
    } catch (cause) {
      // A damaged file or a lock that timed out: this request cannot be authorized.
      throw needsLogin('login-required', cause)
    }
    return usable(record)
  }

  async function refreshed(seen: Usable): Promise<Usable> {
    let failure: unknown
    try {
      return usable(
        await refreshMcpOAuth({
          serverId,
          serverUrl,
          seen,
          store,
          fetchImpl: input.fetchImpl,
          now,
          ...(input.staticClient ? { staticClient: input.staticClient } : {}),
        }),
      )
    } catch (error) {
      failure = error
    }
    // Another process may have refreshed or signed in again in the meantime: look once more.
    const again = await read().catch(() => undefined)
    if (again && again.rev !== seen.rev && !due(again)) return again
    throw failure instanceof McpOAuthNeedsReconnectError ? failure : needsLogin('login-required', failure)
  }

  /** Adds the scopes a challenge asks for to `requiredScope`; returns the write failure, if any. */
  async function requireScope(challenge: string | undefined, granted: readonly string[]): Promise<unknown> {
    let missing: string[]
    try {
      missing = parseScope(challenge).filter((scope) => !granted.includes(scope))
    } catch {
      return undefined // Not a scope this record could hold: nothing to keep.
    }
    if (missing.length === 0) return undefined
    try {
      await store.update(serverId, async (current) => {
        if (!current || 'legacy' in current || current.epoch !== epoch) return { value: undefined }
        const requiredScope = [...new Set([...current.requiredScope, ...missing])]
        if (requiredScope.length === current.requiredScope.length) return { value: undefined }
        try {
          parseScope(requiredScope.join(' '))
        } catch {
          return { value: undefined } // Over the limits a record can hold.
        }
        const { version: _version, kind: _kind, rev: _rev, ...kept } = current
        const next: McpOAuthNext = { ...kept, requiredScope }
        return { value: undefined, next }
      })
      return undefined
    } catch (error) {
      return error
    }
  }

  function bearer(record: Usable, refreshedNow: boolean): Readonly<Record<string, string>> {
    const headers = Object.freeze({ authorization: `Bearer ${record.tokens.accessToken}` })
    sent.set(headers, { rev: record.rev, refreshed: refreshedNow })
    return headers
  }

  return Object.freeze({
    async headers(signal?: AbortSignal) {
      if (signal?.aborted) throw new DOMException('operation aborted', 'AbortError')
      const record = await read()
      if (!due(record)) return bearer(record, false)
      // A refreshed token is used as it comes back, even if it is already close to expiry.
      return bearer(await refreshed(record), true)
    },
    async rejected(response: Response, headers: Readonly<Record<string, string>>) {
      const challenge = extractWWWAuthenticateParams(response)
      if (response.status === 403) {
        if (challenge.error !== 'insufficient_scope') return 'fail'
        // A refresh keeps the granted scope, so only a new sign-in can add what is missing.
        throw needsLogin('insufficient-scope', await requireScope(challenge.scope, []))
      }
      if (response.status !== 401) return 'fail'
      const request = sent.get(headers)
      const record = await read()
      // Someone else wrote a new token after this request left: resend with it, no refresh.
      const moved = request !== undefined && record.rev !== request.rev
      // The token came straight from the authorization server for this request and was still refused.
      if (!moved && request?.refreshed) throw needsLogin()
      if (challenge.scope) {
        const failure = await requireScope(challenge.scope, record.tokens.scope)
        if (failure !== undefined) throw needsLogin('login-required', failure)
      }
      if (moved) return 'retry'
      await refreshed(challenge.scope ? await read() : record)
      return 'retry'
    },
  })
}

/**
 * The authorizer a connection to this server needs: one for an OAuth server, none for any other
 * binding. Without a store an OAuth server needs sign-in. A static client's secret is resolved here
 * from its reference, for the refreshes this connection makes.
 */
export async function mcpOAuthAuthorizer(
  definition: McpServerDefinitionInput,
  input: Readonly<{ store: McpOAuthStore | undefined; resolver: McpCredentialResolver; signal: AbortSignal }>,
): Promise<McpHttpAuthorizer | undefined> {
  const binding = definition.secretBinding
  if (binding.kind !== 'oauth' || definition.transport.kind === 'stdio') return undefined
  if (!input.store) throw new McpOAuthNeedsReconnectError(definition.serverId)
  const staticClient = binding.staticClientId
    ? {
        clientId: binding.staticClientId,
        ...(binding.clientSecretRef
          ? { clientSecret: await input.resolver(binding.clientSecretRef, input.signal) }
          : {}),
      }
    : undefined
  return createMcpOAuthAuthorizer({
    serverId: definition.serverId,
    serverUrl: new URL(definition.transport.url),
    store: input.store,
    fetchImpl: deploymentFetch,
    ...(staticClient ? { staticClient } : {}),
  })
}
