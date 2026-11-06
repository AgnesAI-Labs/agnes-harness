import { randomBytes, randomUUID } from 'node:crypto'
import {
  createOAuthHttpHandler,
  type McpOAuthCompleteParams,
  type McpOAuthSummary,
  type OAuthHttpServerInfo,
} from '@agnes/resource-control-runtime'
import { createClient, memoryJournal } from '@agnes/sdk'
import { localPipeFactories } from '../src/boot/pipe-factory.js'
import type { LocalBackend } from './backend.js'

/** Browser redirects and PKCE belong to the launch origin; the code exchange and the credential
 * write happen in the daemon, so a static client secret never reaches this process. */
export function localOAuthAdmin(backend: LocalBackend, baseUrl: URL) {
  if (!backend.web) throw new Error('local Web credential is unavailable')
  const clientId = `oauth-admin-web-${backend.scope.scopeID}`
  const open = () =>
    createClient({
      transport: { kind: 'unix', path: backend.socketPath },
      transportFactories:
        backend.link?.transportFactories() ?? localPipeFactories(backend.socketPath, backend.scope),
      auth: { kind: 'local' },
      journal: memoryJournal(clientId),
    })
  const client = backend.link ? backend.link.client(open) : open()
  let ready: Promise<unknown> | undefined
  const initialize = () =>
    (ready ??= client.initialize().catch((error: unknown) => {
      ready = undefined
      throw error
    }))

  const resolveServer = async (serverId: string): Promise<OAuthHttpServerInfo | undefined> => {
    await initialize()
    let descriptor: Awaited<ReturnType<typeof client.mcp.servers.get>>
    try {
      descriptor = await client.mcp.servers.get({ profile: backend.scope.profile, serverId })
    } catch {
      // Unknown serverId, an unreachable daemon, or a policy refusal are all "cannot start an
      // authorization flow for this id" from this handler's point of view - never a 5xx that
      // implies the browser's own request was malformed.
      return undefined
    }
    const transport = descriptor.definition.transport
    const secretBinding = descriptor.definition.secretBinding
    if (transport.kind === 'stdio' || secretBinding.kind !== 'oauth') return undefined
    return {
      serverUrl: new URL(transport.url),
      ...(secretBinding.staticClientId ? { staticClientId: secretBinding.staticClientId } : {}),
    }
  }

  const profile = backend.scope.profile
  const login = {
    async get(serverId: string): Promise<McpOAuthSummary> {
      await initialize()
      return client.request('_agnes/v1/admin.mcp.oauth.get', { profile, serverId })
    },
    async complete(params: McpOAuthCompleteParams): Promise<void> {
      await initialize()
      await client.request('_agnes/v1/admin.mcp.oauth.complete', {
        ...params,
        profile,
        client: { ...params.client },
        requestedScope: [...params.requestedScope],
      })
    },
  }
  // Signs/verifies this process's own `state` round trip only (see oauth-state.ts and
  // oauth-http-handler.ts's own doc comments on why nonce/registration bookkeeping is already
  // scoped to one process's lifetime) - a fresh random secret per `agnes serve` launch is
  // therefore strictly safe, not merely convenient: restarting `agnes serve` already invalidates
  // any in-flight flow's nonce/PKCE bookkeeping (in-memory, lost on restart regardless), so also
  // invalidating its state signature on the same restart adds no new failure mode.
  const secret = randomBytes(32).toString('base64url')

  // Best-effort bookkeeping only: oauth-http-handler.ts's `markStatus` already swallows whatever
  // this throws (an unreachable/restarting daemon must never turn an otherwise-successful, or
  // otherwise-already-failed, token exchange into a second, misleading kind of failure for the
  // browser sitting on the other end of the callback redirect) - no try/catch duplicated here.
  const onAuthorizationStatus = async (
    serverId: string,
    status: 'authorized' | 'needs-reconnect' | 'error',
  ) => {
    await initialize()
    await client.mcp.servers.oauth.statusSet({ profile, serverId, status })
    // A new sign-in takes effect without waiting for the next connection: reconnect the server.
    if (status === 'authorized') {
      const descriptor = await client.mcp.servers.get({ profile, serverId })
      await client.mcp.servers.reconnect({
        profile,
        serverId,
        expectedRevision: descriptor.revision,
        clientId: await client.clientId(),
        commandId: `mcp-oauth-reconnect-${randomUUID()}`,
      })
    }
  }

  const handle = createOAuthHttpHandler({
    secret,
    login,
    baseUrl,
    resolveServer,
    onAuthorizationStatus,
  })

  return {
    handle,
    startAuthorization: handle.startAuthorization,
    async close(): Promise<void> {
      await client.close()
    },
  }
}
