import { join } from 'node:path'
import type { ReclaimRecord } from '@agnes/daemon-foundation/lease/reclaim'
import type { DirectoryPort } from '@agnes/daemon-foundation/local/ports'
import {
  compositionPreset,
  compositionSurfaceAllowed,
  createPlatform,
  createSqliteStorage,
  defaultProcessIdentity,
  type ExtensionActivationBarrier,
  initializeHome,
  initializeHomeLocked,
  type ResolvedProfile,
  resolveComposition,
} from '@agnes/host'
import { acquireObservability, installDiagnosticJournal } from '@agnes/observability'
import { createClientDispatch } from './assembly-client-dispatch.js'
import { listenClients } from './assembly-client-listener.js'
import { rebuildClientModules } from './assembly-client-modules.js'
import { openClientServices } from './assembly-client-services.js'
import { createEndpoints } from './assembly-endpoints.js'
import { resolveLaunchConfig } from './assembly-launch-config.js'
import { AssemblyLifetime } from './assembly-lifetime.js'
import type { StartSupervisorOptions } from './assembly-options.js'
import { preparePackageRuntime } from './assembly-packages.js'
import { initializeRuntime } from './assembly-runtime.js'
import { secretsDirectory } from './assembly-secrets.js'
import { openSessionServices } from './assembly-session-services.js'
import { openStores } from './assembly-stores.js'
import { listenWorkers } from './assembly-worker-listener.js'
import { openWorkers } from './assembly-workers.js'
import { bestEffort } from './best-effort.js'
import { openBootVerification } from './boot-verification.js'
import type { Args } from './config.js'
import { publishDaemonDiscovery, removeDaemonDiscovery } from './discovery.js'
import { installSignals } from './lifecycle.js'
import { acquireDaemonMutationLock } from './mutation-lock.js'
import { acquireOwnerLock } from './owner-lock.js'
import { createProfileInspection } from './profile-inspection.js'
import { openDaemonLogs } from './runtime-log.js'
import { canonicalPath, daemonProfileLoader, resolveDaemonProfile, resolveDaemonScope } from './scope.js'
import { storageReads } from './session-reads.js'
import { prepareDaemonSocketPaths } from './socket-paths.js'
import { watchWindowsStopRequest } from './stop-request.js'
import { adaptHostTables } from './storage-adapters.js'

export type { StartSupervisorOptions } from './assembly-options.js'
export { supervisorHostFacade } from './host-facade.js'
export { activateForkOwnership, SupervisorRegistry, supervisorLister } from './registry-facade.js'
export { wireResourceSnapshotNotifications } from './resource-snapshot-notifications.js'

export { deliverWorkerEvent } from './worker-events.js'

type SupervisorOwnership = {
  home: string
  lock: Awaited<ReturnType<typeof acquireOwnerLock>>
  storageLocked: boolean
}

export async function startSupervisor(
  o: StartSupervisorOptions,
  ownership?: SupervisorOwnership,
): Promise<{
  failed?: Promise<Error>
  close(): Promise<void>
  reclaimNow(): Promise<ReclaimRecord[]>
  /** Process-internal lifecycle hook used by deterministic idle-recovery verification. */
  evictIdleNow(): number
  /** Process-internal lifecycle hook used by deterministic worker-replacement verification: '@shared'
   *  is kept up from daemon start and so never idle-evicted, but a session must still recover
   *  cleanly when it is replaced (crash, restart) - this forces that without waiting for one. */
  retireSharedWorkerNow(): boolean
  socketPath: string
  owner: import('./owner-record.js').Owner
  /** Privileged Package activation coordination port; never exposed on the client wire. */
  activationBarrier: ExtensionActivationBarrier
  ws?: { url: string; token: string }
}> {
  const workerEntry = o.workerEntry
  if (workerEntry === undefined) throw new Error('supervisor requires a worker executable entry')
  prepareDaemonSocketPaths(o.config)
  if (o.profile.adapters?.secrets?.kind === 'file') secretsDirectory(o.profile, o.config)
  const composition = o.profile.composition
    ? resolveComposition(o.profile, {
        preset: compositionPreset(o.profile, o.profile.presets.default),
      }).selection
    : undefined
  if (composition?.surfaces !== undefined) {
    const { localWeb, ws, ...config } = o.config
    o = {
      ...o,
      config: {
        ...config,
        ...(localWeb && compositionSurfaceAllowed(composition, 'web') ? { localWeb } : {}),
        ...(ws && compositionSurfaceAllowed(composition, 'http') ? { ws } : {}),
      },
    }
  }
  if (o.config.ws && o.config.localWeb) throw new Error('choose local Web or remote WSS')
  const clock = o.clock ?? (() => Date.now())

  // Single-owner lock first: everything below allocates real resources (sockets, a worker pool), and
  // a second `agnesd` against the same canonical home must fail before any of that exists, not after.
  const ownerHome = await canonicalPath(o.config.home ?? o.config.dataDir)
  if (ownership && ownership.home !== ownerHome) throw new Error('daemon owner scope mismatch')
  const lock =
    ownership?.lock ??
    (await acquireOwnerLock(ownerHome, {
      socketPath: o.config.socketPath,
      processIdentity: o.processIdentity ?? defaultProcessIdentity,
    }))
  const lifetime = new AssemblyLifetime(o.config.limits.shutdownGraceMs)
  if (!ownership) lifetime.own({ dispose: () => lock.release() })
  const base = {
    o,
    workerEntry,
    composition,
    clock,
    ownerHome,
    lock,
    storageLocked: ownership?.storageLocked ?? false,
  }
  try {
    const { ready: stores } = await lifetime.assemble((owner) => openStores(base, owner))
    const { ready: workers } = await lifetime.assemble((owner) => openWorkers({ ...base, ...stores }, owner))
    const { ready: listener } = await lifetime.assemble((owner) =>
      listenWorkers({ ...base, ...workers }, owner),
    )
    const { ready: dispatch } = await lifetime.assemble((owner) =>
      createClientDispatch({ ...base, ...stores, ...workers }, owner),
    )
    const { ready: runtime } = await lifetime.assemble((owner) =>
      initializeRuntime({ ...base, ...stores, ...workers, ...dispatch }, owner),
    )
    const ready = { ...base, ...stores, ...workers, ...listener, ...dispatch, ...runtime }
    await lifetime.assemble((owner) => rebuildClientModules(ready, owner))
    // Nothing after this point shares boot observations; listeners never inherit the boundary.
    await o.bootVerification?.end()
    const { ready: sessions } = await lifetime.assemble((owner) => openSessionServices(ready, owner))
    const { ready: clients } = await lifetime.assemble((owner) =>
      openClientServices({ ...ready, ...sessions }, owner),
    )
    const { ready: endpoints } = await lifetime.assemble((owner) =>
      createEndpoints({ ...ready, ...sessions, ...clients }, owner),
    )
    const { ready: listening } = await lifetime.assemble((owner) =>
      listenClients({ ...ready, ...sessions, ...endpoints }, owner),
    )
    if (listener.failure.error) throw listener.failure.error
    return {
      ...listening.health,
      activationBarrier: stores.activationBarrier,
      socketPath: o.config.socketPath,
      owner: { ...lock.owner },
      ...(listening.wsServer && listening.wsToken
        ? { ws: { url: listening.wsServer.url, token: listening.wsToken } }
        : {}),
      reclaimNow: sessions.reclaimNow,
      evictIdleNow: listening.evictIdleNow,
      retireSharedWorkerNow: listening.retireSharedWorkerNow,
      close: () =>
        lifetime.close(o.config.limits.shutdownGraceMs, () =>
          stores.notices.emit('shutting_down', { detail: {} }),
        ),
    }
  } catch (error) {
    await lifetime.close(o.config.limits.shutdownGraceMs)
    throw error
  }
}

type SupervisorHandle = Awaited<ReturnType<typeof startSupervisor>>

/**
 * Opens the Host-owned storage used by the real supervisor process and gives jobs an isolated
 * package table store. The core ledger database is opened only because `createSqliteStorage` owns
 * the lifetime of both its core adapter and package stores; no raw SQLite handle crosses into
 * daemon.
 *
 * Package tables remain isolated in `tables('@agnes/daemon')`; crash reclaim receives Host's narrow
 * operation-only port, never a raw core SQLite handle.
 */
export async function startProductionSupervisor(
  o: Omit<StartSupervisorOptions, 'jobTables' | 'artifactAuthorityTable'>,
  deps: {
    createStorage?: typeof createSqliteStorage
    start?: typeof startSupervisor
  } = {},
): Promise<SupervisorHandle> {
  const lifetime = new AssemblyLifetime()
  try {
    prepareDaemonSocketPaths(o.config)
    const home = await canonicalPath(o.config.home ?? o.config.dataDir)
    const lock = await acquireOwnerLock(home, {
      socketPath: o.config.socketPath,
      processIdentity: o.processIdentity ?? defaultProcessIdentity,
    })
    lifetime.own({ dispose: () => lock.release() })
    if ((await canonicalPath(o.config.dataDir)) !== home) {
      const guard = acquireDaemonMutationLock(o.config.dataDir)
      lifetime.own({ dispose: () => guard.release() })
    }
    const observability = acquireObservability(o.config.home ?? o.config.dataDir)
    observability.lifecycle('daemon', 'start')
    lifetime.own({
      dispose: async () => {
        observability.lifecycle('daemon', 'stop')
        await observability.dispose()
      },
    })
    const stopDiagnostics = installDiagnosticJournal(o.config.home ?? o.config.dataDir)
    lifetime.own({ dispose: stopDiagnostics })
    const storage = (deps.createStorage ?? createSqliteStorage)({
      file: join(o.config.dataDir, 'sessions.db'),
      tablesDir: join(o.config.dataDir, 'tables'),
      ...(o.clock ? { clock: o.clock } : {}),
    })
    lifetime.own({ dispose: () => storage.close() })
    const supervisor = await (deps.start ?? startSupervisor)(
      {
        ...o,
        observability,
        jobTables: adaptHostTables(storage.tables('@agnes/daemon')),
        artifactAuthorityTable: adaptHostTables(
          storage.tables('@agnes/daemon/artifact-read-authority'),
        ).table('artifact_read_authority'),
        reclaim: storage.crashReclaim,
        ...storageReads(o, storage),
      },
      { home, lock, storageLocked: true },
    )
    lifetime.own({ dispose: () => supervisor.close() })
    return {
      ...supervisor,
      close: () => lifetime.dispose(),
    }
  } catch (error) {
    try {
      await lifetime.dispose()
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'supervisor startup and resource cleanup failed')
    }
    throw error
  }
}

/**
 * `agnesd` startup uses Host's shared profile reader and configuration service, builds the daemon
 * config, starts the supervisor, and wires
 * SIGTERM/SIGINT to a graceful `close()`.
 */
export type RunAgnesdDeps = {
  /** Enterprise directory implementations live outside daemon; the executable composition root
   * can fit one here without replacing the supervisor or weakening its credential gate. */
  directory?: DirectoryPort
  startProduction?: typeof startProductionSupervisor
  secrets?: { resolve(ref: string): string }
  localWeb?: { addr: string; origin: string }
  workerExecPath?: string
  workerExecArgv?: string[]
  workerEntry?: string
  resolveScope?: typeof resolveDaemonScope
  resolveProfile?: typeof resolveDaemonProfile
  publishDiscovery?: typeof publishDaemonDiscovery
  removeDiscovery?: typeof removeDaemonDiscovery
  /** Injection seam for enterprise composition. An unconfigured WSS still has no package grant. */
  packageAdmin?: StartSupervisorOptions['packageAdmin']
  resources?: StartSupervisorOptions['resources']
}

/** `runAgnesd` accepts a partial argument object so embedded launchers can rely on scope defaults. */
export type RunAgnesdArgs = Partial<Args>

export async function runAgnesd(args: RunAgnesdArgs = {}, deps: RunAgnesdDeps = {}): Promise<void> {
  const platform = createPlatform().snapshot()
  // Scope and profile resolution already verify the installed trees; boot shares that pass.
  const bootVerification = openBootVerification()
  // Every exit path closes the boundary, including a throw between bound steps; end() is idempotent.
  try {
    const scope = await bootVerification.bind(deps.resolveScope ?? resolveDaemonScope)({
      env: process.env,
      ...(platform.os === 'win32' ? { initializeHome: true } : {}),
      ...(args.home !== undefined ? { home: args.home } : {}),
      ...(args.profile !== undefined ? { profile: args.profile } : {}),
      ...(args.workspace !== undefined ? { workspace: args.workspace } : {}),
      ...(args.dataDir !== undefined ? { dataDir: args.dataDir } : {}),
    })
    if (!deps.resolveScope) {
      if (platform.os === 'win32')
        await initializeHomeLocked(scope.home, scope.profile, { dataDir: scope.dataDir })
      else initializeHome(scope.home, scope.profile)
    }
    const loadProfile = daemonProfileLoader(scope, deps.resolveProfile ?? resolveDaemonProfile)
    const loaded = await bootVerification.bind(loadProfile)()
    const { profile, configuration } = loaded
    const reloadProfile = async (adminBundles?: readonly string[]): Promise<ResolvedProfile> => {
      return (await loadProfile({ configuration, ...(adminBundles !== undefined ? { adminBundles } : {}) }))
        .profile
    }
    const { config, localWeb, remoteAuth } = resolveLaunchConfig(args, deps, scope, profile, platform)
    const { packageRuntime, packageAdmin } = await preparePackageRuntime(
      scope,
      profile,
      platform,
      bootVerification,
      deps,
    )
    const { record: audit, close: flushAudit } = openDaemonLogs(scope.dataDir)
    const lifetime = new AssemblyLifetime()
    lifetime.own({ dispose: flushAudit })
    const abort = async (error: unknown): Promise<never> => {
      try {
        await lifetime.dispose()
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'daemon startup and cleanup failed')
      }
      throw error
    }
    // An injected startProduction must not serve clients before the boundary ends; production
    // startSupervisor ends it after rebuildClientModules, before the client socket listens.
    const startProduction = bootVerification.bind(deps.startProduction ?? startProductionSupervisor)
    const sup = await startProduction({
      bootVerification,
      audit,
      config,
      profile,
      profileDir: scope.profileDir,
      profileFile: scope.profileFile,
      workspaceRoot: scope.workspace,
      configuration,
      reloadProfile,
      inspectProfile: createProfileInspection({
        profileDir: scope.profileDir,
        workspace: scope.workspace,
        configuration,
        resolve: reloadProfile,
      }),
      ...(deps.workerExecPath ? { workerExecPath: deps.workerExecPath } : {}),
      ...(deps.workerExecArgv ? { workerExecArgv: deps.workerExecArgv } : {}),
      ...(deps.workerEntry ? { workerEntry: deps.workerEntry } : {}),
      ...(remoteAuth ? { remoteAuth } : {}),
      ...(deps.directory ? { ports: { directory: deps.directory } } : {}),
      ...(packageAdmin ? { packageAdmin } : {}),
      ...(deps.resources ? { resources: deps.resources } : {}),
      ...(!deps.packageAdmin
        ? {
            packageRuntime,
          }
        : {}),
    }).catch(abort)
    lifetime.own({ dispose: () => sup.close() })
    // Remove discovery while the supervisor still owns its generation-bound lock, also on abort.
    lifetime.own({
      dispose: async () => {
        await (deps.removeDiscovery ?? removeDaemonDiscovery)(scope, sup.owner.generation).catch(
          bestEffort(audit, 'discovery-remove'),
        )
      },
    })
    const health: { error?: Error } = {}
    void sup.failed?.then((error) => {
      health.error = error
    })
    try {
      // An injected starter may leave the boot boundary open.
      await bootVerification.end()
      await (deps.publishDiscovery ?? publishDaemonDiscovery)(scope, {
        owner: sup.owner,
        socketPath: sup.socketPath,
        profileHash: profile.hash,
        ...(localWeb && sup.ws ? { web: { ...sup.ws, origin: localWeb.origin } } : {}),
      })
      if (health.error) throw health.error
    } catch (error) {
      return await abort(error)
    }
    const close = (): Promise<void> => lifetime.dispose()
    lifetime.own({ dispose: installSignals(close) })
    void sup.failed?.then(() => {
      console.error('agnesd local listener failed; shutting down')
      void close().then(
        () => process.exit(1),
        () => process.exit(1),
      )
    })
    const windows = process.platform === 'win32' // guards-allow-platform: Windows graceful stop is delivered through the private generation-bound request.
    if (windows)
      lifetime.own({
        dispose: watchWindowsStopRequest(scope.home, sup.owner, () => {
          void close().then(
            () => process.exit(0),
            () => process.exit(1),
          )
        }),
      })
    console.error(`agnesd listening on ${sup.socketPath}`)
    if (sup.ws)
      console.error(`agnesd WebSocket listening on ${sup.ws.url}; bearer token available to launcher`)
  } finally {
    await bootVerification.end()
  }
}
