import { dirname } from 'node:path'
import { createAppServerAdmin } from '@agnes/daemon-admin/app-server'
import { commandBinding } from '@agnes/daemon-rpc/local/command-binding'
import { runQueued } from '@agnes/daemon-rpc/local/command-queue'
import { createFollowUpRunner } from '@agnes/daemon-rpc/local/follow-up-runner'
import type { AgnesContext } from '@agnes/daemon-rpc/local/methods/agnes'
import { createPlanCommands } from '@agnes/daemon-rpc/local/plan-commands'
import type { Host } from '@agnes/host'
import { type ApprovalDecideParams, rpcError, type UiActionParams, validateMethod } from '@agnes/protocol'
import type { DispatchState } from './assembly-client-dispatch.js'
import type { AssemblyLifetime } from './assembly-lifetime.js'
import type { AssemblyBase } from './assembly-options.js'
import type { RuntimeState } from './assembly-runtime.js'
import type { SessionsState } from './assembly-session-services.js'
import type { StoresState } from './assembly-stores.js'
import type { WorkersState } from './assembly-workers.js'
import { sharedWorkerReads } from './managed-gate-read.js'
import type { OwnerInputEngineDeps } from './managed-input-admission.js'
import { createIdleSignal, driveOwnerInputs } from './managed-session-idle.js'
import { managedSessionPorts, managedWorkspaceRoot } from './managed-session-ports.js'
import { createManagedSessions } from './managed-sessions.js'
import { managedWorkspaceGrants } from './managed-workspace-grants.js'
import { mcpOAuthServerLookup } from './mcp-oauth-server.js'
import { newSessionActorResolver } from './new-session-actor.js'
import { webhookSessions, webhookTriggerActor } from './webhook-sessions.js'

/** The slow sweep for held owner inputs whose turns report no idle. */
const OWNER_INPUT_SWEEP_MS = 60_000

/** The owner input engine's deps when managed sessions keep input records; crash points come only from test fixtures. */
function ownerInputDeps(
  o: Pick<AssemblyBase['o'], 'ownerInputFaults'>,
  inputs: StoresState['managedSessionInputs'],
  enabled: OwnerInputEngineDeps['enabled'],
): Pick<OwnerInputEngineDeps, 'inputs' | 'enabled' | 'faults'> | undefined {
  if (!inputs) return undefined
  return {
    inputs,
    ...(enabled ? { enabled } : {}),
    ...(o.ownerInputFaults ? { faults: o.ownerInputFaults } : {}),
  }
}

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
    managedSessionInputs,
    ownerInputHolder,
    preferences,
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
  const idle = o.idleSignal ?? createIdleSignal()
  const continueTrigger = createFollowUpRunner(
    {
      commandQueue,
      activationBarrier,
      onPromptEnd: (id) => {
        registry.retireAtTurnBoundary(id)
        idle.notify(id)
      },
    },
    async () => undefined,
  )
  profilePorts.channelInteractions.submit = async (kind, value, credential) => {
    const method = kind === 'surface' ? '_agnes/v1/ui.action' : '_agnes/v1/approval.decide'
    if (!validateMethod(method, 'params', value).ok) throw rpcError('INVALID_PARAMS')
    const params = value as UiActionParams | ApprovalDecideParams
    const binding = await workspaceCatalog.restoreBinding(params.sessionId)
    const entry = await supervisorRegistry.open({
      key: params.sessionId,
      cwd: binding.canonicalRoot,
      binding,
    })
    return runQueued(commandQueue, entry.key, entry.ac.signal, async (signal) => {
      const actor = await resolveActor(credential, kind === 'surface' ? 'session' : 'approval', entry.key)
      if (actor.role === 'agent' || actor.role === 'extension') throw rpcError('CAPABILITY_DENIED')
      if (kind === 'surface') {
        const action = params as UiActionParams
        const identity = {
          principalId: actor.id,
          clientId: 'channel-interactions',
          sessionId: entry.key,
          commandId: `ui:${action.commandId}`,
        }
        const admitted = await journal.begin(
          identity,
          commandBinding('ui.action', entry.key, undefined, action),
        )
        if (admitted.state === 'conflict')
          throw rpcError('SEMANTIC_REJECTED', { code: 'UI_COMMAND_CONFLICT' })
        if (admitted.state === 'corrupt') throw rpcError('SEMANTIC_REJECTED', { code: 'UI_RECOVERY_GAP' })
        try {
          const receipt = await entry.submitUiAction?.(action, credential, signal)
          if (!receipt) throw rpcError('CAPABILITY_DENIED')
          if (admitted.state !== 'complete') await journal.complete(identity, { seq: receipt.seq })
          continueTrigger(entry, undefined, receipt.status === 'received')
          return receipt
        } catch (error) {
          if (admitted.state === 'new') await journal.abandon(identity)
          throw error
        }
      }
      const approval = params as ApprovalDecideParams
      const session = registry.require(entry.key).session
      const receipt = await session.decideApproval({
        command: {
          handle: { id: approval.id, sessionId: approval.sessionId },
          revision: approval.revision,
          commandId: approval.commandId,
          response: approval.response,
        },
        context: { actor, category: 'human', credential, sourceVerified: false },
      })
      if (!receipt) throw rpcError('CAPABILITY_DENIED')
      const target = (await session.listDecisions()).find((value) => value.handle.id === approval.id)
      if (!entry.inflight && (!target || (!target.consumption && !target.invalidation)))
        continueTrigger(entry, undefined, true)
      return receipt
    })
  }
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
    const { catalog, resolveAgent } = sharedWorkerReads(pool)
    const managed = managedSessionPorts({
      socketPath: o.config.socketPath,
      ...(o.sessionFactRead ? { sessionFactRead: o.sessionFactRead } : {}),
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
      preferences,
      idle,
      resolveAgent,
    })
    const sessions = createManagedSessions(
      managed.ports,
      ownerInputDeps(o, managedSessionInputs, profilePorts.managedSessionEnabled),
    )
    profilePorts.managedSessions.port = sessions
    profilePorts.managedSessions.skillInstallsOff = sessions.skillInstallsOff
    lifetime.own({ dispose: () => managed.close() })
    if (sessions.engine) {
      ownerInputHolder.engine = sessions.engine
      // Owned after the session ports, so the sweeps stop before those ports close; they stop as shutdown starts.
      lifetime.own(driveOwnerInputs(idle, sessions.engine, OWNER_INPUT_SWEEP_MS))
    }
  }
  const workspaceGrants = managedSessionRecords
    ? managedWorkspaceGrants({
        records: managedSessionRecords,
        packages: profilePorts.managedSessionPackages,
        workspaceRoot: managedWorkspaceRoot(workspaceCatalog),
        canonical: async (path) => (await workspaceCatalog.validate(path).catch(() => undefined))?.path,
        withdraw: async (owner, workspace) => ownerInputHolder.engine?.withdraw(owner, workspace),
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
    idle,
    resolveActor,
    resolveNewSessionActor,
    continueTrigger,
    triggerSessions,
    appServerAdmin,
    workspaceGrants,
    /** The owner-input engine for the Web review, when managed sessions have records. */
    ownerInputs: ownerInputHolder.engine,
  }
}

export type ClientsState = ReturnType<typeof openClientServices>
