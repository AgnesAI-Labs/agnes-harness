import type { CallContext, LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { type createSqliteStorage, readStoredSessionView, type ScanRead } from '@agnes/host'
import {
  type EventEnvelope,
  rpcError,
  SESSION_ARTIFACT_ROOT_EVENT_TYPES,
  type SessionRuntimeParams,
  type SessionViewParams,
  sessionArtifactRoots,
  validateEvent,
} from '@agnes/protocol'
import type { TrustedArtifactHistory } from './artifact-authority-projection.js'
import type { WorkerPool } from './worker-pool.js'

/** A recorded session's view read from the daemon's own ledger connection. */
export type SessionViewRead = (
  sessionId: string,
  options: { maxNodes?: number; signal?: AbortSignal },
) => Promise<unknown>

const MAX_RETAINED_ARTIFACT_ROOTS = 4096
const MAX_SINGLE_EVENT_BYTES = 4 * 1024 * 1024
const MAX_SCANNED_CANDIDATE_ROWS = 250_000

/** Bounded, read-only roots from the daemon-owned ledger; never opens a worker or writer lease. */
export function artifactHistoryReader(
  read: (sessionId: string) => ScanRead<EventEnvelope>,
): TrustedArtifactHistory {
  return Object.freeze({
    async read(sessionId, laneId, signal) {
      const scan = read(sessionId)
      const rows: EventEnvelope[] = []
      const seenRoots = new Map<string, number | undefined>()
      let fromSeq = 1,
        scanned = 0,
        pages = 0
      const check = () => {
        if (signal.aborted) throw new Error('artifact history unavailable')
      }
      check()
      const head = (await scan({ order: 'desc', limit: 1 }))[0]?.seq ?? 0
      if (!Number.isSafeInteger(head) || head < 0) throw new Error('artifact history unavailable')
      while (fromSeq <= head) {
        check()
        if (++pages % 20 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
        check()
        const page = await scan({
          fromSeq,
          toSeq: head,
          lane: laneId,
          type: [...SESSION_ARTIFACT_ROOT_EVENT_TYPES],
          order: 'asc',
          limit: 100,
        })
        check()
        scanned += page.length
        if (page.length > 100 || scanned > MAX_SCANNED_CANDIDATE_ROWS)
          throw new Error('artifact history unavailable')
        for (const row of page) {
          if (!Number.isSafeInteger(row.seq) || row.seq < fromSeq || row.seq > head)
            throw new Error('artifact history unavailable')
          fromSeq = row.seq + 1
          if ((row.lane ?? 'main') !== laneId) continue
          if (Buffer.byteLength(JSON.stringify(row), 'utf8') > MAX_SINGLE_EVENT_BYTES)
            throw new Error('artifact history unavailable')
          const checked = validateEvent(row)
          if (!checked.ok) throw new Error('artifact history unavailable')
          const roots = sessionArtifactRoots(checked.value as EventEnvelope)
          if (!roots?.length) continue
          let keep = false
          for (const ref of roots) {
            const identity = `${ref.sha256}:${ref.mime}`
            if (!seenRoots.has(identity)) {
              seenRoots.set(identity, ref.size)
              keep = true
            } else {
              const prev = seenRoots.get(identity)
              if (prev === undefined && ref.size !== undefined) {
                seenRoots.set(identity, ref.size)
                keep = true
              } else if (prev !== undefined && ref.size !== undefined && prev !== ref.size) {
                keep = true
              }
            }
            if (seenRoots.size > MAX_RETAINED_ARTIFACT_ROOTS) throw new Error('artifact history unavailable')
          }
          if (keep) rows.push(row)
        }
        if (page.length < 100) break
      }
      check()
      return rows
    },
  })
}

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
