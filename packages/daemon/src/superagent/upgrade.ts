import type { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import type { SessionPrincipalOwnership } from '@agnes/daemon-foundation/storage/session-ownership'
import type { RuntimeGenerationSnapshotStore } from '@agnes/package-manager'
import { rpcError } from '@agnes/protocol'
import type { WorkerRegistry } from '../supervisor/registry.js'
import type { WorkerPool } from '../supervisor/worker-pool.js'

/** Private, fixed Superagent capability. Neither a key prefix nor an owner's ordinary SDK client
 * can claim sessions: the current starting service reads its own durable registration roster. */
export function registerSuperagentUpgrade(
  ep: LocalEndpoint,
  transport: 'unix' | 'ws',
  pool: Pick<WorkerPool, 'acquireSharedWorker'>,
  registry: Pick<WorkerRegistry, 'upgradeIdleSessions'>,
  ownership: Pick<SessionPrincipalOwnership, 'resolve'>,
  generations: Pick<RuntimeGenerationSnapshotStore, 'session' | 'read'>,
): void {
  ep.register('_agnes/v1/superagent.sessions.upgrade', async (params, call) => {
    if (
      transport !== 'unix' ||
      call.conn.authKind !== 'local' ||
      call.conn.credentialKind !== 'local' ||
      call.conn.bundledApp !== true ||
      call.conn.clientId !== 'bundled-app:@agnes/superagent/superagent'
    )
      throw rpcError('CAPABILITY_DENIED')
    const identity = params as { integrity: string; incarnation: string }
    const worker = await pool.acquireSharedWorker()
    const roster = async (): Promise<string[]> => {
      const ids = await worker.command('profileManaged.superagentUpgradeSessions', identity)
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && id.length > 0))
        throw rpcError('CAPABILITY_DENIED')
      return [...new Set(ids as string[])].sort()
    }
    const sessionIds = await roster()
    // An ordinary restart must not close current sessions or subject their resumable work to migration.
    // Missing pins are left to normal session creation; corrupt records still fail closed.
    const stale = sessionIds.filter((key) => {
      const pin = generations.session(key)
      return (
        pin &&
        !generations
          .read(pin.generationId)
          .sources.some(
            ({ snapshot }) =>
              snapshot.packageId === '@agnes/superagent' && snapshot.integrity === identity.integrity,
          )
      )
    })
    if (!stale.length) return { sessionIds: [] }
    const current = async () => {
      if (JSON.stringify(await roster()) !== JSON.stringify(sessionIds)) throw rpcError('CAPABILITY_DENIED')
    }
    return registry.upgradeIdleSessions(stale, call.conn.principalId, ownership, async () => {
      for (const sessionId of stale) {
        await current()
        // No timeout: an unresolved worker command may still be writing its durable pin.
        await worker.command('pluginGenerations.migrate', {
          sessionId,
          operator: call.conn.principalId,
          superagentIntegrity: identity.integrity,
        })
      }
      await current()
      return { sessionIds: stale }
    })
  })
}
