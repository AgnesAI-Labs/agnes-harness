import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { defaultIds, openTracked, projectUI, SessionLogImpl } from '@agnes/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ev } from '../../../host/test/adapters/events.js'
import { createSqliteStorage, DDL, ownerFile, type SqliteStorage } from '../../src/adapters/storage-sqlite.js'

describe('storage-sqlite', () => {
  // `now` is reset per test on purpose: as a module-scope `let` mutated by the lease test it made
  // every test after it run at t=3000, so the suite passed or failed depending on its order.
  let dir: string
  let s: SqliteStorage
  let now: number
  beforeEach(() => {
    now = 1_000
    dir = mkdtempSync(join(tmpdir(), 'agnes-sqlite-'))
    s = createSqliteStorage({
      file: join(dir, 'sessions.db'),
      clock: () => now,
      tablesDir: join(dir, 'tables'),
    })
  })
  afterEach(async () => {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates the core tables and WAL', () => {
    expect(s.coreTableNames()).toEqual([
      'budget_reservations',
      'budget_scopes',
      'child_ordinals',
      'child_tasks',
      'child_workspaces',
      'child_writer_gens',
      'cost_origins',
      'events',
      'ledger_integrity_failure_v1',
      'ledger_verified_head_v1',
      'registers',
      'sessions',
      'writer_claims',
    ])
    expect(s.journalMode()).toBe('wal')
    expect(DDL.length).toBeGreaterThanOrEqual(4)
  })
  it('creates sessions.db exactly as the DDL declares it, indexes included', () => {
    const raw = new DatabaseSync(s.file, { readOnly: true })
    const ddlOnly = new DatabaseSync(':memory:')
    for (const ddl of DDL) ddlOnly.exec(ddl)
    const schema = (db: DatabaseSync) =>
      db
        .prepare(
          "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .all()
    expect(schema(raw)).toEqual(schema(ddlOnly))
    expect(
      (raw.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map((c) => c.name),
    ).toEqual([
      'session_key',
      'format_version',
      'parent_key',
      'boundary_seq',
      'created_at',
      'head_version',
      'head_seq',
      'head_digest',
    ])
    expect(
      raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name")
        .all()
        .map((r) => r.name),
    ).toEqual([
      'budget_reservations_root_effect',
      'child_tasks_creating',
      'child_tasks_parent',
      'child_tasks_root',
      'child_workspaces_child',
      'events_type',
    ])
    const plan = (sql: string, ...params: string[]) =>
      (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
        .map((r) => r.detail)
        .join(' | ')
    const TASK =
      'SELECT t.*, s.boundary_seq AS boundary_seq FROM child_tasks t LEFT JOIN sessions s ON s.session_key = t.child_key'
    expect(plan(`${TASK} WHERE t.parent_key = ?`, 'p')).toContain(
      'SEARCH t USING INDEX child_tasks_parent (parent_key=?)',
    )
    expect(plan(`${TASK} WHERE t.root_task_id = ?`, 'r')).toContain(
      'SEARCH t USING INDEX child_tasks_root (root_task_id=?)',
    )
    expect(plan(`${TASK} WHERE t.creation_phase = 'creating'`)).toContain(
      'SCAN t USING INDEX child_tasks_creating',
    )
    expect(plan('SELECT * FROM child_workspaces WHERE child_key = ?', 'c')).toContain(
      'USING INDEX child_workspaces_child (child_key=?)',
    )
    raw.close()
    ddlOnly.close()
  })
  it('keeps the append watermark on the session row', async () => {
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    const head = () => {
      const raw = new DatabaseSync(s.file, { readOnly: true })
      try {
        return raw
          .prepare('SELECT head_version, head_seq, head_digest FROM sessions WHERE session_key = ?')
          .get('k')
      } finally {
        raw.close()
      }
    }
    expect(head()).toEqual({ head_version: 1, head_seq: 0, head_digest: null })
    await s.commit('k', {
      events: [ev('user/message', {}), ev('user/message', {})],
      expectedWriterRunId: 'r1',
    })
    expect(head()).toEqual({ head_version: 1, head_seq: 2, head_digest: null })
  })
  it('refuses a second reservation for one root and effect', () => {
    const raw = new DatabaseSync(s.file)
    const insert = raw.prepare(
      'INSERT INTO budget_reservations (permit_id, root_task_id, scope_ids, q_micro, effect_id, request_hash, writer_generation, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    insert.run('p1', 'root', '[]', '1', 'e', 'h', 1, 'held')
    expect(() => insert.run('p2', 'root', '[]', '1', 'e', 'h', 1, 'held')).toThrow(
      /UNIQUE constraint failed: budget_reservations\.root_task_id, budget_reservations\.effect_id/,
    )
    raw.close()
  })
  it('reports the stored size of one session in bytes, not characters', async () => {
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    await s.open('other', { writerRunId: 'r2', ttlMs: 1000 })
    expect(await s.ledgerStats?.('k')).toEqual({ storedBytes: 0, maxRowBytes: 0 })
    const small = { content: [{ type: 'text', text: 'a' }] }
    const wide = { content: [{ type: 'text', text: '€'.repeat(100) }] }
    await s.commit('k', {
      events: [ev('user/message', small), ev('user/message', wide)],
      expectedWriterRunId: 'r1',
    })
    await s.commit('other', { events: [ev('user/message', wide)], expectedWriterRunId: 'r2' })
    const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))
    expect(await s.ledgerStats?.('k')).toEqual({
      storedBytes: bytes(small) + bytes(wide),
      maxRowBytes: bytes(wide),
    })
  })
  it('open takes a lease, commit assigns seq and materializes registers', async () => {
    const o = await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    expect(o).toEqual({ lastSeq: 0, formatVersion: 1, created: true })
    const r = await s.commit('k', {
      events: [ev('user/message', { content: [] }), ev('op.state', { step: 1 }, { register: 'op.state' })],
      expectedWriterRunId: 'r1',
    })
    expect(r).toEqual({ firstSeq: 1, seqs: [1, 2] })
    expect(await s.registers('k')).toEqual([{ register: 'op.state', key: 'main', seq: 2, data: { step: 1 } }])
  })
  it('reads bounded presentation rows without changing originals or admitting a removed tail', async () => {
    const opts = {
      storage: s,
      key: 'lean',
      writerRunId: 'reader',
      ttlMs: 60_000,
      ids: defaultIds(),
      clock: () => now,
      timers: { setTimeout: () => 0, clearTimeout() {} },
    }
    const log = await SessionLogImpl.open(opts)
    const original = 'x'.repeat(64 * 1024)
    await log.append([
      ev('user/message', { content: [{ type: 'text', text: original }] }),
      ev(
        'x/core/context-breakdown',
        { sections: [{ id: 's', source: 'synthetic', content: original }] },
        { ignorable: true },
      ),
    ])
    await log.close()
    const lean = await s.scanLean('lean', { limit: 1 })
    expect(JSON.stringify(lean).length).toBeLessThan(2048)
    const diagnostic = await s.scanLean('lean', { fromSeq: 2, limit: 1 })
    expect(diagnostic[0]?.type).toBe('x/agnes/preview-omitted')
    await expect(projectUI([...lean, ...diagnostic], { sessionKey: 'lean' })).resolves.toMatchObject({
      upto: 2,
    })
    expect((await s.scan('lean', { limit: 1 }))[0]?.data).toEqual({
      content: [{ type: 'text', text: original }],
    })
    const raw = new DatabaseSync(join(dir, 'sessions.db'))
    raw.prepare('DELETE FROM events WHERE session_key = ?').run('lean')
    raw.close()
    await expect(SessionLogImpl.open({ ...opts, writerRunId: 'bad' })).rejects.toMatchObject({
      code: 'E_LEDGER_INTEGRITY',
    })
  })
  it('discards every row of a newly opened session only while its writer lease is held', async () => {
    await s.open('discard', { writerRunId: 'r1', ttlMs: 1_000 })
    await s.commit('discard', {
      events: [ev('op.state', { step: 1 }, { register: 'op.state' })],
      expectedWriterRunId: 'r1',
    })
    await s.discardNewSession('discard', 'r1')
    const reopened = await s.open('discard', { writerRunId: 'r2', ttlMs: 1_000 })
    expect(reopened).toEqual({ lastSeq: 0, formatVersion: 1, created: true })
    expect(await s.registers('discard')).toEqual([])
    await expect(s.discardNewSession('discard', 'r1')).rejects.toMatchObject({ code: 'E_WRITER_LEASE' })
  })
  it('reopens a 1000+ row session from SQLite, folding everything from the ledger while verifying it', async () => {
    const file = join(dir, 'sessions.db')
    const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
    const options = {
      storage: s,
      key: 'cached',
      writerRunId: 'r1',
      ttlMs: 1_000,
      clock: () => now,
      ids: defaultIds(),
      relationCheck: () => undefined,
    }
    const first = await openTracked(options)
    await first.log.append(
      Array.from({ length: 1_001 }, (_, index) => ({
        type: 'user/message',
        actor,
        origin: 'system' as const,
        trust: 'trusted' as const,
        data: { content: [{ type: 'text' as const, text: `message-${index}` }] },
      })),
    )
    await first.log.close()
    await s.close()

    s = createSqliteStorage({ file, clock: () => now, tablesDir: join(dir, 'tables') })
    const scannedFrom: number[] = []
    const originalScan = s.scan.bind(s)
    s.scan = async (key, query) => {
      scannedFrom.push(query.fromSeq ?? 1)
      return originalScan(key, query)
    }
    const reopened = await openTracked({ ...options, storage: s, writerRunId: 'r2' })
    expect(reopened.tracker.state.lastSeq).toBe(1_001)
    expect(reopened.surface.nodes()).toHaveLength(1_001)
    expect(reopened.ui.diagnostics().applied).toBe(1_001)
    // Rows are folded while the open verifies them; nothing reads them a second time.
    expect(scannedFrom).toEqual([])
    await reopened.log.close()
  })
  it('reports an op cell written as a cell to crash reclaim', async () => {
    await s.open('cell-op', { writerRunId: 'dead-run', ttlMs: 100 })
    await s.commit('cell-op', {
      events: [ev('user/message', {})],
      expectedWriterRunId: 'dead-run',
      opState: { lane: 'main', data: { step: 4 } as never },
    })
    expect(s.crashReclaim.claimForReclaim('cell-op', 'dead-run', 1_100, 1_101)).toEqual({
      opState: { seq: 1, data: { step: 4 } },
      seq: 1,
    })
  })
  it('exposes only the narrow claim/op-state operations production crash reclaim needs', async () => {
    await s.open('recover-me', { writerRunId: 'dead-run', ttlMs: 100 })
    await s.commit('recover-me', {
      events: [ev('op.state', { step: 3 }, { register: 'op.state' })],
      expectedWriterRunId: 'dead-run',
    })
    await s.open('idle-one', { writerRunId: 'idle-run', ttlMs: 100 })
    await s.commit('idle-one', { events: [ev('user/message', {})], expectedWriterRunId: 'idle-run' })

    expect(s.crashReclaim.listExpired(1_099)).toEqual([])
    expect(s.crashReclaim.listExpired(1_101)).toEqual([
      { sessionKey: 'recover-me', runId: 'dead-run', until: 1_100, generation: 1 },
      { sessionKey: 'idle-one', runId: 'idle-run', until: 1_100, generation: 1 },
    ])
    // Only the exact expired row the listing saw is acted on.
    expect(s.crashReclaim.claimForReclaim('recover-me', 'wrong-run', 1_100, 1_101)).toBeNull()
    expect(s.crashReclaim.claimForReclaim('recover-me', 'dead-run', 1_099, 1_101)).toBeNull()
    expect(s.crashReclaim.claimForReclaim('recover-me', 'dead-run', 1_100, 1_100)).toBeNull()
    // An open turn is reported and the row left for the resuming writer.
    expect(s.crashReclaim.claimForReclaim('recover-me', 'dead-run', 1_100, 1_101)).toEqual({
      opState: { seq: 1, data: { step: 3 } },
      seq: 1,
    })
    // No turn open: the row is deleted.
    // The ledger head is reported for an idle session.
    expect(s.crashReclaim.claimForReclaim('idle-one', 'idle-run', 1_100, 1_101)).toEqual({
      opState: undefined,
      seq: 1,
    })
    expect(s.crashReclaim.listExpired(1_101)).toEqual([
      { sessionKey: 'recover-me', runId: 'dead-run', until: 1_100, generation: 1 },
    ])
  })
  it('round-trips every optional envelope field rather than dropping it on the floor', async () => {
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    await s.commit('k', {
      events: [
        ev(
          'tool/call',
          { a: 1 },
          {
            lane: 'side',
            v: 2,
            ignorable: true,
            sourceEventSeqs: [1, 2],
            trust: 'untrusted',
            origin: 'model',
          },
        ),
      ],
      expectedWriterRunId: 'r1',
    })
    const [row] = await s.scan('k', { limit: 10 })
    expect(row).toMatchObject({
      seq: 1,
      type: 'tool/call',
      lane: 'side',
      v: 2,
      ignorable: true,
      sourceEventSeqs: [1, 2],
      trust: 'untrusted',
      origin: 'model',
      data: { a: 1 },
    })
    expect(row?.actor).toEqual({ id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} })
  })
  it('rejects a second writer while the lease is live and admits it after expiry', async () => {
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    await expect(s.open('k', { writerRunId: 'r2', ttlMs: 1000 })).rejects.toMatchObject({
      code: 'E_WRITER_LEASE',
    })
    now += 2000
    await expect(s.open('k', { writerRunId: 'r2', ttlMs: 1000 })).resolves.toBeDefined()
    await expect(
      s.commit('k', { events: [ev('user/message', {})], expectedWriterRunId: 'r1' }),
    ).rejects.toMatchObject({ code: 'E_WRITER_LEASE' })
  })
  it('CAS on register seq refuses before anything is written', async () => {
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    await s.commit('k', {
      events: [ev('op.state', { step: 1 }, { register: 'op.state' })],
      expectedWriterRunId: 'r1',
    })
    await expect(
      s.commit('k', {
        events: [ev('user/message', {}), ev('op.state', { step: 2 }, { register: 'op.state' })],
        expectedWriterRunId: 'r1',
        expectedRegisterSeq: { register: 'op.state', key: 'main', seq: 99 },
      }),
    ).rejects.toMatchObject({ code: 'E_CAS' })
    expect((await s.scan('k', { limit: 10 })).length).toBe(1)
  })
  // The CAS test above cannot show atomicity: its check runs before the first insert, so nothing
  // has been written when it throws and the assertion holds even with no transaction at all. This
  // one fails in the middle of the batch, after event 1 is already in, which is the only shape that
  // distinguishes a rolled-back batch from a partially applied one.
  it('a failure part-way through a batch rolls the whole batch back', async () => {
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    const circular: Record<string, unknown> = {}
    circular.self = circular
    await expect(
      s.commit('k', {
        events: [ev('user/message', { ok: true }), ev('user/message', circular)],
        expectedWriterRunId: 'r1',
      }),
    ).rejects.toThrow()
    expect((await s.scan('k', { limit: 10 })).length).toBe(0)
    expect((await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })).lastSeq).toBe(0)
  })
  it('rolls back the register rows of a failed batch too, not only the events', async () => {
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    await s.commit('k', {
      events: [ev('op.state', { step: 1 }, { register: 'op.state' })],
      expectedWriterRunId: 'r1',
    })
    const circular: Record<string, unknown> = {}
    circular.self = circular
    await expect(
      s.commit('k', {
        events: [ev('op.state', { step: 2 }, { register: 'op.state' }), ev('user/message', circular)],
        expectedWriterRunId: 'r1',
      }),
    ).rejects.toThrow()
    expect(await s.registers('k')).toEqual([{ register: 'op.state', key: 'main', seq: 1, data: { step: 1 } }])
  })
  it('renew extends the lease by the ttl recorded at open', async () => {
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    now += 900
    await s.renew('k', 'r1')
    now += 900
    await expect(s.open('k', { writerRunId: 'r2', ttlMs: 1000 })).rejects.toMatchObject({
      code: 'E_WRITER_LEASE',
    })
    await expect(s.renew('k', 'r2')).rejects.toMatchObject({ code: 'E_WRITER_LEASE' })
    now += 1200
    await expect(s.open('k', { writerRunId: 'r2', ttlMs: 1000 })).resolves.toBeDefined()
  })
  it('release drops the lease so another writer may open at once', async () => {
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    await s.release('k', 'r2')
    await expect(s.open('k', { writerRunId: 'r2', ttlMs: 1000 })).rejects.toMatchObject({
      code: 'E_WRITER_LEASE',
    })
    await s.release('k', 'r1')
    await expect(s.open('k', { writerRunId: 'r2', ttlMs: 1000 })).resolves.toBeDefined()
  })
  it('tombstone deletes a register row', async () => {
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    await s.commit('k', {
      events: [
        ev('op.state', { step: 1 }, { register: 'op.state' }),
        ev('op.state', null, { register: 'op.state' }),
      ],
      expectedWriterRunId: 'r1',
    })
    expect(await s.registers('k')).toEqual([])
  })
  it('scan requires a bound and filters by type/lane/order', async () => {
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    await s.commit('k', {
      events: [ev('user/message', {}), ev('assistant/message', {}, { lane: 'side' })],
      expectedWriterRunId: 'r1',
    })
    await expect(s.scan('k', {})).rejects.toMatchObject({ code: 'E_SCAN_UNBOUNDED' })
    expect((await s.scan('k', { type: 'assistant/message', limit: 10 })).map((e) => e.seq)).toEqual([2])
    expect((await s.scan('k', { lane: 'main', limit: 10 })).map((e) => e.seq)).toEqual([1])
    expect((await s.scan('k', { toSeq: 2, order: 'desc' })).map((e) => e.seq)).toEqual([2, 1])
    expect((await s.scan('k', { fromSeq: 2, limit: 10 })).map((e) => e.seq)).toEqual([2])
    expect(
      (await s.scan('k', { type: ['user/message', 'assistant/message'], limit: 10 })).map((e) => e.seq),
    ).toEqual([1, 2])
    // A reused plan must bind each query afresh and see commits after its first execution.
    await s.commit('k', {
      events: [ev('assistant/message', {}, { lane: 'main' })],
      expectedWriterRunId: 'r1',
    })
    expect((await s.scan('k', { type: 'assistant/message', limit: 10 })).map((e) => e.seq)).toEqual([2, 3])
    expect((await s.scan('k', { fromSeq: 3, limit: 10 })).map((e) => e.seq)).toEqual([3])
    expect((await s.scan('k', { fromSeq: 2, limit: 10 })).map((e) => e.seq)).toEqual([2, 3])
    expect((await s.scanLean('k', { fromSeq: 3, limit: 1 })).map((e) => e.seq)).toEqual([3])
  })
  it('child session reads parent prefix and continues seq', async () => {
    await s.open('p', { writerRunId: 'r1', ttlMs: 1000 })
    await s.commit('p', {
      events: [ev('user/message', { n: 1 }), ev('assistant/message', { n: 2 }), ev('user/message', { n: 3 })],
      expectedWriterRunId: 'r1',
    })
    await s.createChild('p', 2, 'c')
    expect(await s.open('c', { writerRunId: 'r9', ttlMs: 1000 })).toMatchObject({
      lastSeq: 2,
      parent: { key: 'p', boundarySeq: 2 },
    })
    expect(
      (await s.commit('c', { events: [ev('session/start', {})], expectedWriterRunId: 'r9' })).seqs,
    ).toEqual([3])
    expect((await s.scan('c', { fromSeq: 1, limit: 10 })).map((e) => e.seq)).toEqual([1, 2, 3])
  })
  it('a child never sees what the parent appended after the fork boundary', async () => {
    await s.open('p', { writerRunId: 'r1', ttlMs: 1000 })
    await s.commit('p', {
      events: [ev('user/message', { n: 1 }), ev('user/message', { n: 2 })],
      expectedWriterRunId: 'r1',
    })
    await s.createChild('p', 2, 'c')
    await s.commit('p', { events: [ev('user/message', { n: 3 })], expectedWriterRunId: 'r1' })
    await s.open('c', { writerRunId: 'r9', ttlMs: 1000 })
    expect((await s.scan('c', { limit: 10 })).map((e) => e.seq)).toEqual([1, 2])
  })
  it('tables(owner) gives each package its own database file, out of reach of the core tables', () => {
    const t = s.tables('@agnes/base').table('usage_ledger')
    t.exec('create table if not exists usage_ledger (id integer primary key, credits real)')
    t.run('insert into usage_ledger (credits) values (?)', [1.5])
    expect(t.all<{ credits: number }>('select credits from usage_ledger')).toEqual([{ credits: 1.5 }])
    expect(t.get<{ credits: number }>('select credits from usage_ledger')).toEqual({ credits: 1.5 })
    t.run('insert into usage_ledger (credits) values (?)', [2.5])
    expect(t.all<{ credits: number }>('select credits from usage_ledger')).toEqual([
      { credits: 1.5 },
      { credits: 2.5 },
    ])
    // Reusing a query must read current rows and retain parameter validation and owner confinement.
    const query = 'select credits from usage_ledger where id = ?'
    expect(t.get(query, [1])).toEqual({ credits: 1.5 })
    expect(t.get(query, [2])).toEqual({ credits: 2.5 })
    expect(t.get(query)).toBeUndefined()
    expect(() => t.get(query, ['bad\u0000value'])).toThrow(/bind parameter/)
    const other = s.tables('@acme/other').table('usage_ledger')
    other.exec('create table usage_ledger (id integer primary key, credits real)')
    other.run('insert into usage_ledger (credits) values (?)', [9])
    expect(other.get(query, [1])).toEqual({ credits: 9 })
    t.exec('alter table usage_ledger add column note text')
    expect(t.get(query, [1])).toEqual({ credits: 1.5 })
    expect(() => s.tables('@agnes/base').table('Bad Name')).toThrow(/table name/)
    // The property the name check alone never had: a package handle cannot see, read or drop the
    // ledger tables, because they are not on this connection.
    expect(() => t.all('select * from writer_claims')).toThrow(/no such table/)
    expect(() => t.exec('drop table events')).toThrow(/no such table/)
    // Nor another package's tables.
    expect(() => s.tables('@acme/unopened').table('usage_ledger').all('select * from usage_ledger')).toThrow(
      /no such table/,
    )
  })
  it('a package table transaction rolls back on throw', () => {
    const t = s.tables('@agnes/base').table('t')
    t.exec('create table t (v integer)')
    expect(() =>
      t.transaction(() => {
        t.run('insert into t (v) values (?)', [1])
        throw new Error('nope')
      }),
    ).toThrow('nope')
    expect(t.all('select v from t')).toEqual([])
  })
  it('refuses a bind parameter SQLite cannot carry instead of handing it to the driver', () => {
    const t = s.tables('@agnes/base').table('t')
    t.exec('create table t (v integer)')
    expect(() => t.run('insert into t (v) values (?)', [{ nope: true } as unknown as number])).toThrow(
      /bind parameter/,
    )
  })
  it('survives reopen (durability)', async () => {
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    await s.commit('k', { events: [ev('user/message', { x: 1 })], expectedWriterRunId: 'r1' })
    await s.close()
    s = createSqliteStorage({ file: join(dir, 'sessions.db'), clock: () => now + 5000 })
    expect((await s.open('k', { writerRunId: 'r2', ttlMs: 1000 })).lastSeq).toBe(1)
  })

  it('refuses orphaned event history without rewriting its rows', async () => {
    await s.close()
    const raw = new DatabaseSync(join(dir, 'sessions.db'))
    raw.exec(`INSERT INTO events (session_key, seq, ts, id, type, lane, v, actor, origin, trust, data) VALUES (
      'k', 1, '2026-09-12T00:00:00.000Z', 'old', 'user/message', x'6d61696e', 1,
      '{"id":"u","org":"local","role":"owner","deptPath":[],"attrs":{}}', 'principal', 'trusted', '{"content":[]}')`)
    raw.close()
    s = createSqliteStorage({
      file: join(dir, 'sessions.db'),
      clock: () => now,
      tablesDir: join(dir, 'tables'),
    })
    await expect(s.open('k', { writerRunId: 'new', ttlMs: 1000 })).rejects.toMatchObject({
      code: 'E_LEDGER_INTEGRITY',
    })
    expect(await s.scanIntegrity('k', { fromSeq: 1, toSeq: 1, limit: 10 })).toMatchObject([
      { sessionKey: 'k', event: { id: 'old', seq: 1 }, integrity: null },
    ])
  })

  it('detects direct mutation of a protected SQLite event on the next open', async () => {
    const file = join(dir, 'sessions.db')
    const log = await SessionLogImpl.open({
      storage: s,
      key: 'protected',
      writerRunId: 'writer',
      ttlMs: 1000,
      ids: defaultIds(),
      clock: () => now,
      timers: { setTimeout: () => 0, clearTimeout: () => undefined },
    })
    await log.append([
      ev('user/message', { content: [{ type: 'text', text: 'original' }] }),
      ev('user/message', { content: [{ type: 'text', text: 'valid successor' }] }),
    ])
    await log.close()
    await s.close()

    const attacker = new DatabaseSync(file)
    attacker
      .prepare('UPDATE events SET data = ? WHERE session_key = ? AND seq = 1')
      .run(JSON.stringify({ content: [{ type: 'text', text: 'changed' }] }), 'protected')
    attacker.close()

    s = createSqliteStorage({ file, clock: () => now + 5000, tablesDir: join(dir, 'tables') })
    const reopen = (writerRunId: string) =>
      SessionLogImpl.open({
        storage: s,
        key: 'protected',
        writerRunId,
        ttlMs: 1000,
        ids: defaultIds(),
        clock: () => now + 5000,
        timers: { setTimeout: () => 0, clearTimeout: () => undefined },
      })
    // The writer's close left a verified-head checkpoint, so this open starts from it without hashing
    // the prefix; the explicit full verification then finds the row, seals the session and drops it.
    const reader = await reopen('reader')
    await reader.verifyHistory({ rehashPrefix: true })
    await expect(reader.fullVerified()).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
    await reader.close()
    await expect(reopen('second-reader')).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
  })

  it('continues a protected parent prefix under the physical owner key', async () => {
    const openLog = (key: string, writerRunId: string) =>
      SessionLogImpl.open({
        storage: s,
        key,
        writerRunId,
        ttlMs: 1000,
        ids: defaultIds(),
        clock: () => now,
        timers: { setTimeout: () => 0, clearTimeout: () => undefined },
      })
    const parent = await openLog('parent', 'parent-writer')
    await parent.append([ev('user/message', { content: [{ type: 'text', text: 'parent' }] })])
    await s.createChild('parent', 1, 'child')
    const child = await openLog('child', 'child-writer')
    await child.append([ev('user/message', { content: [{ type: 'text', text: 'child' }] })])
    await child.close()
    await parent.close()

    const rows = await s.scanIntegrity('child', { fromSeq: 1, toSeq: 2, limit: 10 })
    expect(rows.map((row) => [row.sessionKey, row.integrity?.mode])).toEqual([
      ['parent', 'anchor'],
      ['child', 'chain'],
    ])
    const reopened = await openLog('child', 'child-reader')
    expect(reopened.lastSeq).toBe(2)
    await reopened.close()
  })

  // Two owners legitimately close this handle - core's Kernel.close() and the adapter bundle that
  // opened it - and DatabaseSync throws on an already-closed handle, so a second close used to turn
  // an orderly shutdown into a reported teardown failure.
  it('close is idempotent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-sqlite-close-'))
    const s = createSqliteStorage({ file: join(dir, 'x.db'), tablesDir: join(dir, 'tables') })
    s.tables('@agnes/base').table('t')
    await s.close()
    await expect(s.close()).resolves.toBeUndefined()
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses an owner DB that still contains a session_profiles table', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-sqlite-legacy-'))
    const tablesDir = join(dir, 'tables')
    const storage = createSqliteStorage({ file: join(dir, 'sessions.db'), tablesDir })
    const owner = '@agnes/daemon'
    mkdirSync(tablesDir, { recursive: true })
    const legacy = new DatabaseSync(join(tablesDir, `${ownerFile(owner)}.db`))
    legacy.exec('CREATE TABLE session_profiles (k TEXT)')
    legacy.close()
    // The refused owner file is closed again: Windows cannot delete a directory holding it open.
    const closes = vi.spyOn(DatabaseSync.prototype, 'close')
    try {
      expect(() => storage.tables(owner)).toThrow(/E_SESSION_TREE_SCHEMA/)
      expect(closes).toHaveBeenCalledOnce()
    } finally {
      closes.mockRestore()
    }
    await storage.close()
    rmSync(dir, { recursive: true, force: true })
  })
  it.each(['json', 'checksum', 'missing', 'watermark', 'tail-and-watermark', 'empty-and-watermark'])(
    'refuses a damaged %s tail without altering the stored evidence',
    async (kind) => {
      const options = {
        storage: s,
        key: 'tail',
        writerRunId: 'writer',
        ttlMs: 1000,
        ids: defaultIds(),
        clock: () => now,
      }
      const log = await SessionLogImpl.open(options)
      await log.append([
        ev('user/message', { content: [{ type: 'text', text: 'first' }] }),
        ev('user/message', { content: [{ type: 'text', text: 'second' }] }),
        ev('user/message', { content: [{ type: 'text', text: 'damaged' }] }),
      ])
      await log.close()
      const db = new DatabaseSync(s.file)
      db.prepare(
        kind === 'json'
          ? "UPDATE events SET data = '{' WHERE session_key = 'tail' AND seq = 3"
          : kind === 'missing' || kind === 'tail-and-watermark'
            ? "DELETE FROM events WHERE session_key = 'tail' AND seq = 3"
            : kind === 'empty-and-watermark'
              ? "DELETE FROM events WHERE session_key = 'tail'"
              : kind === 'watermark'
                ? "UPDATE sessions SET head_seq = NULL, head_digest = NULL WHERE session_key = 'tail'"
                : "UPDATE events SET integrity_digest = 'bad' WHERE session_key = 'tail' AND seq = 3",
      ).run()
      if (kind === 'tail-and-watermark' || kind === 'empty-and-watermark')
        db.exec("UPDATE sessions SET head_seq = NULL, head_digest = NULL WHERE session_key = 'tail'")
      db.close()
      await s.close()
      s = createSqliteStorage({ file: options.storage.file, clock: () => now })
      await expect(openTracked({ ...options, storage: s, writerRunId: 'reader' })).rejects.toMatchObject({
        code: 'E_LEDGER_INTEGRITY',
      })
      const evidence = new DatabaseSync(s.file)
      expect(
        evidence.prepare("SELECT COUNT(*) AS n FROM events WHERE session_key = 'tail'").get(),
      ).toMatchObject({
        n: kind === 'empty-and-watermark' ? 0 : kind === 'missing' || kind === 'tail-and-watermark' ? 2 : 3,
      })
      expect(
        evidence.prepare("SELECT COUNT(*) AS n FROM writer_claims WHERE session_key = 'tail'").get(),
      ).toMatchObject({ n: 0 })
      evidence.close()
      expect(readdirSync(dir).some((name) => name.includes('.tail-'))).toBe(false)
    },
  )

  it('refuses interior damage and future format versions without discarding valid events', async () => {
    const options = {
      storage: s,
      key: 'middle',
      writerRunId: 'writer',
      ttlMs: 1000,
      ids: defaultIds(),
      clock: () => now,
    }
    const log = await SessionLogImpl.open(options)
    await log.append(
      Array.from({ length: 3 }, () => ev('user/message', { content: [{ type: 'text', text: 'valid' }] })),
    )
    await log.close()
    const db = new DatabaseSync(s.file)
    db.prepare("UPDATE events SET integrity_digest = 'bad' WHERE session_key = 'middle' AND seq = 2").run()
    // The writer's close left a verified-head checkpoint, so this open starts from it without hashing
    // the prefix; the explicit full verification then finds the damaged row, seals the session and
    // drops the checkpoint.
    const reader = await SessionLogImpl.open({ ...options, writerRunId: 'reader' })
    await reader.verifyHistory({ rehashPrefix: true })
    await expect(reader.fullVerified()).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
    await reader.close()
    await expect(SessionLogImpl.open({ ...options, writerRunId: 'second-reader' })).rejects.toMatchObject({
      code: 'E_LEDGER_INTEGRITY',
    })
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE session_key = 'middle'").get()).toMatchObject({
      n: 3,
    })
    expect(readdirSync(dir).some((name) => name.includes('.tail-'))).toBe(false)
    db.prepare("UPDATE sessions SET format_version = 2 WHERE session_key = 'middle'").run()
    await expect(s.open('middle', { writerRunId: 'future-reader', ttlMs: 1000 })).rejects.toMatchObject({
      code: 'E_FORMAT_NEWER',
      detail: { sessionKey: 'middle', formatVersion: 2, supported: 1, location: s.file },
    })
    db.close()
  })

  it.each([
    [2, 'E_FORMAT_NEWER'],
    [0, 'E_FORMAT_OLDER'],
    [-3, 'E_FORMAT_CORRUPT'],
  ])(
    'refuses ledger format %s as %s and leaves the raw ledger and its lease untouched',
    async (version, code) => {
      const dir = mkdtempSync(join(tmpdir(), 'agnes-format-'))
      const s = createSqliteStorage({ file: join(dir, 'sessions.db'), tablesDir: join(dir, 'tables') })
      await s.open('one', { writerRunId: 'writer', ttlMs: 1000 })
      await s.release('one', 'writer')
      const db = new DatabaseSync(s.file)
      db.prepare('UPDATE sessions SET format_version = ? WHERE session_key = ?').run(version, 'one')
      const before = JSON.stringify({
        session: db.prepare('SELECT * FROM sessions').all(),
        events: db.prepare('SELECT * FROM events').all(),
        lease: db.prepare('SELECT * FROM writer_claims').all(),
      })
      const failure = await s.open('one', { writerRunId: 'later', ttlMs: 1000 }).then(
        () => undefined,
        (error: unknown) => error as { code: string; message: string },
      )
      expect(failure?.code).toBe(code)
      expect(failure?.message).toContain('one')
      expect(failure?.message).toContain(s.file)
      expect(
        JSON.stringify({
          session: db.prepare('SELECT * FROM sessions').all(),
          events: db.prepare('SELECT * FROM events').all(),
          lease: db.prepare('SELECT * FROM writer_claims').all(),
        }),
      ).toBe(before)
      db.close()
    },
  )
})
