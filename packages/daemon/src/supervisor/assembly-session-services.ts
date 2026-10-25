import { openDaemonScheduleDb } from '@agnes/base/schedule'
import { JobsRepo } from '@agnes/daemon-foundation/jobs/repo'
import { Scheduler } from '@agnes/daemon-foundation/jobs/scheduler'
import { JobsService } from '@agnes/daemon-foundation/jobs/service'
import { type ReclaimRecord, type ResumeReport, reclaimExpired } from '@agnes/daemon-foundation/lease/reclaim'
import { sessionSelectionProvider } from '@agnes/daemon-rpc/local/methods/session-selection'
import { sessionsDbPath } from '@agnes/host'
import type { DispatchState } from './assembly-client-dispatch.js'
import type { AssemblyLifetime } from './assembly-lifetime.js'
import type { AssemblyBase } from './assembly-options.js'
import type { RuntimeState } from './assembly-runtime.js'
import type { StoresState } from './assembly-stores.js'
import { createWorkerRequests } from './assembly-worker-requests.js'
import type { WorkersState } from './assembly-workers.js'
import { startChildMaintenance } from './child-maintenance.js'
import { configurationApplication } from './configuration.js'
import { readModelSelectionCatalog, sharedSessionCatalog } from './model-adapter-lookup.js'
import { createSupervisorProfileServices } from './profile-services.js'
import { type ScheduleCatalog, scheduledTasks } from './schedule-sessions.js'
import { keepSharedWorker } from './shared-keeper.js'
import { startSkillWatcher } from './skill-watcher.js'
import { persistResolvedProfile } from './storage-adapters.js'

export async function openSessionServices(
  state: AssemblyBase & StoresState & WorkersState & DispatchState & RuntimeState,
  lifetime: AssemblyLifetime,
) {
  const {
    o,
    clock,
    lock,
    jobTables,

    sessionOwnership,
    workspaceCatalog,
    resourceWorkerRoot,
    localResourceStore,
    resourceControl,
    activationBarrier,
    notices,

    runtimeStore,
    automationEvents,
    workerRequests,
    pool,
    registry,
    supervisorRegistry,
    hostFacade,
    host,
    effectivePackageAdmin,
  } = state
  const profileApplication = o.configuration
    ? await configurationApplication({
        service: o.configuration,
        profile: o.profile,
        ...(o.reloadProfile ? { reloadProfile: o.reloadProfile } : {}),
        activate: async (next) => {
          // A starting worker must keep reading its original immutable profile artifact.
          const profileFile = `${o.profileFile}.${next.hash}.json`
          await persistResolvedProfile(profileFile, next)
          await pool.applyModelProfile({ profile: next, profileFile })
          hostFacade.update(next)
        },
      })
    : undefined
  if (profileApplication) hostFacade.observeRestartPending(profileApplication.restartPending)
  const modelCatalog = readModelSelectionCatalog({
    worker: () => pool.businessWorker()?.link,
    profile: () => host.profile,
    profileDir: o.profileDir,
    sources: () => o.packageRuntime?.manager.runtimePluginSnapshots(o.profileDir) ?? Promise.resolve([]),
  })
  const sessionSelection = sessionSelectionProvider(
    o.configuration,
    () => sharedSessionCatalog(pool),
    modelCatalog,
  )
  const jobsRepo = jobTables ? new JobsRepo(jobTables.table('jobs'), clock) : undefined
  const schedules =
    jobTables && jobsRepo
      ? scheduledTasks({
          db: openDaemonScheduleDb(jobTables.table('schedules')),
          jobs: jobsRepo.scheduleJobs(),
          clock,
          socketPath: o.config.socketPath,
          serverIdentity: lock.owner,
          sources: {
            workspaces: async () => (await workspaceCatalog.list()).items,
            normalize: async (path) => (await workspaceCatalog.validate(path)).path,
            catalog: async () =>
              (await (
                await pool.acquireSharedWorker()
              ).command('session.catalog', {}, { timeoutMs: 31_000 })) as ScheduleCatalog,
            presets: () => host.profile.presets.allowed,
          },
        })
      : undefined
  automationEvents.schedules = schedules
  if (schedules) lifetime.own({ dispose: () => schedules.close() })
  const profilePorts = createSupervisorProfileServices({
    runtime: o.packageRuntime,
    profile: o.profile.name,
    pool,
    repo: jobsRepo,
    profileHash: host.profile.hash,
    clock,
    ownership: sessionOwnership,
    workspaces: workspaceCatalog,
    registry,
  })
  const boundWakes = profilePorts.boundWakes
  const scheduler = jobsRepo
    ? new Scheduler({
        repo: jobsRepo,
        boundWake: profilePorts.boundWake,
        registry: supervisorRegistry,
        notices,
        clock,
        owner: `agnesd-${lock.owner.processStartId}`,
        limits: {
          tickMs: o.config.limits.jobsTickMs,
          lockMs: o.config.limits.jobsLockMs,
          maxStalled: o.config.limits.jobsMaxStalled,
        },
        workspaces: workspaceCatalog,
        ownership: sessionOwnership,
        activationBarrier,
        ...(schedules ? schedules.hooks : {}),
      })
    : undefined
  if (scheduler)
    lifetime.own({
      stop: () => {
        scheduler.stopIntake()
        scheduler.abortActive()
      },
      drain: () => scheduler.stop(),
      dispose: () => undefined,
    })
  const jobs =
    jobsRepo && scheduler
      ? new JobsService({
          repo: jobsRepo,
          get profileHash() {
            return host.profile.hash
          },
          clock,
          onCancel: (jobId) => scheduler.abort(jobId),
        })
      : undefined
  const selectedJobs = o.ports?.jobs ?? jobs

  workerRequests.initialize(createWorkerRequests({ ...state, profilePorts, schedules }, lifetime.phase()))
  // The listener is live before restart recovery can acquire a resource-only worker.
  if (localResourceStore) await resourceControl.service.recover()
  if (localResourceStore) {
    const watcher = await startSkillWatcher({
      service: resourceControl.service,
      profile: o.profile.name,
      catalog: workspaceCatalog,
      ...(effectivePackageAdmin ? { packages: effectivePackageAdmin.service } : {}),
      ...(o.workspaceRoot ? { defaultWorkspaceRoot: resourceWorkerRoot } : {}),
      log: console,
    })
    const stop = runtimeStore?.onDesired(() => watcher.changed({ rootKey: 'package' }))
    lifetime.own({
      stop: async () => {
        stop?.()
        await watcher.close()
      },
      dispose: () => undefined,
    })
  }
  // The shared worker is up from here on rather than from the first session.
  const keeper = keepSharedWorker({
    acquire: () => pool.acquireSharedWorker(),
    onRetry: (listener) => pool.onBootRetry(listener),
    log: console,
  })
  lifetime.own({ stop: () => keeper.close(), dispose: () => undefined })

  const { reclaimNow } = await openReclaimer(state, scheduler, lifetime)
  const childMaintenance = startChildMaintenance({ dbPath: sessionsDbPath(o.config.dataDir) })
  lifetime.own({ stop: () => childMaintenance.stop(), dispose: () => undefined })

  return {
    profileApplication,
    modelCatalog,
    sessionSelection,
    jobsRepo,
    schedules,
    profilePorts,
    boundWakes,
    scheduler,
    jobs,
    selectedJobs,
    keeper,
    reclaimNow,
    childMaintenance,
  }
}

export type SessionsState = Awaited<ReturnType<typeof openSessionServices>>
export type WorkerRequestServices = {
  profilePorts: ReturnType<typeof createSupervisorProfileServices>
  schedules: ReturnType<typeof scheduledTasks> | undefined
}

async function openReclaimer(
  state: AssemblyBase & StoresState & WorkersState,
  scheduler: Scheduler | undefined,
  lifetime: AssemblyLifetime,
) {
  const { clock, reclaimStore, sessionOwnership, workspaceCatalog, supervisorRegistry, notices } = state
  let reclaimIntake = true
  const reclaimAbort = new AbortController()
  let reclaiming = Promise.resolve<ReclaimRecord[]>([])
  const reclaim = async (): Promise<ReclaimRecord[]> => {
    if (!reclaimStore) return []
    const records = await reclaimExpired({
      store: reclaimStore,
      now: clock(),
      openForResume: async (sessionKey, runId) => {
        if (!sessionOwnership.resolve(sessionKey))
          throw new Error(`session owner unavailable for ${sessionKey}`)
        const binding = await workspaceCatalog.restoreBinding(sessionKey)
        const opening = supervisorRegistry.openIfAbsent(
          { key: sessionKey, cwd: binding.canonicalRoot, binding, resume: true },
          runId,
        )
        if (!opening) return null
        const entry = await opening
        return { session: { resume: () => entry.session.resume() as Promise<ResumeReport> } }
      },
      notices,
      signal: reclaimAbort.signal,
    })
    for (const record of records) {
      if (!reclaimIntake) break
      if (record.resumed) scheduler?.recordResume(record.sessionKey)
    }
    return records
  }
  lifetime.own({
    stop: () => {
      reclaimIntake = false
      reclaimAbort.abort(new Error('daemon shutdown'))
    },
    drain: async () => {
      await reclaiming
    },
    dispose: () => undefined,
  })
  const reclaimNow = (): Promise<ReclaimRecord[]> => {
    const admitted = (): Promise<ReclaimRecord[]> => (reclaimIntake ? reclaim() : Promise.resolve([]))
    const requested = reclaiming.then(admitted, admitted)
    // Keep the serialization tail fulfilled after a failed manual/periodic pass while returning
    // the original rejection to its caller. A later doctor/manual pass must still be able to run.
    reclaiming = requested.catch(() => [])
    return requested
  }
  if (reclaimStore) await reclaimNow()
  const reclaimTimer = reclaimStore
    ? setInterval(() => {
        void reclaimNow().catch(() => undefined)
      }, 30_000)
    : undefined
  reclaimTimer?.unref()
  if (reclaimTimer) lifetime.own({ stop: () => clearInterval(reclaimTimer), dispose: () => undefined })

  return { reclaimNow }
}
