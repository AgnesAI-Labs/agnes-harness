import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  isPersistenceTombstone,
  PERSISTENCE_SCAN_PAGE_MAX,
  type PersistenceEventRecord,
  type PersistenceIntegrityRow,
  type PersistenceLeaseClaim,
  type PersistenceOpenOptions,
  type PersistenceOpenResult,
  type PersistenceRegisterRow,
  type PersistenceScanQuery,
  type PersistenceSessionStore,
  type PersistenceTableStore,
  persistenceRegisterKey,
} from '@agnes/extension-api'
import { createOwnerTables } from './tables.js'

type StoredEvent = PersistenceEventRecord & { seq: number }
type Integrity = { mode: 'anchor' | 'chain'; previousDigest: string | null; digest: string }
type LogLine = { key: string; seq: number; event: PersistenceEventRecord; integrity?: Integrity }
type SessionRec = { createdAt: string; parentKey?: string; boundarySeq?: number }
type Lease = { runId: string; until: number; ttlMs: number }
type OpCell = { seq: number; data: unknown }
type StateFile = {
  sessions: Array<[string, SessionRec]>
  leases: Array<[string, Lease]>
  ops: Array<[string, Array<[string, OpCell]>]>
}

function fail(code: string, message: string): never {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  throw error
}

function copyInto<K, V>(target: Map<K, V>, source: Map<K, V>): void {
  if (target === source) return
  target.clear()
  for (const [key, value] of source) target.set(key, value)
}

/**
 * Append-only `events.jsonl` plus `state.json` for sessions, leases, and op cells. A failed state
 * write truncates the log back to the size it had before that commit. A torn last line is skipped
 * on the next open; a bad line before that is `E_STORAGE_FAULT`. Leases survive `close`, as they do
 * in SQLite. Package tables stay in the process.
 */
export function openJsonlStore(options: PersistenceOpenOptions): PersistenceSessionStore {
  const clock = options.clock ?? Date.now
  mkdirSync(options.dataDir, { recursive: true })
  const eventsPath = join(options.dataDir, 'events.jsonl')
  const statePath = join(options.dataDir, 'state.json')
  const sessions = new Map<string, SessionRec>()
  const leases = new Map<string, Lease>()
  const events = new Map<string, StoredEvent[]>()
  const integrity = new Map<string, Map<number, Integrity>>()
  const ops = new Map<string, Map<string, OpCell>>()
  const tables = new Map<string, PersistenceTableStore>()
  let closed = false

  for (const line of loadLog(eventsPath)) {
    const row: StoredEvent = { ...line.event, seq: line.seq }
    const list = events.get(line.key) ?? []
    list.push(row)
    events.set(line.key, list)
    if (line.integrity) {
      const rows = integrity.get(line.key) ?? new Map<number, Integrity>()
      rows.set(line.seq, line.integrity)
      integrity.set(line.key, rows)
    }
    if (!sessions.has(line.key)) sessions.set(line.key, { createdAt: new Date(clock()).toISOString() })
  }
  const state = loadState(statePath)
  for (const [key, session] of state.sessions) sessions.set(key, session)
  for (const [key, lease] of state.leases) leases.set(key, lease)
  for (const [key, cells] of state.ops) ops.set(key, new Map(cells))

  const guard = (): void => {
    if (closed) fail('E_CLOSED', 'persistence provider is closed')
  }
  const lastSeqOf = (key: string): number => {
    const own = events.get(key)
    if (own && own.length > 0) return own[own.length - 1]!.seq
    return sessions.get(key)?.boundarySeq ?? 0
  }
  const writeState = (
    nextSessions: Map<string, SessionRec>,
    nextLeases: Map<string, Lease>,
    nextOps: Map<string, Map<string, OpCell>>,
  ): void => {
    const body: StateFile = {
      sessions: [...nextSessions],
      leases: [...nextLeases],
      ops: [...nextOps].map(([key, cells]) => [key, [...cells]]),
    }
    const tmp = `${statePath}.tmp`
    writeFileSync(tmp, JSON.stringify(body))
    renameSync(tmp, statePath)
  }
  const persist = (
    nextSessions: Map<string, SessionRec>,
    nextLeases: Map<string, Lease>,
    nextOps: Map<string, Map<string, OpCell>>,
    lines: LogLine[],
  ): void => {
    const prior = existsSync(eventsPath) ? statSync(eventsPath).size : 0
    try {
      if (lines.length > 0)
        appendFileSync(eventsPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
      writeState(nextSessions, nextLeases, nextOps)
    } catch (error) {
      if (existsSync(eventsPath)) truncateSync(eventsPath, prior)
      throw error
    }
    copyInto(sessions, nextSessions)
    copyInto(leases, nextLeases)
    copyInto(ops, nextOps)
  }

  return {
    async open(key, claim): Promise<PersistenceOpenResult> {
      guard()
      const now = clock()
      const lease = leases.get(key)
      if (lease && lease.runId !== claim.writerRunId && lease.until >= now)
        fail('E_WRITER_LEASE', 'session held by another writer')
      const created = !sessions.has(key)
      const nextSessions = new Map(sessions)
      if (created) nextSessions.set(key, { createdAt: new Date(now).toISOString() })
      const nextLeases = new Map(leases)
      nextLeases.set(key, { runId: claim.writerRunId, until: now + claim.ttlMs, ttlMs: claim.ttlMs })
      persist(nextSessions, nextLeases, ops, [])
      const session = sessions.get(key)
      const parent =
        session?.parentKey !== undefined && session.boundarySeq !== undefined
          ? { key: session.parentKey, boundarySeq: session.boundarySeq }
          : undefined
      return {
        lastSeq: lastSeqOf(key),
        formatVersion: 1,
        ...(created ? { created: true } : {}),
        ...(parent ? { parent } : {}),
      }
    },
    async commit(key, tx) {
      guard()
      if (tx.opState && tx.events.length === 0)
        fail('E_STORAGE_FAULT', 'an op write needs at least one row in its batch')
      const held = computeHold(leases.get(key), tx.expectedWriterRunId, tx.claim, clock(), lastSeqOf(key))
      if (tx.expectedRegisterSeq) {
        const current = fold(key, events, ops).find(
          (row) =>
            row.register === tx.expectedRegisterSeq?.register && row.key === tx.expectedRegisterSeq.key,
        )
        if ((current?.seq ?? null) !== tx.expectedRegisterSeq.seq) fail('E_CAS', 'register seq mismatch')
      }
      let seq = lastSeqOf(key)
      const seqs = tx.events.map(() => ++seq)
      if (
        tx.integrity &&
        (tx.integrity.length !== tx.events.length ||
          tx.integrity.some((entry, index) => entry.seq !== seqs[index]))
      )
        fail('E_STORAGE_FAULT', 'integrity metadata does not match assigned sequences')
      const lines: LogLine[] = tx.events.map((event, index) => {
        const assigned = seqs[index] as number
        const meta = tx.integrity?.[index]
        return {
          key,
          seq: assigned,
          event: { ...event, seq: assigned },
          ...(meta
            ? { integrity: { mode: meta.mode, previousDigest: meta.previousDigest, digest: meta.digest } }
            : {}),
        }
      })
      const nextLeases = new Map(leases)
      nextLeases.set(key, held)
      const nextOps = new Map(ops)
      if (tx.opState) {
        const cells = new Map(nextOps.get(key) ?? [])
        cells.set(tx.opState.lane, { seq, data: tx.opState.data })
        nextOps.set(key, cells)
      }
      persist(sessions, nextLeases, nextOps, lines)
      events.set(key, [
        ...(events.get(key) ?? []),
        ...lines.map((line) => ({ ...line.event, seq: line.seq })),
      ])
      for (const line of lines) {
        if (!line.integrity) continue
        const rows = integrity.get(key) ?? new Map<number, Integrity>()
        rows.set(line.seq, line.integrity)
        integrity.set(key, rows)
      }
      return { firstSeq: seqs[0] ?? seq, seqs, ...(tx.opState ? { opState: { seq } } : {}) }
    },
    async renew(key, runId, claim) {
      guard()
      const next = new Map(leases)
      if (claim) next.set(key, computeHold(leases.get(key), runId, claim, clock(), lastSeqOf(key)))
      else {
        const lease = leases.get(key)
        if (!lease || lease.runId !== runId || lease.until < clock())
          fail('E_WRITER_LEASE', 'writer lease not held')
        next.set(key, { ...lease, until: clock() + lease.ttlMs })
      }
      persist(sessions, next, ops, [])
    },
    async release(key, runId) {
      guard()
      const lease = leases.get(key)
      if (!lease || lease.runId !== runId) return
      const next = new Map(leases)
      next.delete(key)
      persist(sessions, next, ops, [])
    },
    async scan(key, query) {
      guard()
      if (query.toSeq === undefined && query.limit === undefined)
        fail('E_SCAN_UNBOUNDED', 'scan needs toSeq or limit')
      if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit <= 0))
        fail('E_SCAN_UNBOUNDED', 'scan limit must be a positive integer')
      const rows = matching(key, query, sessions, events)
      if (query.limit !== undefined && query.limit <= PERSISTENCE_SCAN_PAGE_MAX)
        return rows.slice(0, query.limit)
      if (rows.length > PERSISTENCE_SCAN_PAGE_MAX)
        fail('E_SCAN_TRUNCATED', `scan matched more than ${PERSISTENCE_SCAN_PAGE_MAX} rows`)
      return rows
    },
    async scanIntegrity(key, query): Promise<PersistenceIntegrityRow[]> {
      guard()
      if (!Number.isSafeInteger(query.limit) || query.limit <= 0)
        fail('E_SCAN_UNBOUNDED', 'integrity scan needs a positive limit')
      const meta = integrity.get(key)
      return (events.get(key) ?? [])
        .filter((event) => event.seq >= query.fromSeq && event.seq <= query.toSeq)
        .slice(0, query.limit)
        .map((event) => ({ sessionKey: key, event, integrity: meta?.get(event.seq) ?? null }))
    },
    async registers(key) {
      guard()
      return fold(key, events, ops)
    },
    tables(owner) {
      guard()
      let store = tables.get(owner)
      if (!store) {
        store = createOwnerTables()
        tables.set(owner, store)
      }
      return store
    },
    async createChild(parentKey, boundarySeq, childKey) {
      guard()
      if (!sessions.has(parentKey) || boundarySeq > lastSeqOf(parentKey))
        fail('E_STORAGE_FAULT', 'boundary beyond parent')
      const existing = sessions.get(childKey)
      if (existing) {
        if (existing.parentKey === parentKey && existing.boundarySeq === boundarySeq) return
        fail('E_STORAGE_FAULT', 'child key exists')
      }
      const next = new Map(sessions)
      next.set(childKey, { createdAt: new Date(clock()).toISOString(), parentKey, boundarySeq })
      persist(next, leases, ops, [])
    },
    async discardNewSession(key, runId, claim) {
      guard()
      computeHold(leases.get(key), runId, claim, clock(), lastSeqOf(key))
      const kept: LogLine[] = []
      for (const [sessionKey, list] of events) {
        if (sessionKey === key) continue
        for (const event of list) {
          const meta = integrity.get(sessionKey)?.get(event.seq)
          kept.push({ key: sessionKey, seq: event.seq, event, ...(meta ? { integrity: meta } : {}) })
        }
      }
      const prior = existsSync(eventsPath) ? readFileSync(eventsPath) : undefined
      const nextSessions = new Map(sessions)
      const nextLeases = new Map(leases)
      const nextOps = new Map(ops)
      nextSessions.delete(key)
      nextLeases.delete(key)
      nextOps.delete(key)
      try {
        writeFileSync(
          eventsPath,
          kept.length === 0 ? '' : `${kept.map((line) => JSON.stringify(line)).join('\n')}\n`,
        )
        writeState(nextSessions, nextLeases, nextOps)
      } catch (error) {
        if (prior) writeFileSync(eventsPath, prior)
        throw error
      }
      copyInto(sessions, nextSessions)
      copyInto(leases, nextLeases)
      copyInto(ops, nextOps)
      events.delete(key)
      integrity.delete(key)
    },
    async close() {
      closed = true
    },
  }
}

function computeHold(
  lease: Lease | undefined,
  runId: string,
  claim: PersistenceLeaseClaim | undefined,
  now: number,
  seq: number,
): Lease {
  if (lease && lease.runId === runId && lease.until >= now) {
    return claim ? { ...lease, until: now + lease.ttlMs } : lease
  }
  if (!claim || (lease !== undefined && lease.runId !== runId) || seq !== claim.expectedLastSeq) {
    if (!lease || lease.runId !== runId || lease.until < now) fail('E_WRITER_LEASE', 'writer lease not held')
  }
  const next = claim as PersistenceLeaseClaim
  return { runId, until: now + next.ttlMs, ttlMs: next.ttlMs }
}

function fold(
  key: string,
  events: Map<string, StoredEvent[]>,
  ops: Map<string, Map<string, OpCell>>,
): PersistenceRegisterRow[] {
  const cells = new Map<string, PersistenceRegisterRow>()
  for (const event of events.get(key) ?? []) {
    if (!event.register) continue
    const cellKey = persistenceRegisterKey(event)
    const id = `${event.register}\u0000${cellKey}`
    if (isPersistenceTombstone(event.register, event.data)) cells.delete(id)
    else cells.set(id, { register: event.register, key: cellKey, seq: event.seq, data: event.data })
  }
  for (const [lane, cell] of ops.get(key) ?? []) {
    const id = `op.state\u0000${lane}`
    const existing = cells.get(id)
    if (existing && existing.seq > cell.seq) continue
    if (cell.data === null) cells.delete(id)
    else cells.set(id, { register: 'op.state', key: lane, seq: cell.seq, data: cell.data })
  }
  return [...cells.values()].sort(
    (left, right) => compare(left.register, right.register) || compare(left.key, right.key),
  )
}

function compare(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function matches(event: StoredEvent, query: PersistenceScanQuery): boolean {
  if (query.fromSeq !== undefined && event.seq < query.fromSeq) return false
  if (query.toSeq !== undefined && event.seq > query.toSeq) return false
  if (query.lane && (event.lane ?? 'main') !== query.lane) return false
  if (query.type !== undefined) {
    const types = typeof query.type === 'string' ? [query.type] : query.type
    if (!types.includes(event.type)) return false
  }
  return true
}

function matching(
  key: string,
  query: PersistenceScanQuery,
  sessions: Map<string, SessionRec>,
  events: Map<string, StoredEvent[]>,
): StoredEvent[] {
  const own = (events.get(key) ?? []).filter((event) => matches(event, query))
  const ordered = query.order === 'desc' ? [...own].reverse() : own
  const session = sessions.get(key)
  if (session?.parentKey === undefined || session.boundarySeq === undefined) return ordered
  const upper = query.toSeq === undefined ? session.boundarySeq : Math.min(query.toSeq, session.boundarySeq)
  const prefix = matching(session.parentKey, { ...query, toSeq: upper }, sessions, events)
  return query.order === 'desc' ? [...ordered, ...prefix] : [...prefix, ...ordered]
}

function loadLog(path: string): LogLine[] {
  if (!existsSync(path)) return []
  const text = readFileSync(path, 'utf8')
  if (text.length === 0) return []
  const ends = text.endsWith('\n')
  const body = ends ? text.slice(0, -1) : text
  const breakAt = ends ? -1 : body.lastIndexOf('\n')
  const complete = breakAt < 0 ? (ends ? body : '') : body.slice(0, breakAt)
  const trailing = breakAt < 0 ? (ends ? '' : body) : body.slice(breakAt + 1)
  const lines: LogLine[] = []
  if (complete.length > 0) {
    for (const line of complete.split('\n')) {
      if (line.length === 0) continue
      const parsed = readLine(line)
      if (parsed === undefined) fail('E_STORAGE_FAULT', 'persistence log line is unreadable')
      lines.push(parsed)
    }
  }
  if (trailing.length > 0) {
    const parsed = readLine(trailing)
    if (parsed) lines.push(parsed)
  }
  return lines
}

function readLine(line: string): LogLine | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null)
    fail('E_STORAGE_FAULT', 'persistence log line is unreadable')
  const lineValue = value as LogLine
  if (typeof lineValue.key !== 'string' || typeof lineValue.seq !== 'number' || lineValue.event === undefined)
    fail('E_STORAGE_FAULT', 'persistence log line is unreadable')
  return lineValue
}

function loadState(path: string): StateFile {
  if (!existsSync(path)) return { sessions: [], leases: [], ops: [] }
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as StateFile
    if (!Array.isArray(value.sessions) || !Array.isArray(value.leases) || !Array.isArray(value.ops))
      fail('E_STORAGE_FAULT', 'persistence state is unreadable')
    return value
  } catch (error) {
    if (error instanceof Error && (error as { code?: string }).code === 'E_STORAGE_FAULT') throw error
    fail('E_STORAGE_FAULT', 'persistence state is unreadable')
  }
}
