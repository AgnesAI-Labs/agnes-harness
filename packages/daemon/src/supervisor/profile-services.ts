import type { PackageProfileDirectory } from '@agnes/daemon-admin/packages/index'
import { BoundWakeService, deliverBoundWake } from '@agnes/daemon-foundation/jobs/bound-wakes'
import type { JobsRepo } from '@agnes/daemon-foundation/jobs/repo'
import type { SessionPrincipalOwnership } from '@agnes/daemon-foundation/storage/session-ownership'
import type { WorkspaceCatalog } from '@agnes/daemon-foundation/storage/workspaces'
import { isRuntimePackageEligible, type PackageManager } from '@agnes/package-manager'
import { rpcError } from '@agnes/protocol'
import type { WorkerRegistry } from './registry.js'
import { workerProfileServices, workerWakeBindings } from './service-worker.js'
import type { WorkerPool } from './worker-pool.js'

/** Current inventory admission and durable original-session notification delivery. */
export function createSupervisorProfileServices(input: {
  runtime: { manager: PackageManager; profileDirectory: PackageProfileDirectory } | undefined
  profile: string
  pool: WorkerPool
  repo: JobsRepo | undefined
  profileHash: string
  clock(): number
  ownership: Pick<SessionPrincipalOwnership, 'resolve'>
  workspaces: Pick<WorkspaceCatalog, 'restoreBinding'>
  registry: WorkerRegistry
}) {
  const profileAuthority = async (identity: { packageId: string; integrity: string }) => {
    if (!input.runtime) throw rpcError('CAPABILITY_DENIED')
    const directory = await input.runtime.profileDirectory(input.profile)
    const inventory = await input.runtime.manager.inventory(directory, { fresh: true })
    const pkg = inventory.packages.find((row) => row.id === identity.packageId)
    if (!pkg || !isRuntimePackageEligible(pkg) || pkg.entry.integrity !== identity.integrity)
      throw rpcError('CAPABILITY_DENIED')
  }
  const wakeBindings = workerWakeBindings(input.pool, profileAuthority)
  const boundWakes = input.repo
    ? new BoundWakeService({
        repo: input.repo,
        profileHash: input.profileHash,
        clock: input.clock,
        resolve: wakeBindings.resolve,
      })
    : undefined
  const boundWake = (job: Parameters<typeof deliverBoundWake>[0], signal: AbortSignal) =>
    deliverBoundWake(job, signal, {
      requireTarget: wakeBindings.require,
      deliver: async (target, commandId, event, deliverySignal) => {
        if (!input.ownership.resolve(target.sessionId)) throw rpcError('CAPABILITY_DENIED')
        const binding = await input.workspaces.restoreBinding(target.sessionId)
        await wakeBindings.require(target.bindingId)
        const entry = await input.registry.open({
          key: target.sessionId,
          cwd: binding.canonicalRoot,
          binding,
          resume: true,
        })
        deliverySignal.throwIfAborted()
        await wakeBindings.require(target.bindingId)
        const seq = await entry.session.deliverSystemInput({
          commandId,
          laneId: target.laneId,
          generationId: target.generationId,
          targetActorId: target.actorId,
          ...(target.actorOrg !== undefined ? { targetActorOrg: target.actorOrg } : {}),
          actor: {
            id: target.producerOwner,
            org: 'local',
            role: 'extension',
            deptPath: [],
            attrs: {},
          },
          system: {
            source: target.producerOwner,
            type: event.name,
            data: event.data ?? null,
            summary: event.summary,
          },
        })
        if (!entry.inflight) await entry.session.run({ until: 'turn-end', signal: deliverySignal })
        return seq
      },
    })
  return { services: workerProfileServices(input.pool, profileAuthority), boundWakes, boundWake }
}
