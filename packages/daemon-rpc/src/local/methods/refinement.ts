import type { CallContext, LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import {
  type HostSession,
  type RefinementSettingsStore,
  requestRefinement,
  rollbackRefinement,
  saveEntryToWorkspace,
} from '@agnes/host'
import {
  type RefinementSettingsSaveParams,
  type RefinementSettingsSaveResult,
  type RefinementSettingsSnapshot,
  type RefinementSkillsParams,
  type RefinementSkillsResult,
  rpcError,
  type SessionRefineParams,
  type SessionRefineResult,
  type SessionRefineRollbackParams,
  type SessionRefineRollbackResult,
  type SessionRefineSaveParams,
  type SessionRefineSaveResult,
} from '@agnes/protocol'

const errorCode = (error: unknown): string | undefined => (error as { code?: string } | null)?.code

/** The refinement switch of the daemon's profile: local callers only, saved by compare-and-swap. */
export function registerRefinement(
  ep: LocalEndpoint,
  deps: {
    settings: Pick<RefinementSettingsStore, 'read' | 'save'>
    /** Told, after the save, when a save turned refinement on; it cannot fail the save. */
    switchedOn?: () => void
    /** The skills refinement saved in a workspace, for the owner; absent where none are saved. */
    skills?: (params: RefinementSkillsParams, actor: string) => Promise<RefinementSkillsResult>
  },
): void {
  // The same guard as `config.*` and `voice.settings.*`: settings are local profile configuration.
  const local = (c: Parameters<Parameters<LocalEndpoint['register']>[1]>[1]) => {
    if (c.conn.authKind !== 'local' || c.conn.credentialKind !== 'local')
      throw rpcError('CAPABILITY_DENIED', {
        method: 'refinement.settings',
        reason: 'local configuration only',
      })
  }
  const stored = <T>(action: () => T): T => {
    try {
      return action()
    } catch (error) {
      const code = errorCode(error)
      if (code === 'CONFIG_REVISION_CONFLICT' || code === 'CONFIG_INVALID_INPUT')
        throw rpcError('SEMANTIC_REJECTED', { reason: code })
      throw rpcError('INTERNAL_ERROR', { reason: 'refinement settings unavailable' })
    }
  }
  ep.register('_agnes/v1/refinement.get', async (_params, c): Promise<RefinementSettingsSnapshot> => {
    local(c)
    return stored(() => deps.settings.read())
  })
  // The owner's saved skills: listed, uninstalled or rolled back, on this machine only.
  ep.register('_agnes/v1/refinement.skills', async (params, c): Promise<RefinementSkillsResult> => {
    local(c)
    if (!deps.skills) throw rpcError('SEMANTIC_REJECTED', { reason: 'SKILL_UNAVAILABLE' })
    return deps.skills(params as RefinementSkillsParams, c.conn.principalId)
  })
  ep.register('_agnes/v1/refinement.save', async (params, c): Promise<RefinementSettingsSaveResult> => {
    local(c)
    const p = params as RefinementSettingsSaveParams
    let wasOn = false
    try {
      wasOn = deps.settings.read().settings.enabled === true
    } catch {
      // unreadable counts as off
    }
    const saved = stored(() => deps.settings.save(p.settings, p.expectedRevision))
    if (p.settings.enabled === true && !wasOn)
      try {
        deps.switchedOn?.()
      } catch {
        // advisory: the setting is saved either way
      }
    return saved
  })
}

/** A worker-hosted session is a wire proxy; it asks the worker that holds the real session. */
type RemoteRefine = {
  refine?: (
    focus: string | undefined,
    saveTo: 'workspace' | 'user' | undefined,
    allowUnpriced: true | undefined,
  ) => Promise<SessionRefineResult>
  refineRollback?: (appliedSeq: number) => Promise<SessionRefineRollbackResult>
  refineSave?: (
    kind: SessionRefineSaveParams['kind'],
    id: string,
    target: 'user' | undefined,
  ) => Promise<SessionRefineSaveResult>
}

/** Only the owner on this machine: a local connection with a local credential. */
function localOwnerOnly(method: string, c: CallContext): void {
  if (c.conn.authKind !== 'local' || c.conn.credentialKind !== 'local')
    throw rpcError('CAPABILITY_DENIED', { method, reason: 'local owner only' })
}

/**
 * The owner's manual refinement request (queues a background plan and returns the run at once), the
 * owner's withdrawal of an applied refinement, and the owner's save of an entry to the workspace.
 * Saving to the workspace (`/refine --workspace`, the per-entry save) speaks for the user, which may
 * override what the user took back before, so it is taken only from the owner on this machine.
 */
export function registerSessionRefine(
  ep: LocalEndpoint,
  cx: { registry: { get(sessionId: string): { session: HostSession } | undefined } },
  requireOwner: (method: string, sessionId: string, c: CallContext) => void,
): void {
  ep.register('_agnes/v1/session.refine', async (params, c): Promise<SessionRefineResult> => {
    const p = params as SessionRefineParams
    // Saving as the user and agreeing to an unknown price both speak for the owner on this machine.
    if (p.saveTo !== undefined || p.allowUnpriced !== undefined) localOwnerOnly('session.refine', c)
    requireOwner('session.refine', p.sessionId, c)
    const entry = cx.registry.get(p.sessionId)
    if (!entry) throw rpcError('SESSION_NOT_FOUND', { sessionId: p.sessionId })
    const remote = entry.session as unknown as RemoteRefine
    return remote.refine
      ? remote.refine(p.focus, p.saveTo, p.allowUnpriced)
      : requestRefinement(entry.session, p.focus, p.saveTo, p.allowUnpriced)
  })
  // Withdrawing an applied refinement changes what the session's model is told, so only the owner on
  // this machine may: a local connection with a local credential, like the refinement settings.
  ep.register(
    '_agnes/v1/session.refine.rollback',
    async (params, c): Promise<SessionRefineRollbackResult> => {
      const p = params as SessionRefineRollbackParams
      localOwnerOnly('session.refine.rollback', c)
      requireOwner('session.refine.rollback', p.sessionId, c)
      const entry = cx.registry.get(p.sessionId)
      if (!entry) throw rpcError('SESSION_NOT_FOUND', { sessionId: p.sessionId })
      const remote = entry.session as unknown as RemoteRefine
      return remote.refineRollback
        ? remote.refineRollback(p.appliedSeq)
        : rollbackRefinement(entry.session, p.appliedSeq)
    },
  )
  ep.register('_agnes/v1/session.refine.save', async (params, c): Promise<SessionRefineSaveResult> => {
    const p = params as SessionRefineSaveParams
    localOwnerOnly('session.refine.save', c)
    requireOwner('session.refine.save', p.sessionId, c)
    const entry = cx.registry.get(p.sessionId)
    if (!entry) throw rpcError('SESSION_NOT_FOUND', { sessionId: p.sessionId })
    const remote = entry.session as unknown as RemoteRefine
    return remote.refineSave
      ? remote.refineSave(p.kind, p.id, p.target)
      : saveEntryToWorkspace(entry.session, { kind: p.kind, id: p.id }, p.target)
  })
}
