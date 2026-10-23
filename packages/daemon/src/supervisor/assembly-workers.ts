import { collectPackageSkillFiles } from '@agnes/base'
import { RUN_PROGRESS_EVENT_TYPES } from '@agnes/base/schedule'
import { CompositeTargetStore } from '@agnes/daemon-foundation/storage/composite-target-store'
import {
  SessionPreferencesStore,
  withSessionPreferences,
} from '@agnes/daemon-foundation/storage/session-preferences'
import { MemorySidebarSessions } from '@agnes/daemon-foundation/storage/sidebar-memory'
import { SidebarSessions } from '@agnes/daemon-foundation/storage/sidebar-sessions'
import { APPROVAL_TICKET_EVENT_TYPES, indexApprovalTicket } from '@agnes/daemon-rpc/local/methods/agnes'
import { PrompterRouter } from '@agnes/daemon-rpc/local/prompter'
import { createFeedbackOwner, type FeedbackOwner } from '@agnes/host'
import type { RuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import type { EventEnvelope } from '@agnes/protocol'
import {
  deploymentMcpPolicy,
  installResourceServiceAdapters,
  writePackageSkillInventory,
} from '@agnes/resource-control-daemon'
import { type AssemblyLifetime, assemblyPort, assemblyTasks } from './assembly-lifetime.js'
import type { AssemblyBase } from './assembly-options.js'
import type { StoresState } from './assembly-stores.js'
import {
  CompositeRuntimeDelivery,
  deliverDesiredToWorkers,
} from './publication/composite-runtime-delivery.js'
import { type RegistryOptions, WorkerRegistry } from './registry.js'
import { SupervisorRegistry, supervisorLister } from './registry-facade.js'
import { wireResourceSnapshotNotifications } from './resource-snapshot-notifications.js'
import { createInProcessRuntimeTargetProbe } from './runtime-target-probe.js'
import { observeSessionRequests, SESSION_REQUEST_EVENT_TYPES } from './session-request-events.js'
import { createAutomationEvents, deliverWorkerEvent } from './worker-events.js'
import { WorkerPool } from './worker-pool.js'

interface WorkerFeedbackOwner {
  bind: FeedbackOwner['bind']
  close: FeedbackOwner['close']
}

export async function openWorkers(state: AssemblyBase & StoresState, lifetime: AssemblyLifetime) {
  const {
    o,
    workerEntry,
    clock,
    conns,
    jobTables,
    tickets,
    workspaces,
    sessionOwnership,
    workspaceCatalog,
    resourceWorkerRoot,
    resourceWorkerWorkspaceId,
    localResourceStore,
    packageSkillSnapshotPath,
    resourceSkillLkgDirectory,
    notices,
    inflightConn,
    projectedArtifactRead,
  } = state
  const runtimeStore = jobTables
    ? new CompositeTargetStore(jobTables.table('composite_runtime'), o.profile.name)
    : undefined
  const notifyRuntimeTarget = (artifact: RuntimeTargetArtifact) =>
    notices.emit('tree_changed', {
      detail: {
        profile: o.profile.name,
        targetDigest: artifact.digest,
        identity: artifact.identity,
        hash: artifact.digest,
      },
    })
  const references = o.packageRuntime?.references
  if (references) lifetime.own({ dispose: () => references.close() })
  const embeddedAdmin = o.packageRuntime?.embeddedAdmin
  if (embeddedAdmin) lifetime.own({ dispose: () => embeddedAdmin.close() })
  const runtimeFailure = assemblyPort<() => Promise<void>>()
  const runtimeWork = assemblyTasks()
  lifetime.own({
    dispose: async () => {
      runtimeFailure.close()
      await runtimeWork.close()
    },
  })
  const runtimeDelivery = runtimeStore
    ? new CompositeRuntimeDelivery(runtimeStore, {
        onFailureRecorded: () => runtimeFailure.read()(),
        onConverged: notifyRuntimeTarget,
      })
    : undefined
  const runtimeTargetProbe = runtimeStore ? createInProcessRuntimeTargetProbe() : undefined
  const automationEvents = createAutomationEvents(sessionOwnership, notices, o.profile.name)
  const workerRequests = assemblyPort<NonNullable<ConstructorParameters<typeof WorkerPool>[0]['onRequest']>>()
  lifetime.own({ dispose: () => workerRequests.close() })
  const pool = new WorkerPool({
    config: o.config,
    profile: o.profile,
    profileFile: o.profileFile,
    resourceBootstrap: {
      ...(localResourceStore ? { snapshotPath: localResourceStore.snapshotPath(o.profile.name) } : {}),
      skillLkgDirectory: resourceSkillLkgDirectory,
      packageSkillSnapshotPath,
      mcpPolicy: deploymentMcpPolicy(process.env, o.profile.name),
    },
    clock,
    ...(o.workerExecPath ? { execPath: o.workerExecPath } : {}),
    ...(o.workerExecArgv ? { execArgv: o.workerExecArgv } : {}),
    workerEntry,

    onEvent: (sessionKey, e) =>
      deliverWorkerEvent(registry, tickets, clock, sessionKey, e, workspaces, () => {
        automationEvents.observe(sessionKey, e)
        observeSessionRequests(pool, sessionKey, e)
      }),
    onPreview: (sessionKey, p) => registry.deliverPreview(sessionKey, p),
    onDecisionsChanged: (detail) => {
      if (detail.profile === o.profile.name) notices.emit('decisions_changed', { detail })
    },
    onResourceStatus: (input) => resourceAdapters?.observeMcpStatus(input),
    onRuntimeLog: (record) => o.audit?.(record),
    onLog: (input) => o.audit?.({ kind: 'worker.log', ...input }),
    onLifecycle: (phase, id) => o.observability?.lifecycle('worker', phase, undefined, id),
    onSessionFailure: (sessionKey, error) => registry.interrupt(sessionKey, error),
    ...(runtimeDelivery ? { runtimeDelivery } : {}),
    onRequest: (...args) => workerRequests.read()(...args),
    notices,
  })
  const stopDesired = runtimeStore?.onDesired((artifact) => {
    // Candidate publication can change static Skills without creating a package operation.
    pool.noteRuntimeTarget(artifact.digest)
    notifyRuntimeTarget(artifact)
    if (runtimeDelivery?.stageStartup(artifact)) return
    void deliverDesiredToWorkers(pool, artifact).catch((error) => {
      o.audit?.({
        kind: 'worker.log',
        sessionKey: '@shared',
        level: 'warn',
        message: `desired delivery failed: ${error instanceof Error ? error.message : String(error)}`,
      })
    })
  })
  if (stopDesired) lifetime.own({ dispose: stopDesired })
  const registry: WorkerRegistry = new WorkerRegistry(pool, projectedArtifactRead?.projection, {
    workspaces,
    history: createWorkerHistory({
      pool,
      automationEvents,
      tickets,
      clock,
      cwd: (key) => registry.get(key)?.session.cwd,
    }),
  })
  const prompter = new PrompterRouter({
    resolveActor: async (conn, key) =>
      o.ports?.resolveActor
        ? o.ports.resolveActor(conn.credential, 'approval', key)
        : registry.require(key).session.resolveActor(conn.credential, 'approval'),
    ...(o.ports?.verifyApprovalSource ? { verifySource: o.ports.verifyApprovalSource } : {}),
    endpointFor: (conn) => {
      const found = [...conns].find((c) => c.conn === conn)
      // Every candidate PrompterRouter.ask() considers comes from `connections()` below, which is
      // drawn from this same `conns` set - so a candidate not found here would mean the set changed
      // between the two reads, which never happens within one synchronous filter/find pass.
      if (!found) throw new Error('endpointFor: connection not found among live connections')
      return found.ep
    },
    connections: () => [...conns].map((c) => c.conn),
    originOf: (key) => inflightConn.get(key),
    clock,
  })
  // Resource lifecycle owns a profile-scoped service generation, independent of chat workers.
  const resourceAdapters = localResourceStore
    ? installResourceServiceAdapters({
        store: localResourceStore,
        pool,
        profile: o.profile,
        workspaceRoot: resourceWorkerRoot,
        resolveWorkspace: (workspaceId) => {
          if (!o.workspaceRoot && (!workspaceId || workspaceId === resourceWorkerWorkspaceId))
            return Promise.resolve({ workspaceId: resourceWorkerWorkspaceId, path: resourceWorkerRoot })
          return workspaceCatalog.bind(workspaceId, resourceWorkerRoot)
        },
        refreshPackageSkills: () =>
          writePackageSkillInventory(
            o.profile,
            o.profileDir,
            packageSkillSnapshotPath,
            collectPackageSkillFiles,
          ),
      })
    : undefined
  if (localResourceStore)
    wireResourceSnapshotNotifications({ localResourceStore, registry, pool, log: console })
  const feedbackOwner: WorkerFeedbackOwner = createFeedbackOwner(o.profile.name)
  lifetime.own({ dispose: () => feedbackOwner.close() })
  lifetime.own({
    drain: async (graceMs, signal) => {
      await registry.closeAll()
      if (!signal.aborted) await pool.closeAll(graceMs)
    },
    force: () => pool.killAll(),
    dispose: async () => {
      await pool.waitForExitRecovery()
    },
  })
  const supervisorRegistry = new SupervisorRegistry(registry, workspaces)
  const preferences = new SessionPreferencesStore(jobTables?.table('session_preferences'))
  const sessionFactRead = o.sessionFactRead
  const sidebarSessions = jobTables
    ? new SidebarSessions(
        jobTables.table('session_workspaces'),
        workspaces,
        sessionFactRead ? (key, query) => sessionFactRead(key)(query) : undefined,
      )
    : new MemorySidebarSessions(workspaces, sessionOwnership, preferences, () => workspaceCatalog.list())
  lifetime.own({ dispose: () => sidebarSessions.close() })
  const rawLister = o.ports?.lister ?? supervisorLister(supervisorRegistry, workspaces)

  const lister = withSessionPreferences(rawLister, preferences)

  return {
    feedbackOwner,
    runtimeStore,
    notifyRuntimeTarget,
    runtimeFailure,
    runtimeWork,
    runtimeDelivery,
    runtimeTargetProbe,
    automationEvents,
    workerRequests,
    pool,
    stopDesired,
    registry,
    prompter,
    resourceAdapters,
    supervisorRegistry,
    preferences,
    sidebarSessions,
    rawLister,
    lister,
  }
}

export type WorkersState = Awaited<ReturnType<typeof openWorkers>>

function createWorkerHistory({
  pool,
  automationEvents,
  tickets,
  clock,
  cwd,
}: {
  pool: WorkerPool
  automationEvents: ReturnType<typeof createAutomationEvents>
  tickets: StoresState['tickets']
  clock: AssemblyBase['clock']
  cwd(key: string): string | undefined
}): NonNullable<RegistryOptions['history']> {
  return [
    {
      types: SESSION_REQUEST_EVENT_TYPES,
      observe: (key, e) => observeSessionRequests(pool, key, e),
    },
    { types: RUN_PROGRESS_EVENT_TYPES, observe: (key, e) => automationEvents.observe(key, e) },
    ...(tickets
      ? [
          {
            types: APPROVAL_TICKET_EVENT_TYPES,
            observe: (key: string, e: EventEnvelope) => {
              tickets.gc(clock())
              indexApprovalTicket(tickets, key, e, cwd(key))
            },
          },
        ]
      : []),
  ]
}
