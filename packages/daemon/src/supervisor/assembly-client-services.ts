import { dirname } from 'node:path'
import { createAppServerAdmin } from '@agnes/daemon-admin/app-server'
import { runQueued } from '@agnes/daemon-rpc/local/command-queue'
import { createFollowUpRunner } from '@agnes/daemon-rpc/local/follow-up-runner'
import type { AgnesContext } from '@agnes/daemon-rpc/local/methods/agnes'
import { createPlanCommands } from '@agnes/daemon-rpc/local/plan-commands'
import type { Host } from '@agnes/host'
import { rpcError } from '@agnes/protocol'
import type { DispatchState } from './assembly-client-dispatch.js'
import type { AssemblyLifetime } from './assembly-lifetime.js'
import type { AssemblyBase } from './assembly-options.js'
import type { RuntimeState } from './assembly-runtime.js'
import type { SessionsState } from './assembly-session-services.js'
import type { StoresState } from './assembly-stores.js'
import type { WorkersState } from './assembly-workers.js'
import { managedSessionPorts, managedWorkspaceRoot } from './managed-session-ports.js'
import { createManagedSessions } from './managed-sessions.js'
import { managedWorkspaceGrants } from './managed-workspace-grants.js'
import { mcpOAuthServerLookup } from './mcp-oauth-server.js'
import { newSessionActorResolver } from './new-session-actor.js'
import { webhookSessions, webhookTriggerActor } from './webhook-sessions.js'

export function openClientServices(
  state: AssemblyBase & StoresState & WorkersState & DispatchState & RuntimeState & SessionsState,
  lifetime: AssemblyLifetime,
) {
  const {
    o,
    lock,

    workspaceCatalog,
    activationBarrier,
    commandQueue,
    journal,
    runtimeStore,
    automationEvents,
    pool,
    registry,
    supervisorRegistry,
    services,
    resourceControl,
    profilePorts,
    sessionOwnership,
    managedSessionRecords,
  } = state
  const resolveActor: NonNullable<AgnesContext['resolveActor']> =
    o.ports?.resolveActor ??
    (async (credential, surface, sessionId) => {
      if (!sessionId)
        throw rpcError('CAPABILITY_DENIED', {
          method: 'resolveActor',
          reason: 'session identity context unavailable',
        })
      return registry.require(sessionId).session.resolveActor(credential, surface)
    })
  const resolveNewSessionActor = newSessionActorResolver(o.profile)
  const continueTrigger = createFollowUpRunner(
    { commandQueue, activationBarrier, onPromptEnd: (id) => registry.retireAtTurnBoundary(id) },
    async () => undefined,
  )
  const triggerSessions = webhookSessions(o.config.socketPath, lock.owner, async (input) => {
    const entry = supervisorRegistry.require(input.sessionKey)
    // Only this backend closure can mint trigger identity/provenance; no chat RPC accepts it.
    await runQueued(commandQueue, entry.key, entry.ac.signal, () =>
      entry.session.enqueue('next-turn', {
        content: [{ type: 'text', text: input.prompt }],
        actor: webhookTriggerActor(input),
        origin: 'system',
        trust: 'untrusted',
        kind: 'follow_up',
        commandId: `webhook:${input.trigger.deliveryId}`,
      }),
    )
    continueTrigger(entry)
  })
  lifetime.own({ dispose: () => triggerSessions.close() })
  if (managedSessionRecords) {
    const catalog = async () =>
      (await (await pool.acquireSharedWorker()).command('session.catalog', {}, { timeoutMs: 31_000 })) as {
        modelAdapters: readonly { models: readonly { id: string; route: string }[] }[]
        security?: { platform?: { l1?: { level?: string } } }
      }
    const managed = managedSessionPorts({
      socketPath: o.config.socketPath,
      serverIdentity: lock.owner,
      records: managedSessionRecords,
      authorize: profilePorts.managedSessionAuthority,
      forkParent: (sessionId) => sessionOwnership.lineage(sessionId)?.parent,
      workspaces: workspaceCatalog,
      models: async () =>
        (await catalog()).modelAdapters.flatMap((adapter) =>
          adapter.models.map((model) => ({ route: model.route, model: model.id })),
        ),
      registry: supervisorRegistry as unknown as Parameters<typeof managedSessionPorts>[0]['registry'],
      commandQueue,
      continueTurn: (entry) => continueTrigger(entry as unknown as Parameters<typeof continueTrigger>[0]),
      opensWithCommandRules: true,
      // The platform's L1 sandbox probe; unprobed (no workspace bound yet) or partial is no boundary.
      osBoundary: async () => (await catalog()).security?.platform?.l1?.level === 'full',
    })
    const sessions = createManagedSessions(managed.ports)
    profilePorts.managedSessions.port = sessions
    profilePorts.managedSessions.skillInstallsOff = sessions.skillInstallsOff
    lifetime.own({ dispose: () => managed.close() })
  }
  const workspaceGrants = managedSessionRecords
    ? managedWorkspaceGrants({
        records: managedSessionRecords,
        packages: profilePorts.managedSessionPackages,
        workspaceRoot: managedWorkspaceRoot(workspaceCatalog),
        canonical: async (path) => (await workspaceCatalog.validate(path).catch(() => undefined))?.path,
      })
    : undefined
  void workspaceGrants?.prune().catch(() => undefined)
  const appServerAdmin = createAppServerAdmin({
    triggerSession: triggerSessions.create,
    credentialConfigurations: async () => {
      if (!runtimeStore) throw new Error('credential reference inspection unavailable')
      return runtimeStore.credentialConfigurations()
    },
    home: o.config.home ?? dirname(dirname(o.profileDir)),
    dataDir: o.config.dataDir,
    profileDir: o.profileDir,
    resolveProfile: o.reloadProfile ?? (async () => o.profile),
    ...(o.inspectProfile ? { inspectProfile: o.inspectProfile } : {}),
    workspaces: () => workspaceCatalog.list(),
    mcpServer: mcpOAuthServerLookup(resourceControl.service),
    plan: createPlanCommands({
      activationBarrier,
      journal,
      commandQueue,
      callService: services.callService,
      inspectService: services.inspectService,
      resolveService: services.resolveService,
    }),
    memory: async (input) => {
      const link = await pool.acquireSharedWorker()
      return (await link.command('memory.manage', input)) as Pick<
        import('@agnes/protocol/gen/app-server').AdminMemoryResult,
        'inspection' | 'file' | 'saved'
      >
    },
  })
  automationEvents.triggers = appServerAdmin.observeTriggerSession

  return {
    resolveActor,
    resolveNewSessionActor,
    continueTrigger,
    triggerSessions,
    appServerAdmin,
    workspaceGrants,
  }
}

export type ClientsState = ReturnType<typeof openClientServices>
