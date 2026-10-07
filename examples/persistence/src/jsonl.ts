import {
  isPersistenceTombstone,
  PERSISTENCE_SCAN_PAGE_MAX,
  type PersistenceEventRecord,
  type PersistenceLeaseClaim,
  type PersistenceOpenOptions,
  type PersistenceRegisterRow,
  type PersistenceScanQuery,
  type PersistenceSessionStore,
  persistenceRegisterKey,
} from '@agnes/extension-api'
import { childControl } from './children.js'
import { fail, identity, Journal } from './journal.js'

type Session = { parent?: { key: string; boundarySeq: number }; lastSeq: number }
type Lease = { runId: string; until: number; ttlMs: number }
type Row = {
  event: PersistenceEventRecord & { seq: number }
  integrity: { mode: 'anchor' | 'chain'; previousDigest: string | null; digest: string } | null
}
export function openJsonlStore(options: PersistenceOpenOptions): PersistenceSessionStore {
  const db = new Journal(options.dataDir)
  const clock = options.clock ?? Date.now
  const session = (key: string): Session | undefined => db.get(identity('session', key))
  const last = (key: string): number => session(key)?.lastSeq ?? 0
  const rows = (key: string): Row[] =>
    db
      .entries<Row>()
      .filter(([id]) => {
        const parts = JSON.parse(id) as unknown[]
        return parts[0] === 'event' && parts[1] === key
      })
      .map(([, row]) => row)
      .sort((a, b) => a.event.seq - b.event.seq)
  const registers = (key: string): PersistenceRegisterRow[] =>
    db
      .entries<PersistenceRegisterRow>()
      .filter(([id]) => {
        const parts = JSON.parse(id) as unknown[]
        return parts[0] === 'register' && parts[1] === key
      })
      .map(([, row]) => row)
      .sort((a, b) =>
        a.register < b.register
          ? -1
          : a.register > b.register
            ? 1
            : a.key < b.key
              ? -1
              : a.key > b.key
                ? 1
                : 0,
      )
  const hold = (key: string, runId: string, claim?: PersistenceLeaseClaim): Lease => {
    const lease = db.get<Lease>(identity('lease', key))
    const now = clock()
    if (lease?.runId === runId && lease.until >= now)
      return claim ? { ...lease, until: now + lease.ttlMs } : lease
    if (!claim || (lease && lease.runId !== runId) || last(key) !== claim.expectedLastSeq)
      fail('E_WRITER_LEASE', 'writer lease not held')
    return { runId, until: now + claim.ttlMs, ttlMs: claim.ttlMs }
  }
  const create = (parentKey: string, boundarySeq: number, childKey: string): void => {
    if (
      !session(parentKey) ||
      !Number.isSafeInteger(boundarySeq) ||
      boundarySeq < 0 ||
      boundarySeq > last(parentKey)
    )
      fail('E_STORAGE_FAULT', 'invalid parent boundary')
    const existing = session(childKey)
    if (existing) {
      if (existing.parent?.key === parentKey && existing.parent.boundarySeq === boundarySeq) return
      fail('E_STORAGE_FAULT', 'child session exists')
    }
    db.set(identity('session', childKey), { parent: { key: parentKey, boundarySeq }, lastSeq: boundarySeq })
  }
  const visible = (key: string, query: PersistenceScanQuery): Row[] => {
    const own = rows(key).filter(
      ({ event }) =>
        (query.fromSeq === undefined || event.seq >= query.fromSeq) &&
        (query.toSeq === undefined || event.seq <= query.toSeq),
    )
    const parent = session(key)?.parent
    const prefix = parent
      ? visible(parent.key, { ...query, toSeq: Math.min(query.toSeq ?? Infinity, parent.boundarySeq) })
      : []
    return [...prefix, ...own]
  }
  const children = childControl(db, clock, { exists: (key) => !!session(key), create })
  return {
    async open(key, claim) {
      return db.transaction(() => {
        const lease = db.get<Lease>(identity('lease', key))
        if (lease && lease.runId !== claim.writerRunId && lease.until >= clock())
          fail('E_WRITER_LEASE', 'session held by another writer')
        const created = !session(key)
        if (created) db.set(identity('session', key), { lastSeq: 0 })
        db.set(identity('lease', key), {
          runId: claim.writerRunId,
          until: clock() + claim.ttlMs,
          ttlMs: claim.ttlMs,
        })
        const parent = session(key)?.parent
        return {
          lastSeq: last(key),
          formatVersion: 1,
          ...(created ? { created: true } : {}),
          ...(parent ? { parent } : {}),
        }
      })
    },
    async commit(key, tx) {
      return db.transaction(() => {
        const lease = hold(key, tx.expectedWriterRunId, tx.claim)
        if (tx.opState && !tx.events.length) fail('E_STORAGE_FAULT', 'op write requires a nonempty batch')
        if (tx.expectedRegisterSeq) {
          const { register, key: cellKey, seq } = tx.expectedRegisterSeq
          if (
            (db.get<PersistenceRegisterRow>(identity('register', key, register, cellKey))?.seq ?? null) !==
            seq
          )
            fail('E_CAS', 'register seq mismatch')
        }
        let seq = last(key)
        const firstSeq = tx.events.length ? seq + 1 : seq
        if (
          tx.integrity &&
          (tx.integrity.length !== tx.events.length || tx.integrity.some((row, i) => row.seq !== seq + i + 1))
        )
          fail('E_STORAGE_FAULT', 'integrity sequence mismatch')
        const seqs: number[] = []
        for (const [index, event] of tx.events.entries()) {
          seq++
          seqs.push(seq)
          const meta = tx.integrity?.[index]
          db.set(identity('event', key, seq), {
            event: { ...event, seq },
            integrity: meta
              ? { mode: meta.mode, previousDigest: meta.previousDigest, digest: meta.digest }
              : null,
          })
          if (event.register) {
            const cellKey = persistenceRegisterKey(event)
            const id = identity('register', key, event.register, cellKey)
            if (isPersistenceTombstone(event.register, event.data)) db.delete(id)
            else db.set(id, { register: event.register, key: cellKey, seq, data: event.data })
          }
        }
        if (tx.opState) {
          const id = identity('register', key, 'op.state', tx.opState.lane)
          if (tx.opState.data === null) db.delete(id)
          else db.set(id, { register: 'op.state', key: tx.opState.lane, seq, data: tx.opState.data })
        }
        db.set(identity('session', key), { ...session(key), lastSeq: seq })
        db.set(identity('lease', key), lease)
        return { firstSeq, seqs, ...(tx.opState ? { opState: { seq } } : {}) }
      })
    },
    async renew(key, runId, claim) {
      db.transaction(() => {
        const lease = hold(key, runId, claim)
        db.set(identity('lease', key), { ...lease, until: clock() + lease.ttlMs })
      })
    },
    async release(key, runId) {
      db.transaction(() => {
        if (db.get<Lease>(identity('lease', key))?.runId === runId) db.delete(identity('lease', key))
      })
    },
    async registers(key) {
      return registers(key)
    },
    async scan(key, query) {
      db.guard()
      if (query.toSeq === undefined && query.limit === undefined)
        fail('E_SCAN_UNBOUNDED', 'scan needs toSeq or limit')
      if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit <= 0))
        fail('E_SCAN_UNBOUNDED', 'invalid limit')
      let matching = visible(key, query)
        .map(({ event }) => event)
        .filter(
          (event) =>
            (!query.lane || (event.lane ?? 'main') === query.lane) &&
            (query.type === undefined ||
              (typeof query.type === 'string' ? [query.type] : query.type).includes(event.type)),
        )
      if (query.order === 'desc') matching = matching.reverse()
      if (query.limit !== undefined && query.limit <= PERSISTENCE_SCAN_PAGE_MAX)
        return matching.slice(0, query.limit)
      if (matching.length > PERSISTENCE_SCAN_PAGE_MAX) fail('E_SCAN_TRUNCATED', 'full read exceeds page cap')
      return matching
    },
    async scanIntegrity(key, query) {
      if (!Number.isSafeInteger(query.limit) || query.limit <= 0)
        fail('E_SCAN_UNBOUNDED', 'invalid integrity limit')
      return rows(key)
        .filter(({ event }) => event.seq >= query.fromSeq && event.seq <= query.toSeq)
        .slice(0, query.limit)
        .map((row) => ({ sessionKey: key, ...row }))
    },
    async createChild(parentKey, boundarySeq, childKey) {
      db.transaction(() => create(parentKey, boundarySeq, childKey))
    },
    async discardNewSession(key, runId, claim) {
      db.transaction(() => {
        hold(key, runId, claim)
        for (const [id] of db.entries()) {
          const parts = JSON.parse(id) as unknown[]
          if (['session', 'lease', 'event', 'register'].includes(String(parts[0])) && parts[1] === key)
            db.delete(id)
        }
      })
    },
    metadata: {
      namespace(owner, name) {
        const prefix = ['metadata', owner, name]
        return {
          get: (key) => db.get(identity(...prefix, key)),
          set: (key, value) => db.set(identity(...prefix, key), value),
          delete: (key) => db.delete(identity(...prefix, key)),
          entries: () =>
            db
              .entries()
              .filter(([id]) => {
                const parts = JSON.parse(id) as string[]
                return parts[0] === 'metadata' && parts[1] === owner && parts[2] === name
              })
              .map(([id, value]) => ({ key: stringPart(id, 3), value }))
              .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
          transaction: (fn) => db.transaction(fn),
        }
      },
    },
    childControl: {
      ...children,
      async clearWriterLease(key) {
        db.delete(identity('lease', key))
      },
    },
    reclaim: {
      listExpired(now) {
        return db
          .entries<Lease>()
          .filter(([id, lease]) => (JSON.parse(id) as string[])[0] === 'lease' && lease.until < now)
          .map(([id, lease]) => ({
            sessionKey: stringPart(id, 1),
            runId: lease.runId,
            until: lease.until,
            generation: db.get<number>(identity('generation', (JSON.parse(id) as string[])[1])) ?? 1,
          }))
      },
      claimForReclaim(key, runId, until, now) {
        return db.transaction(() => {
          const lease = db.get<Lease>(identity('lease', key))
          if (!lease || lease.runId !== runId || lease.until !== until || lease.until >= now) return null
          const cell = registers(key).find((row) => row.register === 'op.state')
          if (!cell) db.delete(identity('lease', key))
          return { seq: last(key), opState: cell ? { seq: cell.seq, data: cell.data } : undefined }
        })
      },
    },
    async close() {
      db.close()
    },
  }
}

function stringPart(id: string, index: number): string {
  const value: unknown = (JSON.parse(id) as unknown[])[index]
  if (typeof value !== 'string') fail('E_STORAGE_FAULT', 'invalid journal key')
  return value
}
