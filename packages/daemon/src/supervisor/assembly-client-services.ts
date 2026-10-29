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
  const resolveNewSessionActor: Host['resolveActor'] =
    o.profile.seams?.principals?.provider === 'local'
      ? async (_credential, surface) => ({
          id: 'local',
          org: 'local',
          role: 'owner',
          deptPath: [],
          attrs: { surface },
        })
      : async () => {
          throw rpcError('CAPABILITY_DENIED', {
            method: 'session/new',
            reason: 'new session actor authority unavailable',
          })
        }
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
        'inspection' | 'file'
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
  }
}

export type ClientsState = ReturnType<typeof openClientServices>
