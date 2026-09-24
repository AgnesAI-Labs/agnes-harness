import { randomBytes } from 'node:crypto'
import { createCredentialStore } from '@agnes/host'
import { createOAuthHttpHandler, type OAuthHttpServerInfo } from '@agnes/resource-control-runtime'
import { createClient, memoryJournal } from '@agnes/sdk'
import { localPipeFactories } from '../src/boot/pipe-factory.js'
import type { LocalBackend } from './backend.js'

/**
 * Wires Task 4's `createOAuthHttpHandler` (packages/resource-control-runtime/src/oauth-http-handler.ts)
 * into this launcher process, the same way `localPackageAdmin`/`localResourceAdmin` wire their own
 * BFFs: a private Unix-socket SDK client is the sole authority for reading the daemon's managed MCP
 * server definitions (`_agnes/v1/mcp.servers.get`, already existing - not a new RPC method), never
 * exposed to the browser.
 *
 * `credentialStore` is the one exception to "everything durable lives only in the daemon process" -
 * `@agnes/host`'s `createCredentialStore` is a plain, atomic-per-file store (rename+fsync, no
 * in-memory journal to race against another process's own in-memory copy - see
 * packages/host/src/adapters/credential-files.ts), so constructing a second instance here, pointed
 * at the exact same `root` the daemon's own Host process uses (`backend.scope.home` -
 * `DaemonScope.home` is the identical anchor `createConfigurationService`/`createCredentialStore`
 * already use daemon-side, per packages/host/src/configuration.ts), is safe: writes to one
 * `secret://...` ref never collide with a concurrent write to a different ref, and this handler is
 * the only writer for any given MCP server's OAuth credential ref in practice (one browser-driven
 * callback per authorization attempt).
 *
 * `onAuthorizationStatus` (persisting `McpServerDescriptor.authorizationStatus`, the daemon's
 * single-writer `resource-control-store` journal) is wired here to `client.mcp.servers.oauth.
 * statusSet` - the daemon-local RPC method the mcp-oauth-authorization plan's Task 5 added for
 * exactly this purpose, reached over the same private Unix-socket `client` this file already uses
 * for `resolveServer`'s `mcp.servers.get` reads. Task 4 deliberately left this hook unconnected
 * because that RPC method did not exist yet (see oauth-http-handler.ts's module header and the
 * Task 4 report); this is that gap being closed, not a new design.
 */
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

  const credentialStore = createCredentialStore({ root: backend.scope.home })
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
