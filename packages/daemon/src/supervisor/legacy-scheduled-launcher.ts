import type { JobsRepo } from '@agnes/daemon-foundation/jobs/repo'
import { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { createSessionInternal, type LocalContext } from '@agnes/daemon-rpc/local/methods/acp'
import type { openSessionServices } from './assembly-session-services.js'
import { newSessionActorResolver } from './new-session-actor.js'
import type { scheduledTasks } from './schedule-sessions.js'
import type { createScheduledSessionAdmission } from './scheduled-session-admission.js'

/** The trusted launcher carries only server-owned identity and the shared authenticated creator. */
export function createLegacyScheduledLauncher(
  state: Parameters<typeof openSessionServices>[0],
  repo: JobsRepo | undefined,
  currentAdmissions: () => ReturnType<typeof createScheduledSessionAdmission> | undefined,
): Parameters<typeof scheduledTasks>[0]['legacy'] {
  const { o, host, supervisorRegistry, clock, activationBarrier, workspaceCatalog, sessionOwnership } = state
  const root = workspaceCatalog.managedChats.legacy
  const authority = workspaceCatalog.managedChatAuthority
  if (!root || !authority || !repo) return undefined
  const internalCreationContext: LocalContext = {
    host,
    registry: supervisorRegistry,
    prompter: state.prompter,
    clock,
    agnesVersion: '0.0.0',
    quiescenceWaitMs: 2_000,
    auth: { config: { transport: 'unix' }, nonces: state.nonces, clock },
    commandQueue: state.commandQueue,
    activationBarrier,
    workspaces: workspaceCatalog,
    resolveNewSessionActor: newSessionActorResolver(o.profile),
    sessionOwnership,
    sessionCredentialAuthority: true,
  }
  return {
    root,
    authority,
    repo,
    create: async (target, _title, admission, signal) => {
      const current = currentAdmissions()
      if (!current) throw new Error('scheduled session admission unavailable')
      const ep = new LocalEndpoint({ clock, principalId: 'local', profile: o.profile.name })
      ep.conn.authKind = 'local'
      ep.conn.credential = { kind: 'local' }
      try {
        const result = await createSessionInternal(
          internalCreationContext,
          {
            cwd: target.cwd,
            mcpServers: [],
            _meta: {
              'ai.agnes.harness': {
                sessionKey: admission.sessionKey,
                permission: 'default',
                ...(target.preset ? { preset: target.preset } : {}),
                ...(target.bundles?.length ? { bundles: target.bundles } : {}),
                ...(target.loop ? { loop: target.loop } : {}),
              },
            },
          },
          { conn: ep.conn, clock, signal: signal ?? new AbortController().signal },
          {
            validateWorkspace: async (cwd, key) => {
              current.consume(admission, cwd, key)
              return workspaceCatalog.validate(cwd)
            },
            afterBind: (key) => current.commit(admission, key),
          },
        )
        return result.sessionId
      } finally {
        await ep.close()
      }
    },
  }
}
