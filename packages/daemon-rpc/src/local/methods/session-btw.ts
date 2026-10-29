import type { CallContext, LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { askSideQuestion, type HostSession, sideQuestionRpcError } from '@agnes/host'
import { rpcError, type SessionBtwParams, type SessionBtwResult } from '@agnes/protocol'

/** A worker-hosted session is a wire proxy; it asks the worker that holds the real session. */
type RemoteSideQuestion = {
  sideQuestion?: (question: string, signal: AbortSignal) => Promise<SessionBtwResult>
}

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
      const remote = entry.session as unknown as RemoteSideQuestion
      return remote.sideQuestion
        ? await remote.sideQuestion(p.question, c.signal)
        : await askSideQuestion(entry.session, p.question, { signal: c.signal })
    } catch (error) {
      throw sideQuestionRpcError(error)
    } finally {
      running.delete(p.sessionId)
    }
  })
}
