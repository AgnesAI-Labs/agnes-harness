import type { ScopedComparisonStore } from '@agnes/host'
import { rpcError } from '@agnes/protocol'
import type { ComparisonRecord, Side } from '@agnes/runtime-comparison'
import type { ComparisonLedgerReader } from './methods/comparison.js'

/** One source for every historical view; a released comparison never reopens live runtime data. */
function archivedReader(
  store: ScopedComparisonStore,
  record: ComparisonRecord,
  side: Side,
): ComparisonLedgerReader | undefined {
  if (record.retirement?.state === 'removed' || record.retirement?.state === 'removing')
    throw rpcError('SEMANTIC_REJECTED', { code: 'COMPARISON_RETIRED' })
  const archive = store.archive.read(record.id, side)
  if (!archive) {
    if (record.retirement?.state === 'released')
      throw rpcError('SEMANTIC_REJECTED', { code: 'HISTORY_UNAVAILABLE' })
    return undefined
  }
  const lane = record.lanes[side]
  if (
    !lane ||
    archive.manifest.sessionId !== lane.sessionId ||
    archive.manifest.epoch !== record.retirement?.epoch ||
    !['releasing', 'released'].includes(record.retirement.state)
  )
    throw rpcError('SEMANTIC_REJECTED', { code: 'HISTORY_UNAVAILABLE' })
  const tree = store.treeArchive.read(record.id, side)
  if (tree && (tree.proof.rootSessionKey !== lane.sessionId || tree.proof.epoch !== archive.manifest.epoch))
    throw rpcError('SEMANTIC_REJECTED', { code: 'HISTORY_UNAVAILABLE' })
  const source = (sessionId: string) => {
    if (sessionId === lane.sessionId) return archive.rows
    const member = tree?.members.find((item) => item.sessionKey === sessionId)
    if (!member) throw rpcError('CAPABILITY_DENIED')
    return member.rows
  }
  return {
    async head(sessionId) {
      return source(sessionId).length
    },
    async scan(sessionId, query) {
      const rows = source(sessionId)
      const types = query.type ? (Array.isArray(query.type) ? query.type : [query.type]) : undefined
      const events = rows
        .map((row) => row.event)
        .filter(
          (event) =>
            event.seq >= (query.fromSeq ?? 1) &&
            event.seq <= (query.toSeq ?? rows.length) &&
            (!query.lane || event.lane === query.lane) &&
            (!types || types.includes(event.type)),
        )
      if (query.order === 'desc') events.reverse()
      return structuredClone(events.slice(0, query.limit ?? events.length))
    },
  }
}

/** Pin an immutable archive when available. If release removes live rows during a read,
 * retry that same bounded query against the newly published archive, never a live head. */
export function comparisonArchiveReader(
  store: ScopedComparisonStore,
  record: ComparisonRecord,
  side: Side,
  live?: ComparisonLedgerReader,
): ComparisonLedgerReader {
  let pinned: ComparisonLedgerReader | undefined
  async function resolve(retry = true): Promise<ComparisonLedgerReader> {
    if (pinned) return pinned
    const current = await store.read(record.id)
    const before = record.lanes[side]
    const after = current?.lanes[side]
    if (
      !current ||
      !before ||
      !after ||
      before.sessionId !== after.sessionId ||
      before.runtime.id !== after.runtime.id ||
      before.runtime.version !== after.runtime.version
    )
      throw rpcError('SEMANTIC_REJECTED', { code: 'HISTORY_UNAVAILABLE' })
    try {
      pinned = archivedReader(store, current, side)
    } catch (error) {
      // A release may publish between the awaited record read and the archive read.
      // Retry once only when the durable record changed, retaining all identity checks.
      if (retry && (await store.read(record.id))?.revision !== current.revision) return resolve(false)
      throw error
    }
    if (pinned) return pinned
    if (!live) throw rpcError('CAPABILITY_DENIED', { reason: 'comparison ledger reader unavailable' })
    return live
  }
  async function read<T>(
    operation: (source: ComparisonLedgerReader) => Promise<T>,
    empty: (value: T) => boolean,
  ): Promise<T> {
    const source = await resolve()
    try {
      const value = await operation(source)
      if (source === live && empty(value)) {
        const next = await resolve()
        if (next !== source) return operation(next)
      }
      return value
    } catch (error) {
      if (source !== live) throw error
      const next = await resolve()
      if (next === source) throw error
      return operation(next)
    }
  }
  return {
    head: (id) =>
      read(
        (source) => source.head(id),
        (value) => value === 0,
      ),
    scan: (id, query) =>
      read(
        (source) => source.scan(id, query),
        (value) => value.length === 0,
      ),
  }
}
