import type { CallContext, LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import {
  type HostSession,
  type RefinementSettingsStore,
  requestRefinement,
  rollbackRefinement,
} from '@agnes/host'
import {
  type RefinementSettingsSaveParams,
  type RefinementSettingsSaveResult,
  type RefinementSettingsSnapshot,
  rpcError,
  type SessionRefineParams,
  type SessionRefineResult,
  type SessionRefineRollbackParams,
  type SessionRefineRollbackResult,
} from '@agnes/protocol'

const errorCode = (error: unknown): string | undefined => (error as { code?: string } | null)?.code

/** The refinement switch of the daemon's profile: local callers only, saved by compare-and-swap. */
export function registerRefinement(
  ep: LocalEndpoint,
  deps: { settings: Pick<RefinementSettingsStore, 'read' | 'save'> },
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
  ep.register('_agnes/v1/refinement.save', async (params, c): Promise<RefinementSettingsSaveResult> => {
    local(c)
    const p = params as RefinementSettingsSaveParams
    return stored(() => deps.settings.save(p.settings, p.expectedRevision))
  })
}

/** A worker-hosted session is a wire proxy; it asks the worker that holds the real session. */
type RemoteRefine = {
  refine?: (focus: string | undefined) => Promise<SessionRefineResult>
  refineRollback?: (appliedSeq: number) => Promise<SessionRefineRollbackResult>
}

/**
 * The owner's manual refinement request (queues a background plan and returns the run at once), and
 * the owner's withdrawal of an applied refinement.
 */
export function registerSessionRefine(
  ep: LocalEndpoint,
  cx: { registry: { get(sessionId: string): { session: HostSession } | undefined } },
  requireOwner: (method: string, sessionId: string, c: CallContext) => void,
): void {
  ep.register('_agnes/v1/session.refine', async (params, c): Promise<SessionRefineResult> => {
    const p = params as SessionRefineParams
    requireOwner('session.refine', p.sessionId, c)
    const entry = cx.registry.get(p.sessionId)
    if (!entry) throw rpcError('SESSION_NOT_FOUND', { sessionId: p.sessionId })
    const remote = entry.session as unknown as RemoteRefine
    return remote.refine ? remote.refine(p.focus) : requestRefinement(entry.session, p.focus)
  })
  // Withdrawing an applied refinement changes what the session's model is told, so only the owner on
  // this machine may: a local connection with a local credential, like the refinement settings.
  ep.register(
    '_agnes/v1/session.refine.rollback',
    async (params, c): Promise<SessionRefineRollbackResult> => {
      const p = params as SessionRefineRollbackParams
      if (c.conn.authKind !== 'local' || c.conn.credentialKind !== 'local')
        throw rpcError('CAPABILITY_DENIED', { method: 'session.refine.rollback', reason: 'local owner only' })
      requireOwner('session.refine.rollback', p.sessionId, c)
      const entry = cx.registry.get(p.sessionId)
      if (!entry) throw rpcError('SESSION_NOT_FOUND', { sessionId: p.sessionId })
      const remote = entry.session as unknown as RemoteRefine
      return remote.refineRollback
        ? remote.refineRollback(p.appliedSeq)
        : rollbackRefinement(entry.session, p.appliedSeq)
    },
  )
}
