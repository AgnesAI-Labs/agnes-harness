import type { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import type { LocalContext } from '@agnes/daemon-rpc/local/methods/acp'
import { type AgnesContext, requireSessionOwner } from '@agnes/daemon-rpc/local/methods/agnes'
import { registerSessionWorkspaceReveal } from '@agnes/daemon-rpc/local/methods/session-workspace-reveal'
import { registerWorkerSessionReads } from './session-reads.js'
import type { WorkerPool } from './worker-pool.js'

/** Bind session utilities to the same owner and server-established transport policy. */
export function registerSessionMethods(
  endpoint: LocalEndpoint,
  pool: Pick<WorkerPool, 'acquireSharedWorker'>,
  context: Pick<AgnesContext, 'registry' | 'sessionOwnership' | 'workspaces'> & Pick<LocalContext, 'auth'>,
): void {
  const owner = requireSessionOwner(context)
  registerWorkerSessionReads(endpoint, pool, owner)
  registerSessionWorkspaceReveal(endpoint, context.workspaces, owner, {
    local: context.auth.config.transport === 'unix' || context.auth.config.localWeb === true,
  })
}
