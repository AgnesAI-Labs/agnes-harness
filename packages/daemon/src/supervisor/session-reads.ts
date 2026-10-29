import type { CallContext, LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { type createSqliteStorage, readStoredSessionView, type ScanRead } from '@agnes/host'
import {
  type EventEnvelope,
  rpcError,
  type SessionRuntimeParams,
  type SessionViewParams,
} from '@agnes/protocol'
import type { WorkerPool } from './worker-pool.js'

/** A recorded session's view read from the daemon's own ledger connection. */
export type SessionViewRead = (
  sessionId: string,
  options: { maxNodes?: number; signal?: AbortSignal },
) => Promise<unknown>

/**
 * The ledger reads the daemon answers itself: fact chains always, and recorded session views when
 * the daemon's ledger is the Host's, which holds only for the default SQLite persistence.
 */
export function storageReads(
  o: {
    sessionFactRead?: (sessionId: string) => ScanRead<EventEnvelope>
    sessionViewRead?: SessionViewRead
    profile: { persistence?: unknown }
  },
  storage: ReturnType<typeof createSqliteStorage>,
): { sessionFactRead: (sessionId: string) => ScanRead<EventEnvelope>; sessionViewRead?: SessionViewRead } {
  const sessionViewRead =
    o.sessionViewRead ??
    (o.profile.persistence === undefined
      ? (key: string, options: { maxNodes?: number; signal?: AbortSignal }) =>
          readStoredSessionView(storage, key, options)
      : undefined)
  return {
    sessionFactRead: o.sessionFactRead ?? ((key) => (query) => storage.scan(key, query)),
    ...(sessionViewRead ? { sessionViewRead } : {}),
  }
}

/**
 * Read through the shared Host without opening a session or acquiring its writer lease. A recorded
 * view needs only stored rows: with `viewRead` it is answered without waiting for a worker, and any
 * failure there other than a missing session is retried through the worker.
 */
export function registerWorkerSessionReads(
  endpoint: LocalEndpoint,
  pool: Pick<WorkerPool, 'acquireSharedWorker'>,
  requireOwner: (method: string, sessionId: string, context: CallContext) => void,
  viewRead?: SessionViewRead,
): void {
  endpoint.register('_agnes/v1/agents.resolve', async (params) => {
    const link = await pool.acquireSharedWorker()
    return link.command('agents.resolve', params as { ref: string })
  })
  endpoint.register('_agnes/v1/session.runtime', async (params, context) => {
    const input = params as SessionRuntimeParams
    requireOwner('session.runtime', input.sessionId, context)
    const link = await pool.acquireSharedWorker()
    return link.command('session.runtime', input)
  })
  endpoint.register('_agnes/v1/session.view', async (params, context) => {
    const input = params as SessionViewParams
    requireOwner('session.view', input.sessionId, context)
    if (viewRead)
      try {
        return await viewRead(input.sessionId, {
          ...(input.maxNodes === undefined ? {} : { maxNodes: input.maxNodes }),
          signal: context.signal,
        })
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === 'E_SESSION_NOT_FOUND')
          throw rpcError('SESSION_NOT_FOUND', { sessionId: input.sessionId })
      }
    const link = await pool.acquireSharedWorker()
    return link.command('session.view', input)
  })
}

/** Decodes the `[activity, key]` keyset position this lister issued for the previous page. */
export function recencyCursor(cursor: string | undefined): { at: string; key: string } | undefined {
  if (cursor === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(cursor)
  } catch {
    value = undefined
  }
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== 'string' ||
    typeof value[1] !== 'string'
  )
    throw rpcError('INVALID_PARAMS', { reason: 'session list cursor is malformed' })
  return { at: value[0], key: value[1] }
}
