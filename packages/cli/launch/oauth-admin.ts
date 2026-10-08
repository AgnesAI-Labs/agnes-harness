import { randomBytes } from 'node:crypto'
import { createOAuthHttpHandler, type OAuthHttpServerInfo } from '@agnes/resource-control-runtime'
import { createClient, memoryJournal } from '@agnes/sdk'
import { localPipeFactories } from '../src/boot/pipe-factory.js'
import type { LocalBackend } from './backend.js'

/** Browser redirects and PKCE belong to the launch origin; credential writes go to the daemon. */
export function localOAuthAdmin(backend: LocalBackend, baseUrl: URL) {
  if (!backend.web) throw new Error('local Web credential is unavailable')
  const clientId = `oauth-admin-web-${backend.scope.scopeID}`
  const client = createClient({
    transport: { kind: 'unix', path: backend.socketPath },
    transportFactories: localPipeFactories(backend.socketPath, backend.scope),
    auth: { kind: 'local' },
    journal: memoryJournal(clientId),
  })
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

  const credentialStore = {
    async putOAuth(ref: string, credential: import('@agnes/resource-control-runtime').OAuthStoredCredential) {
      const prefix = 'secret://mcp-oauth/'
      if (!ref.startsWith(prefix)) throw new Error('OAuth reference is invalid')
      await initialize()
      await client.request('_agnes/v1/admin.mcp.oauth.save', {
        serverId: ref.slice(prefix.length),
        credential: { ...credential, scope: [...credential.scope] },
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
    await client.mcp.servers.oauth.statusSet({ profile: backend.scope.profile, serverId, status })
  }

  const handle = createOAuthHttpHandler({
    secret,
    credentialStore,
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
