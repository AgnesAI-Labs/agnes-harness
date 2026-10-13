import type { StoredOpeningReader } from '@agnes/host'
import {
  rpcError,
  type SessionStoredOpeningParams,
  type SessionStoredOpeningResult,
  UI_OPENING_DEFAULT_MAX_NODES,
} from '@agnes/protocol'
import type { CallContext, LocalEndpoint } from '../endpoint.js'

/**
 * `_agnes/v1/session.storedOpening`: the latest stretch of a session's history read straight from
 * storage, for a client to show read-only while a full open is slow or after it failed. It never
 * opens the session, so nothing here waits on a worker or the writer lease, and the result says it
 * was not verified. Without a reader (an in-process daemon, or storage that is not SQLite) it is
 * refused rather than answered from a live open.
 */
export function registerStoredOpening(
  ep: LocalEndpoint,
  deps: {
    requireSessionOwner: (method: string, sessionId: string, c: CallContext) => void
    storedOpening?: Pick<StoredOpeningReader, 'opening'>
  },
): void {
  ep.register('_agnes/v1/session.storedOpening', async (params, c): Promise<SessionStoredOpeningResult> => {
    const p = params as SessionStoredOpeningParams
    deps.requireSessionOwner('session.storedOpening', p.sessionId, c)
    if (!deps.storedOpening) throw rpcError('SEMANTIC_REJECTED', { reason: 'stored-opening-unavailable' })
    const read = await deps.storedOpening.opening(p.sessionId, p.maxNodes ?? UI_OPENING_DEFAULT_MAX_NODES)
    // Every session starts with a row; none means its ledger is not in the storage this daemon reads.
    if (read.lastSeq === 0) throw rpcError('SEMANTIC_REJECTED', { reason: 'stored-opening-unavailable' })
    // Not a live projection, so nothing will patch it: the first generation is as good as any.
    const timeline = { ...(read.timeline as SessionStoredOpeningResult['timeline']), generation: 1 }
    return { timeline, hasEarlier: read.hasEarlier, verified: false, lastSeq: read.lastSeq }
  })
}
