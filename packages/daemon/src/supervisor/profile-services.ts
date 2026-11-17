import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PackageProfileDirectory } from '@agnes/daemon-admin/packages/index'
import { BoundWakeService, deliverBoundWake } from '@agnes/daemon-foundation/jobs/bound-wakes'
import type { JobsRepo } from '@agnes/daemon-foundation/jobs/repo'
import type { SessionPrincipalOwnership } from '@agnes/daemon-foundation/storage/session-ownership'
import type { WorkspaceCatalog } from '@agnes/daemon-foundation/storage/workspaces'
import type { ManagedSessions } from '@agnes/extension-api'
import { pluginRowSource } from '@agnes/host'
import {
  isRuntimePackageEligible,
  type PackageManager,
  parseAgnesPluginEntries,
} from '@agnes/package-manager'
import { rpcError } from '@agnes/protocol'
import type { HostInputResolution } from './managed-input-admission.js'
import { parseResolution } from './managed-input-resolution.js'
import type { ManagedSessionCaller } from './managed-sessions.js'
import type { WorkerRegistry } from './registry.js'
import { workerProfileServices, workerWakeBindings } from './service-worker.js'
import type { WorkerPool } from './worker-pool.js'

/** The session key the worker's profile-scope producers send under (worker-runtime profile-*-producer.ts). */
const PROFILE_LANE = '@profile'

const MANAGED_SESSION_ACTIONS = new Set<string>([
  'start',
  'send',
  'list',
  'status',
  'events',
  'result',
  'usage',
  'toolResult',
  'interrupt',
  'archive',
  'admitInput',
  'inputResult',
])

export async function packageRowOwners(packageId: string, directory: string): Promise<Set<string>> {
  try {
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as {
      agnes?: { plugins?: unknown }
    }
    return new Set(
      parseAgnesPluginEntries(packageId, manifest.agnes?.plugins).map((e) => pluginRowSource(e.id)),
    )
  } catch {
    return new Set()
  }
}

/** An installed package by name, whether it declares a profile managed service with `sessions`, and its plugin rows. */
export interface ManagedSessionPackage {
  readonly packageId: string
  readonly sessions: boolean
  readonly owners: ReadonlySet<string>
}

/**
 * Every installed package of the profile, enabled or not, with the row owners that key its records
 * and workspace grants. Which row runs the managed service is decided at registration, so a grant
 * covers every row of the package; `managedSessionAuthority` accepts any of them.
 */
export async function managedSessionPackages(runtime: {
  manager: PackageManager
  directory: Parameters<PackageManager['inventory']>[0]
}): Promise<ManagedSessionPackage[]> {
  const inventory = await runtime.manager.inventory(runtime.directory, { fresh: true })
  return Promise.all(
    inventory.packages.map(async (pkg) => ({
      packageId: pkg.id,
      sessions:
        pkg.entry.declaredCapabilities?.managedServices?.some(
          (d) => d.scope === 'profile' && d.sessions === true,
        ) === true,
      owners: pkg.directory ? await packageRowOwners(pkg.id, pkg.directory) : new Set<string>(),
    })),
  )
}

/** Rechecks the registered channel row before forwarding an interaction to its session owner. */
function createChannelInteractionAdmission(
  input: {
    runtime: { manager: PackageManager; profileDirectory: PackageProfileDirectory } | undefined
    profile: string
  },
  profileAuthority: (identity: { packageId: string; integrity: string }) => Promise<void>,
) {
  const channelInteractions: {
    submit?: (kind: 'surface' | 'approval', params: unknown, credential: unknown) => Promise<unknown>
  } = {}
  const channelInteraction = async (
    lane: { sharedWorker: boolean; sessionKey: string },
    inputValue: unknown,
  ) => {
    if (
      !lane.sharedWorker ||
      lane.sessionKey !== PROFILE_LANE ||
      !input.runtime ||
      !channelInteractions.submit
    )
      throw rpcError('CAPABILITY_DENIED')
    const p = inputValue as {
      caller?: { owner?: string; packageId?: string; integrity?: string; provider?: string }
      kind?: string
      params?: unknown
      credential?: unknown
    }
    const caller = p?.caller
    if (
      !caller ||
      typeof caller.packageId !== 'string' ||
      typeof caller.integrity !== 'string' ||
      typeof caller.owner !== 'string' ||
      typeof caller.provider !== 'string' ||
      (p.kind !== 'surface' && p.kind !== 'approval')
    )
      throw rpcError('CAPABILITY_DENIED')
    await profileAuthority({ packageId: caller.packageId, integrity: caller.integrity })
    const directory = await input.runtime.profileDirectory(input.profile)
    const inventory = await input.runtime.manager.inventory(directory, { fresh: true })
    const pkg = inventory.packages.find((row) => row.id === caller.packageId)
    if (
      !pkg?.directory ||
      !(await packageRowOwners(pkg.id, pkg.directory)).has(caller.owner) ||
      !pkg.entry.declaredCapabilities?.managedServices?.some(
        (d) => d.id === 'channel' && d.scope === 'profile',
      )
    )
      throw rpcError('CAPABILITY_DENIED')
    const credential = p.credential as { kind?: string; channel?: string; userId?: string }
    if (credential?.kind !== 'channel' || credential.channel !== caller.provider || !credential.userId)
      throw rpcError('CAPABILITY_DENIED')
    return channelInteractions.submit(p.kind, p.params, p.credential)
  }
  return { channelInteractions, channelInteraction }
}

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
  /** Fresh inventory on every call: a disabled, untrusted or changed row, or an undeclared service, is refused. */
  const managedSessionAuthority = async (caller: ManagedSessionCaller) => {
    if (!input.runtime) throw rpcError('CAPABILITY_DENIED')
    const directory = await input.runtime.profileDirectory(input.profile)
    const inventory = await input.runtime.manager.inventory(directory, { fresh: true })
    const pkg = inventory.packages.find((row) => row.id === caller.packageId)
    if (
      !pkg ||
      !isRuntimePackageEligible(pkg) ||
      pkg.entry.integrity !== caller.integrity ||
      !pkg.entry.declaredCapabilities?.managedServices?.some(
        (d) => d.id === caller.service && d.scope === 'profile' && d.sessions === true,
      )
    )
      throw rpcError('CAPABILITY_DENIED')
    // The owner keys records and workspace grants, so it must be one of this package's own plugin rows,
    // and of no other installed package's: row ids are author-chosen, so two packages can share one.
    if (!pkg.directory || !(await packageRowOwners(pkg.id, pkg.directory)).has(caller.owner))
      throw rpcError('CAPABILITY_DENIED')
    const packages = await managedSessionPackages({ manager: input.runtime.manager, directory })
    if (packages.some((row) => row.packageId !== pkg.id && row.owners.has(caller.owner)))
      throw rpcError('CAPABILITY_DENIED', { reason: 'PLUGIN_ROW_AMBIGUOUS' })
  }
  const { channelInteractions, channelInteraction } = createChannelInteractionAdmission(
    input,
    profileAuthority,
  )
  const managedSessions: {
    port?: (
      caller: ManagedSessionCaller,
      host?: { readonly resolution?: HostInputResolution | undefined },
    ) => ManagedSessions
    skillInstallsOff?: (sessionId: string) => boolean
  } = {}
  /**
   * The managed-service host runs in the shared session worker and sends on the `@profile` lane. The
   * lane is not authentication: the caller row is the worker's word, rechecked against inventory.
   */
  const ownedSession = async (lane: { sharedWorker: boolean; sessionKey: string }, params: unknown) => {
    if (!lane.sharedWorker || lane.sessionKey !== PROFILE_LANE)
      throw rpcError('CAPABILITY_DENIED', { reason: 'MANAGED_SESSION_LANE' })
    const p = params as Partial<ManagedSessionCaller> & {
      action?: unknown
      args?: unknown
      resolution?: unknown
    }
    const port = managedSessions.port
    if (
      !port ||
      typeof p.owner !== 'string' ||
      typeof p.packageId !== 'string' ||
      typeof p.integrity !== 'string' ||
      typeof p.service !== 'string' ||
      typeof p.action !== 'string' ||
      !MANAGED_SESSION_ACTIONS.has(p.action) ||
      !Array.isArray(p.args)
    )
      throw rpcError('CAPABILITY_DENIED')
    const caller = { owner: p.owner, packageId: p.packageId, integrity: p.integrity, service: p.service }
    // The Host's receipt resolution rides beside `args`, and only an admission reads it.
    const sessions =
      p.action === 'admitInput' ? port(caller, { resolution: parseResolution(p.resolution) }) : port(caller)
    return (sessions[p.action as keyof ManagedSessions] as (...args: unknown[]) => Promise<unknown>)(
      ...p.args,
    )
  }
  const internalProducers = new WeakMap<object, { owner: string; integrity: string }>()
  const boundWakes = input.repo
    ? new BoundWakeService({
        repo: input.repo,
        profileHash: input.profileHash,
        clock: input.clock,
        resolve: async (bindingId, credential) => {
          const producer =
            credential && typeof credential === 'object' ? internalProducers.get(credential) : undefined
          if (!producer) return wakeBindings.resolve(bindingId, credential)
          const binding = await wakeBindings.read(bindingId)
          if (binding.producerOwner !== producer.owner || binding.producerIntegrity !== producer.integrity)
            throw rpcError('CAPABILITY_DENIED')
          let active = true
          try {
            await wakeBindings.require(bindingId)
          } catch (error) {
            if ((error as { data?: { code?: string } })?.data?.code !== 'CAPABILITY_DENIED') throw error
            active = false
          }
          return { binding, active }
        },
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
  const ownedWake = async (params: unknown) => {
    const p = params as {
      owner?: string
      integrity?: string
      action?: string
      input?: import('@agnes/protocol').BoundWakeEnqueueParams
      wakeId?: string
    }
    if (!boundWakes || typeof p.owner !== 'string' || typeof p.integrity !== 'string')
      throw rpcError('CAPABILITY_DENIED')
    const credential = {}
    internalProducers.set(credential, { owner: p.owner, integrity: p.integrity })
    try {
      if (p.action === 'enqueue' && p.input) return await boundWakes.enqueue(p.input, credential)
      if (p.action === 'read' && typeof p.wakeId === 'string')
        return await boundWakes.read(p.wakeId, credential)
      throw rpcError('INVALID_PARAMS')
    } finally {
      internalProducers.delete(credential)
    }
  }
  return {
    channelInteractions,
    channelInteraction,
    features: ['services.profile.v1', 'store.owned.v1', ...(boundWakes ? ['jobs.bound-wake.v1'] : [])],
    ownedWake,
    managedSessionAuthority,
    /** Whether a grant key's package is installed, enabled and trusted: held owner inputs wait while it is not. */
    managedSessionEnabled: async (owner: string): Promise<boolean> => {
      if (!input.runtime) return false
      const packageId = owner.slice(0, owner.indexOf('#'))
      const directory = await input.runtime.profileDirectory(input.profile)
      const inventory = await input.runtime.manager.inventory(directory, { fresh: true })
      const pkg = inventory.packages.find((row) => row.id === packageId)
      return pkg !== undefined && isRuntimePackageEligible(pkg)
    },
    managedSessionPackages: async (): Promise<ManagedSessionPackage[]> => {
      if (!input.runtime) throw rpcError('CAPABILITY_DENIED')
      const directory = await input.runtime.profileDirectory(input.profile)
      return managedSessionPackages({ manager: input.runtime.manager, directory })
    },
    managedSessions,
    ownedSession,
    services: workerProfileServices(input.pool, profileAuthority),
    boundWakes,
    boundWake,
  }
}
