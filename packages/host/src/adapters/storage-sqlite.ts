import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  type ChildControlStore,
  type CommitTx,
  CoreError,
  type Event,
  type FoldCacheRecord,
  type IntegrityRow,
  type IntegrityScanQuery,
  type LeaseClaim,
  type OpenResult,
  type RegisterRow,
  registerKey,
  SCAN_PAGE_MAX,
  type ScanQuery,
  type SessionKey,
  type StorageAdapter,
  scanTruncated,
} from '@agnes/core'
import { assertSessionTreeTableName } from '../session-tree-schema.js'
import { sqliteChildControl } from './child-control-sqlite.js'
import { DDL } from './ddl.js'
import { assertOwnedSql, confineToOwnFile } from './sql-guard.js'

// Re-exported from the module that uses it: a caller wanting the schema reaches for the storage
// adapter, not for a file whose name it would have to know.
export { DDL } from './ddl.js'

/** The value kinds SQLite can carry in a bound parameter. */
export type SqlParam = null | number | bigint | string | Uint8Array

export type TableHandle = {
  name: string
  exec(sql: string): void
  run(sql: string, params?: readonly unknown[]): { changes: number }
  all<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): T[]
  get<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): T | undefined
  transaction<T>(fn: () => T): T
}
export type TableStore = { table(name: string): TableHandle }
export type CrashReclaimClaim = {
  sessionKey: string
  runId: string
  until: number
  generation: number
}
/**
 * The only core-ledger access the daemon supervisor receives. It deliberately exposes operations,
 * not a SQL handle: package table isolation remains intact while crash recovery can inspect and
 * release an expired writer claim without opening a second unrestricted connection.
 */
export type CrashReclaimStore = {
  listExpired(now: number): CrashReclaimClaim[]
  /**
   * Null unless the claim is still the expired row the listing saw. Otherwise reports the open turn
   * on any lane, and deletes the claim, still conditioned on that row, when there is none. The check,
   * the read and the delete share one transaction, so a writer taking its lease back cannot land
   * between them.
   */
  claimForReclaim(
    sessionKey: string,
    runId: string,
    until: number,
    now: number,
  ): { opState: { seq: number; data: unknown } | undefined; seq: number } | null
}
export interface SqliteStorage extends StorageAdapter, ChildControlStore {
  readonly file: string
  /**
   * A package's own tables, on its own connection. A separate file is not by itself an isolation
   * story: SQL reaching a handle could name a second file with ATTACH and read the ledger or
   * another package's store, so every statement is refused before it can — textually by the keyword
   * gate in `sql-guard.ts`, and again inside SQLite by an authorizer on the connection. Both layers
   * are present on every runtime this package supports: the authorizer needs Node 24.10, which
   * `engines` requires, and its absence is refused at assembly rather than skipped. What remains
   * reachable is the owner's own file. The file name carries the whole owner id reversibly, so it
   * is one owner per file rather than a name that merely tends not to repeat.
   */
  tables(owner: string): TableStore
  discardNewSession(key: SessionKey, expectedWriterRunId: string, claim?: LeaseClaim): Promise<void>
  readonly crashReclaim: CrashReclaimStore
  coreTableNames(): string[]
  journalMode(): string
}

const TABLE_NAME = /^[a-z][a-z0-9_]{0,63}$/
const MAX_LIMIT = SCAN_PAGE_MAX

type Row = {
  session_key: string
  seq: number
  ts: string
  id: string
  lane: Uint8Array
  type: string
  v: number
  actor: string
  origin: string
  trust: string
  register: string | null
  ignorable: number | null
  surface_op: string | null
  source_event_seqs: string | null
  data: string
  integrity_mode: string | null
  integrity_prev: string | null
  integrity_digest: string | null
}

/**
 * Whether a register write erases its cell. This mirrors the rule the in-memory reference
 * implementation applies; the shared contract suite runs both adapters through it, so the two
 * cannot drift apart without a test going red.
 */
function isTombstone(register: string, data: unknown): boolean {
  if (data === null) return true
  return (
    register === 'harness/entry' &&
    typeof data === 'object' &&
    (data as { tombstone?: unknown }).tombstone === true
  )
}

// A caller reaching a table handle passes plain values, so the conversion is checked rather than
// cast: an object arriving here is a caller bug, and a stated refusal beats whatever the driver
// would make of it.
function toSqlParams(params: readonly unknown[]): SqlParam[] {
  return params.map((p, i) => {
    if (typeof p === 'string') {
      if (p.includes('\u0000'))
        throw new TypeError(`bind parameter ${i} contains NUL, unsafe for SQLite TEXT`)
      return p
    }
    if (p === null || typeof p === 'number' || typeof p === 'bigint' || p instanceof Uint8Array) return p
    throw new TypeError(`bind parameter ${i} is not a value SQLite can carry: ${typeof p}`)
  })
}

// A register cell key and a lane travel as bytes. See the DDL: a TEXT round-trip truncates either
// at the NUL that joins a harness/entry cell's two halves.
//
// The encoding is WTF-8, not UTF-8, and the difference is one JavaScript strings force on anyone
// storing them. A key half comes out of event data, which is JSON from a model or an extension, and
// JSON admits a lone surrogate: `Buffer.from('\ud800', 'utf8')` replaces it with U+FFFD, so two
// distinct ids differing only in their surrogate merged into one cell here while staying apart in
// the in-memory reference. WTF-8 encodes an unpaired surrogate as its own three bytes, so every
// string a JavaScript engine can hold survives the round trip. Well-formed text encodes exactly as
// UTF-8 does, so this is not a second encoding for anything that already worked.
function keyBytes(key: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < key.length; i++) {
    let cp = key.charCodeAt(i)
    const next = key.charCodeAt(i + 1)
    if (cp >= 0xd800 && cp <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      cp = 0x10000 + ((cp - 0xd800) << 10) + (next - 0xdc00)
      i++
    }
    if (cp < 0x80) out.push(cp)
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f))
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
    else
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
  }
  return Uint8Array.from(out)
}
function keyText(key: Uint8Array): string {
  let out = ''
  for (let i = 0; i < key.length; ) {
    const b = key[i] as number
    const len = b < 0x80 ? 1 : b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4
    let cp = len === 1 ? b : b & (len === 2 ? 0x1f : len === 3 ? 0x0f : 0x07)
    for (let j = 1; j < len; j++) cp = (cp << 6) | ((key[i + j] as number) & 0x3f)
    // fromCharCode, not fromCodePoint: a lone surrogate is not a code point, and fromCodePoint
    // refuses it. Everything else in range is the same value either way.
    out += cp <= 0xffff ? String.fromCharCode(cp) : String.fromCodePoint(cp)
    i += len
  }
  return out
}

// The file name has to be one-to-one. Two owners sharing a file share their tables, which is a
// cross-package read and write with no SQL in it at all — no ATTACH, neither containment layer
// touched. The previous derivation, `owner.replace(/[^a-z0-9._-]/g, '_')`, was not one-to-one:
// upper case is an unsafe character there, so `@A/x` and `@_/x` both became `___x`.
//
// Every byte outside the safe set becomes `_` followed by its two lower-case hex digits, and `_`
// escapes itself, so the mapping is decodable and therefore injective by construction rather than
// by an assumption about which owners exist. The bytes are the same WTF-8 `keyBytes` produces, so an
// owner carrying a lone surrogate is distinguished too. Output is lower case throughout, which keeps
// two owners from colliding on a case-insensitive filesystem as well. An owner long enough to
// overrun the platform's name limit fails to open the file, which is a refusal, not a shared file.
const OWNER_SAFE = /[a-z0-9.-]/
export function ownerFile(owner: string): string {
  let out = ''
  for (const b of keyBytes(owner)) {
    const c = String.fromCharCode(b)
    out += b < 0x80 && c !== '_' && OWNER_SAFE.test(c) ? c : `_${b.toString(16).padStart(2, '0')}`
  }
  return out
}

function rowToEvent(r: Row): Event {
  return {
    seq: r.seq,
    ts: r.ts,
    id: r.id,
    type: r.type,
    lane: keyText(r.lane),
    v: r.v,
    actor: JSON.parse(r.actor),
    origin: r.origin,
    trust: r.trust as Event['trust'],
    data: JSON.parse(r.data),
    ...(r.register ? { register: r.register } : {}),
    ...(r.ignorable ? { ignorable: true as const } : {}),
    ...(r.surface_op ? { surfaceOp: JSON.parse(r.surface_op) } : {}),
    ...(r.source_event_seqs ? { sourceEventSeqs: JSON.parse(r.source_event_seqs) } : {}),
  } as Event
}

function rowToIntegrity(r: Row): IntegrityRow {
  let event: Event
  try {
    event = rowToEvent(r)
  } catch {
    throw new CoreError('E_LEDGER_INTEGRITY', 'stored event cannot be decoded', { seq: r.seq })
  }
  const empty = r.integrity_mode === null && r.integrity_prev === null && r.integrity_digest === null
  if (empty) return { sessionKey: r.session_key, event, integrity: null }
  if ((r.integrity_mode !== 'anchor' && r.integrity_mode !== 'chain') || r.integrity_digest === null)
    throw new CoreError('E_LEDGER_INTEGRITY', 'malformed stored integrity metadata', { seq: r.seq })
  return {
    sessionKey: r.session_key,
    event,
    integrity: {
      mode: r.integrity_mode,
      previousDigest: r.integrity_prev,
      digest: r.integrity_digest,
    },
  }
}

export function createSqliteStorage(opts: {
  file: string
  clock?: () => number
  tablesDir?: string
}): SqliteStorage {
  const db = new DatabaseSync(opts.file)
  const tablesDir = opts.tablesDir ?? join(dirname(opts.file), 'tables')
  const owned = new Map<string, DatabaseSync>()
  let closed = false
  const clock = opts.clock ?? (() => Date.now())
  // Another process (the artifact GC, a second daemon) may hold the write lock briefly: wait for it
  // instead of failing the commit. The wait is synchronous and blocks this thread for up to 5 s.
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')
  for (const ddl of DDL) db.exec(ddl)
  const eventColumns = new Set(
    (db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>).map((column) => column.name),
  )
  for (const [name, declaration] of [
    ['integrity_mode', 'TEXT'],
    ['integrity_prev', 'TEXT'],
    ['integrity_digest', 'TEXT'],
  ] as const) {
    if (!eventColumns.has(name)) db.exec(`ALTER TABLE events ADD COLUMN ${name} ${declaration}`)
  }
  const childTaskColumns = new Set(
    (db.prepare('PRAGMA table_info(child_tasks)').all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  )
  if (!childTaskColumns.has('input_text'))
    db.exec(`ALTER TABLE child_tasks ADD COLUMN input_text TEXT NOT NULL DEFAULT ''`)
  for (const [name, declaration] of [
    ['attempt_id', 'TEXT'],
    ['creation_phase', 'TEXT'],
    ['creation_revision', 'INTEGER'],
    ['attempt_started_at', 'INTEGER'],
    ['deferred_fact', 'TEXT'],
    ['cancelled_fact', 'TEXT'],
  ] as const) {
    if (!childTaskColumns.has(name)) db.exec(`ALTER TABLE child_tasks ADD COLUMN ${name} ${declaration}`)
  }
  db.exec(`UPDATE child_tasks
    SET attempt_id = COALESCE(attempt_id, 'legacy:' || creation_id),
        creation_phase = COALESCE(creation_phase, 'committed'),
        creation_revision = COALESCE(creation_revision, 1),
        attempt_started_at = COALESCE(attempt_started_at, 0),
        control_format = CASE WHEN control_format < 4 THEN 4 ELSE control_format END
    WHERE attempt_id IS NULL OR creation_phase IS NULL OR creation_revision IS NULL OR attempt_started_at IS NULL
       OR control_format < 4`)
  const workspaceColumns = new Set(
    (db.prepare('PRAGMA table_info(child_workspaces)').all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  )
  if (!workspaceColumns.has('root')) db.exec(`ALTER TABLE child_workspaces ADD COLUMN root TEXT`)
  if (!workspaceColumns.has('branch')) db.exec(`ALTER TABLE child_workspaces ADD COLUMN branch TEXT`)
  // The UI projection is rebuilt from the verified ledger on every open; its old cache table goes.
  db.exec('DROP TABLE IF EXISTS ui_projection_cache')
  const q = {
    lease: db.prepare('SELECT run_id, until, ttl_ms FROM writer_claims WHERE session_key = ?'),
    upsertLease: db.prepare(
      'INSERT INTO writer_claims (session_key, run_id, until, ttl_ms, generation) VALUES (?, ?, ?, ?, 1) ON CONFLICT(session_key) DO UPDATE SET run_id = excluded.run_id, until = excluded.until, ttl_ms = excluded.ttl_ms, generation = generation + CASE WHEN writer_claims.run_id = excluded.run_id THEN 0 ELSE 1 END',
    ),
    renew: db.prepare('UPDATE writer_claims SET until = ? WHERE session_key = ? AND run_id = ?'),
    release: db.prepare('DELETE FROM writer_claims WHERE session_key = ? AND run_id = ?'),
    session: db.prepare(
      'SELECT format_version, parent_key, boundary_seq FROM sessions WHERE session_key = ?',
    ),
    insertSession: db.prepare(
      'INSERT OR IGNORE INTO sessions (session_key, format_version, parent_key, boundary_seq, created_at) VALUES (?, 1, ?, ?, ?)',
    ),
    insertChildSession: db.prepare(
      'INSERT INTO sessions (session_key, format_version, parent_key, boundary_seq, created_at) VALUES (?, 1, ?, ?, ?)',
    ),
    lastSeq: db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM events WHERE session_key = ?'),
    insertEvent: db.prepare(
      'INSERT INTO events (session_key, seq, ts, id, type, lane, v, actor, origin, trust, register, ignorable, surface_op, source_event_seqs, data, integrity_mode, integrity_prev, integrity_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ),
    registerSeq: db.prepare('SELECT seq FROM registers WHERE session_key = ? AND register = ? AND key = ?'),
    upsertRegister: db.prepare(
      'INSERT INTO registers (session_key, register, key, seq, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_key, register, key) DO UPDATE SET seq = excluded.seq, data = excluded.data',
    ),
    deleteRegister: db.prepare('DELETE FROM registers WHERE session_key = ? AND register = ? AND key = ?'),
    registers: db.prepare(
      'SELECT register, key, seq, data FROM registers WHERE session_key = ? ORDER BY register, key',
    ),
    expiredClaims: db.prepare(
      'SELECT session_key, run_id, until, generation FROM writer_claims WHERE until < ? ORDER BY until',
    ),
    opStates: db.prepare(
      'SELECT seq, data FROM registers WHERE session_key = ? AND register = ? ORDER BY seq DESC',
    ),
    releaseExpired: db.prepare(
      'DELETE FROM writer_claims WHERE session_key = ? AND run_id = ? AND until = ? AND until < ?',
    ),
    foldCache: db.prepare(
      'SELECT version, seq, payload, checksum, integrity_last_seq, legacy_through_seq, head_digest FROM fold_cache WHERE session_key = ?',
    ),
    upsertFoldCache: db.prepare(
      'INSERT INTO fold_cache (session_key, version, seq, payload, checksum, integrity_last_seq, legacy_through_seq, head_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_key) DO UPDATE SET version = excluded.version, seq = excluded.seq, payload = excluded.payload, checksum = excluded.checksum, integrity_last_seq = excluded.integrity_last_seq, legacy_through_seq = excluded.legacy_through_seq, head_digest = excluded.head_digest',
    ),
    deleteEvents: db.prepare('DELETE FROM events WHERE session_key = ?'),
    deleteRegisters: db.prepare('DELETE FROM registers WHERE session_key = ?'),
    deleteFoldCache: db.prepare('DELETE FROM fold_cache WHERE session_key = ?'),
    deleteLease: db.prepare('DELETE FROM writer_claims WHERE session_key = ? AND run_id = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE session_key = ?'),
  }
  const tx = <T>(fn: () => T): T => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const r = fn()
      db.exec('COMMIT')
      return r
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }

  function assertLease(key: SessionKey, runId: string): void {
    const l = q.lease.get(key) as { run_id: string; until: number } | undefined
    if (!l || l.run_id !== runId || l.until < clock())
      throw new CoreError('E_WRITER_LEASE', 'writer lease not held', {
        expected: l?.run_id ?? null,
        actual: runId,
      })
  }
  // Renew on write: a held lease is extended; a lapsed or missing one is taken back only while no
  // other writer has the row and nothing was written since `claim.expectedLastSeq`.
  function holdLease(key: SessionKey, runId: string, claim: LeaseClaim | undefined): void {
    const l = q.lease.get(key) as { run_id: string; until: number; ttl_ms: number } | undefined
    if (l?.run_id === runId && l.until >= clock()) {
      if (claim) q.renew.run(clock() + l.ttl_ms, key, runId)
      return
    }
    if (!claim || (l && l.run_id !== runId) || lastSeq(key) !== claim.expectedLastSeq) assertLease(key, runId)
    q.upsertLease.run(key, runId, clock() + (claim as LeaseClaim).ttlMs, (claim as LeaseClaim).ttlMs)
  }
  function parentOf(key: SessionKey): { key: SessionKey; boundarySeq: number } | undefined {
    const s = q.session.get(key) as { parent_key: string | null; boundary_seq: number | null } | undefined
    return s?.parent_key ? { key: s.parent_key, boundarySeq: s.boundary_seq as number } : undefined
  }
  function lastSeq(key: SessionKey): number {
    const own = (q.lastSeq.get(key) as { s: number }).s
    if (own > 0) return own
    return parentOf(key)?.boundarySeq ?? 0
  }
  /** Up to `take` matching rows, the parent prefix included; the caller decides what `take` means. */
  function scanRows(key: SessionKey, qy: ScanQuery, take: number): Event[] {
    const parent = parentOf(key)
    const where: string[] = ['session_key = ?']
    const params: SqlParam[] = [key]
    if (qy.fromSeq !== undefined) {
      where.push('seq >= ?')
      params.push(qy.fromSeq)
    }
    if (qy.toSeq !== undefined) {
      where.push('seq <= ?')
      params.push(qy.toSeq)
    }
    if (qy.lane) {
      where.push('lane = ?')
      params.push(keyBytes(qy.lane))
    }
    if (qy.type) {
      const types = Array.isArray(qy.type) ? qy.type : [qy.type]
      where.push(`type IN (${types.map(() => '?').join(',')})`)
      params.push(...types)
    }
    const order = qy.order === 'desc' ? 'DESC' : 'ASC'
    const own = db
      .prepare(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY seq ${order} LIMIT ?`)
      .all(...params, take) as unknown as Row[]
    let rows = own.map(rowToEvent)
    if (parent) {
      const upper = qy.toSeq === undefined ? parent.boundarySeq : Math.min(qy.toSeq, parent.boundarySeq)
      const prefix = scanRows(parent.key, { ...qy, toSeq: upper }, take)
      rows = order === 'ASC' ? [...prefix, ...rows] : [...rows, ...prefix]
      rows = rows.slice(0, take)
    }
    return rows
  }

  function scanIntegrityRows(key: SessionKey, qy: IntegrityScanQuery): IntegrityRow[] {
    const parent = parentOf(key)
    const own = db
      .prepare(
        'SELECT * FROM events WHERE session_key = ? AND seq >= ? AND seq <= ? ORDER BY seq ASC LIMIT ?',
      )
      .all(key, qy.fromSeq, qy.toSeq, Math.min(qy.limit, MAX_LIMIT)) as unknown as Row[]
    let rows = own.map(rowToIntegrity)
    if (parent) {
      const upper = Math.min(qy.toSeq, parent.boundarySeq)
      const prefix = scanIntegrityRows(parent.key, { ...qy, toSeq: upper, limit: MAX_LIMIT })
      rows = [...prefix, ...rows].slice(0, Math.min(qy.limit, MAX_LIMIT))
    }
    return rows
  }

  const childControl = sqliteChildControl(db, tx, clock)

  return {
    file: opts.file,
    ...childControl,
    async clearWriterLease(key) {
      tx(() => {
        db.prepare('DELETE FROM writer_claims WHERE session_key = ?').run(key)
      })
    },
    async open(key, claim): Promise<OpenResult> {
      return tx(() => {
        const l = q.lease.get(key) as { run_id: string; until: number } | undefined
        if (l && l.run_id !== claim.writerRunId && l.until >= clock())
          throw new CoreError('E_WRITER_LEASE', 'session held by another writer', { holder: l.run_id })
        const created =
          Number(q.insertSession.run(key, null, null, new Date(clock()).toISOString()).changes) === 1
        q.upsertLease.run(key, claim.writerRunId, clock() + claim.ttlMs, claim.ttlMs)
        const parent = parentOf(key)
        return {
          lastSeq: lastSeq(key),
          formatVersion: 1,
          ...(created ? { created: true } : {}),
          ...(parent ? { parent } : {}),
        }
      })
    },
    async commit(key, c: CommitTx) {
      if (c.opState && c.events.length === 0)
        throw new CoreError('E_STORAGE_FAULT', 'an op write needs at least one row in its batch')
      return tx(() => {
        holdLease(key, c.expectedWriterRunId, c.claim)
        if (c.expectedRegisterSeq) {
          const cur =
            (
              q.registerSeq.get(key, c.expectedRegisterSeq.register, keyBytes(c.expectedRegisterSeq.key)) as
                | { seq: number }
                | undefined
            )?.seq ?? null
          if (cur !== c.expectedRegisterSeq.seq)
            throw new CoreError('E_CAS', 'register seq mismatch', {
              register: c.expectedRegisterSeq.register,
              key: c.expectedRegisterSeq.key,
              expected: c.expectedRegisterSeq.seq,
              actual: cur,
            })
        }
        let seq = lastSeq(key)
        const seqs: number[] = []
        const expectedSeqs = c.events.map((_, index) => seq + index + 1)
        if (
          c.integrity &&
          (c.integrity.length !== c.events.length ||
            c.integrity.some((entry, index) => entry.seq !== expectedSeqs[index]))
        )
          throw new CoreError('E_STORAGE_FAULT', 'integrity metadata does not match assigned sequences')
        for (const [index, e] of c.events.entries()) {
          seq++
          const integrity = c.integrity?.[index]
          q.insertEvent.run(
            key,
            seq,
            e.ts,
            e.id,
            e.type,
            keyBytes(e.lane ?? 'main'),
            e.v ?? 1,
            JSON.stringify(e.actor),
            e.origin,
            e.trust,
            e.register ?? null,
            e.ignorable ? 1 : null,
            e.surfaceOp ? JSON.stringify(e.surfaceOp) : null,
            e.sourceEventSeqs ? JSON.stringify(e.sourceEventSeqs) : null,
            JSON.stringify(e.data),
            integrity?.mode ?? null,
            integrity?.previousDigest ?? null,
            integrity?.digest ?? null,
          )
          if (e.register) {
            const rk = registerKey({ ...e, seq })
            if (isTombstone(e.register, e.data)) q.deleteRegister.run(key, e.register, keyBytes(rk))
            else q.upsertRegister.run(key, e.register, keyBytes(rk), seq, JSON.stringify(e.data))
          }
          seqs.push(seq)
        }
        if (c.opState) {
          const lane = keyBytes(c.opState.lane)
          if (c.opState.data === null) q.deleteRegister.run(key, 'op.state', lane)
          else q.upsertRegister.run(key, 'op.state', lane, seq, JSON.stringify(c.opState.data))
        }
        if (c.foldCache) {
          const cache = c.foldCache
          if (cache.seq !== seq)
            throw new CoreError('E_STORAGE_FAULT', 'fold cache cursor does not match commit')
          q.upsertFoldCache.run(
            key,
            cache.version,
            cache.seq,
            cache.payload,
            cache.checksum,
            cache.integrity.lastSeq,
            cache.integrity.legacyThroughSeq,
            cache.integrity.headDigest,
          )
        }
        return { firstSeq: seqs[0] as number, seqs, ...(c.opState ? { opState: { seq } } : {}) }
      })
    },
    // The old body computed `clock() + Math.max(l.until - clock(), 1)`, which is `l.until` — renew
    // never moved the deadline. The ttl the writer opened with is stored on the claim so a renewal
    // can extend by it without the caller having to repeat it (StorageAdapter.renew takes no ttl).
    async renew(key, runId, claim) {
      tx(() => {
        if (claim) return holdLease(key, runId, claim)
        assertLease(key, runId)
        const l = q.lease.get(key) as { ttl_ms: number }
        q.renew.run(clock() + l.ttl_ms, key, runId)
      })
    },
    async release(key, runId) {
      q.release.run(key, runId)
    },
    async discardNewSession(key, runId, claim) {
      tx(() => {
        holdLease(key, runId, claim)
        q.deleteEvents.run(key)
        q.deleteRegisters.run(key)
        q.deleteFoldCache.run(key)
        q.deleteLease.run(key, runId)
        q.deleteSession.run(key)
      })
    },
    async scan(key, qy) {
      if (qy.toSeq === undefined && qy.limit === undefined)
        throw new CoreError('E_SCAN_UNBOUNDED', 'scan needs toSeq or limit', {})
      if (qy.limit !== undefined && (!Number.isSafeInteger(qy.limit) || qy.limit <= 0))
        throw new CoreError('E_SCAN_UNBOUNDED', 'scan limit must be a positive integer', {})
      // A page is read as asked. A request for everything reads one row past the page, and that
      // row's presence is the whole test for "there was more than fits".
      if (qy.limit !== undefined && qy.limit <= SCAN_PAGE_MAX) return scanRows(key, qy, qy.limit)
      const rows = scanRows(key, qy, SCAN_PAGE_MAX + 1)
      if (rows.length > SCAN_PAGE_MAX) throw scanTruncated(qy)
      return rows
    },
    async scanIntegrity(key, qy) {
      if (!Number.isSafeInteger(qy.limit) || qy.limit <= 0)
        throw new CoreError('E_SCAN_UNBOUNDED', 'integrity scan needs a positive limit')
      return scanIntegrityRows(key, qy)
    },
    async registers(key): Promise<RegisterRow[]> {
      return (
        q.registers.all(key) as unknown as Array<{
          register: string
          key: Uint8Array
          seq: number
          data: string
        }>
      ).map((r) => ({ register: r.register, key: keyText(r.key), seq: r.seq, data: JSON.parse(r.data) }))
    },
    async foldCache(key): Promise<FoldCacheRecord | undefined> {
      const row = q.foldCache.get(key) as
        | {
            version: number
            seq: number
            payload: string
            checksum: string
            integrity_last_seq: number
            legacy_through_seq: number
            head_digest: string | null
          }
        | undefined
      if (!row) return undefined
      return {
        version: row.version as FoldCacheRecord['version'],
        seq: row.seq,
        payload: row.payload,
        checksum: row.checksum,
        integrity: {
          lastSeq: row.integrity_last_seq,
          legacyThroughSeq: row.legacy_through_seq,
          headDigest: row.head_digest,
        },
      }
    },
    async createChild(parentKey, boundarySeq, childKey) {
      tx(() => {
        if (!q.session.get(parentKey) || boundarySeq > lastSeq(parentKey))
          throw new CoreError('E_STORAGE_FAULT', 'boundary beyond parent', { boundarySeq })
        const existing = q.session.get(childKey) as
          | { parent_key: string | null; boundary_seq: number | null }
          | undefined
        if (existing) {
          if (existing.parent_key === parentKey && existing.boundary_seq === boundarySeq) return
          throw new CoreError('E_STORAGE_FAULT', 'child key exists', { childKey })
        }
        try {
          q.insertChildSession.run(childKey, parentKey, boundarySeq, new Date(clock()).toISOString())
        } catch {
          throw new CoreError('E_STORAGE_FAULT', 'child key exists', { childKey })
        }
      })
    },
    // Idempotent. Two owners legitimately close this handle: core's Kernel.close() closes the storage
    // it was given, and the adapter bundle that opened it closes it on the way down. DatabaseSync
    // throws on an already-closed handle, so without this the second one turns an orderly shutdown
    // into a reported teardown failure - and, on the forced path, into a race between the two.
    async close() {
      if (closed) return
      closed = true
      for (const d of owned.values()) d.close()
      owned.clear()
      db.close()
    },
    coreTableNames: () =>
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
          .all() as unknown as Array<{
          name: string
        }>
      ).map((r) => r.name),
    journalMode: () => (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode,
    crashReclaim: {
      listExpired(now) {
        return (
          q.expiredClaims.all(now) as unknown as Array<{
            session_key: string
            run_id: string
            until: number
            generation: number
          }>
        ).map((row) => ({
          sessionKey: row.session_key,
          runId: row.run_id,
          until: row.until,
          generation: row.generation,
        }))
      },
      claimForReclaim(sessionKey, runId, until, now) {
        return tx(() => {
          const l = q.lease.get(sessionKey) as { run_id: string; until: number } | undefined
          if (l?.run_id !== runId || l.until !== until || l.until >= now) return null
          const turns = q.opStates.all(sessionKey, 'op.state') as Array<{ seq: number; data: string }>
          const open = turns.find((turn) => turn.data !== 'null')
          const seq = lastSeq(sessionKey)
          if (open) return { opState: { seq: open.seq, data: JSON.parse(open.data) }, seq }
          q.releaseExpired.run(sessionKey, runId, until, now)
          return { opState: undefined, seq }
        })
      },
    },
    tables(owner: string): TableStore {
      let odb = owned.get(owner)
      if (!odb) {
        mkdirSync(tablesDir, { recursive: true })
        odb = new DatabaseSync(join(tablesDir, `${ownerFile(owner)}.db`))
        odb.exec('PRAGMA journal_mode = WAL')
        for (const row of odb.prepare('SELECT name FROM sqlite_master WHERE type = ?').all('table') as {
          name: string
        }[]) {
          assertSessionTreeTableName(row.name)
        }
        // After the journal pragma, not before: the authorizer refuses PRAGMA to everyone.
        confineToOwnFile(odb)
        owned.set(owner, odb)
      }
      const conn = odb
      const otx = <T>(fn: () => T): T => {
        conn.exec('BEGIN IMMEDIATE')
        try {
          const r = fn()
          conn.exec('COMMIT')
          return r
        } catch (e) {
          conn.exec('ROLLBACK')
          throw e
        }
      }
      return {
        table(name: string): TableHandle {
          assertSessionTreeTableName(name)
          if (!TABLE_NAME.test(name)) throw new Error(`table name must match ${TABLE_NAME}: ${name}`)
          return {
            name,
            exec: (sql) => {
              assertOwnedSql(sql)
              conn.exec(sql)
            },
            run: (sql, params = []) => {
              assertOwnedSql(sql)
              return { changes: Number(conn.prepare(sql).run(...toSqlParams(params)).changes) }
            },
            all: <T>(sql: string, params: readonly unknown[] = []) => {
              assertOwnedSql(sql)
              return conn.prepare(sql).all(...toSqlParams(params)) as unknown as T[]
            },
            get: <T>(sql: string, params: readonly unknown[] = []) => {
              assertOwnedSql(sql)
              return conn.prepare(sql).get(...toSqlParams(params)) as unknown as T | undefined
            },
            transaction: otx,
          }
        },
      }
    },
  }
}
