import type { CallContext, LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { askSideQuestion, type HostSession, SideQuestionError } from '@agnes/host'
import { rpcError, type SessionBtwParams, type SessionBtwResult } from '@agnes/protocol'

/** Read-only side question: one model call, nothing written to the conversation. */
export function registerSessionBtw(
  ep: LocalEndpoint,
  cx: { registry: { get(sessionId: string): { session: HostSession } | undefined } },
  requireOwner: (method: string, sessionId: string, c: CallContext) => void,
): void {
  // At most one side question per session; a second one is refused rather than queued.
  const running = new Set<string>()
  ep.register('_agnes/v1/session.btw', async (params, c): Promise<SessionBtwResult> => {
    const p = params as SessionBtwParams
    requireOwner('session.btw', p.sessionId, c)
    const entry = cx.registry.get(p.sessionId)
    if (!entry) throw rpcError('SESSION_NOT_FOUND', { sessionId: p.sessionId })
    if (running.has(p.sessionId)) throw rpcError('SESSION_BUSY', { sessionId: p.sessionId, reason: 'btw' })
    running.add(p.sessionId)
    try {
      return await askSideQuestion(entry.session, p.question, { signal: c.signal })
    } catch (error) {
      if (!(error instanceof SideQuestionError)) throw error
      if (error.code === 'timeout') throw rpcError('REQUEST_TIMEOUT', { reason: 'btw' })
      if (error.code === 'budget') throw rpcError('SEMANTIC_REJECTED', { reason: 'BUDGET' })
      if (error.code === 'unavailable') throw rpcError('SEMANTIC_REJECTED', { reason: 'MODEL_UNAVAILABLE' })
      throw rpcError('INTERNAL_ERROR', { reason: 'btw failed' })
    } finally {
      running.delete(p.sessionId)
    }
  })
}
