import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { defaultIds, openTracked, SessionLogImpl } from '@agnes/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSqliteStorage, DDL, ownerFile, type SqliteStorage } from '../../src/adapters/storage-sqlite.js'
import { ev } from './events.js'

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
      'child_control_meta',
      'child_ordinals',
      'child_tasks',
      'child_workspaces',
      'child_writer_gens',
      'cost_origins',
      'events',
      'fold_cache',
      'registers',
      'sessions',
      'writer_claims',
    ])
    expect(s.journalMode()).toBe('wal')
    expect(DDL.length).toBeGreaterThanOrEqual(4)
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
  it('drops the retired UI projection cache table when a database is opened', async () => {
    const legacy = mkdtempSync(join(tmpdir(), 'agnes-sqlite-ui-cache-'))
    try {
      const file = join(legacy, 'sessions.db')
      const raw = new DatabaseSync(file)
      raw.exec(
        'CREATE TABLE ui_projection_cache (session_key TEXT NOT NULL, lane BLOB NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (session_key, lane))',
      )
      raw.exec("INSERT INTO ui_projection_cache VALUES ('k', x'6d61696e', '{}')")
      raw.close()
      const storage = createSqliteStorage({ file, tablesDir: join(legacy, 'tables') })
      expect(storage.coreTableNames()).not.toContain('ui_projection_cache')
      await storage.close()
    } finally {
      rmSync(legacy, { recursive: true, force: true })
    }
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
  it('reopens a 1000+ row session from SQLite, rebuilding the UI from the ledger and healing a corrupt fold cache', async () => {
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
    expect(await s.foldCache?.('cached')).toMatchObject({ version: 3, seq: 1_001 })
    await first.log.close()
    await s.close()

    s = createSqliteStorage({ file, clock: () => now, tablesDir: join(dir, 'tables') })
    const scannedFrom: number[] = []
    const originalScan = s.scan.bind(s)
    s.scan = async (key, query) => {
      scannedFrom.push(query.fromSeq ?? 1)
      return originalScan(key, query)
    }
    const warm = await openTracked({ ...options, storage: s, writerRunId: 'r2' })
    expect(warm.tracker.state.lastSeq).toBe(1_001)
    expect(warm.surface.nodes()).toHaveLength(1_001)
    expect(warm.ui.diagnostics().applied).toBe(1_001)
    // Rows are folded while the open verifies them; nothing reads them a second time.
    expect(scannedFrom).toEqual([])
    await warm.log.close()
    await s.close()

    const raw = new DatabaseSync(file)
    raw.exec("UPDATE fold_cache SET payload = payload || ' '")
    raw.close()
    s = createSqliteStorage({ file, clock: () => now, tablesDir: join(dir, 'tables') })
    const recovered = await openTracked({ ...options, storage: s, writerRunId: 'r3' })
    expect(recovered.tracker.state.lastSeq).toBe(1_001)
    expect(recovered.surface.nodes()).toHaveLength(1_001)
    expect(recovered.ui.diagnostics().applied).toBe(1_001)
    await recovered.log.close()
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
  it('a commit waits out another process briefly holding the ledger write lock', async () => {
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    const child = spawn(process.execPath, [
      '-e',
      `const db = new (require('node:sqlite').DatabaseSync)(process.argv[1])
       db.exec('BEGIN IMMEDIATE')
       process.stdout.write('locked')
       setTimeout(() => { db.exec('COMMIT'); db.close() }, 200)`,
      join(dir, 'sessions.db'),
    ])
    const exited = once(child, 'exit')
    await once(child.stdout, 'data')
    const started = performance.now()
    const committed = await s.commit('k', { events: [ev('user/message', {})], expectedWriterRunId: 'r1' })
    const waited = performance.now() - started
    await exited
    expect(committed).toEqual({ firstSeq: 1, seqs: [1] })
    expect(waited).toBeGreaterThan(100)
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
    expect(() => s.tables('@agnes/base').table('Bad Name')).toThrow(/table name/)
    // The property the name check alone never had: a package handle cannot see, read or drop the
    // ledger tables, because they are not on this connection.
    expect(() => t.all('select * from writer_claims')).toThrow(/no such table/)
    expect(() => t.exec('drop table events')).toThrow(/no such table/)
    // Nor another package's tables.
    expect(() => s.tables('@acme/other').table('usage_ledger').all('select * from usage_ledger')).toThrow(
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

  it('adds nullable integrity columns to a legacy events table without rewriting rows', async () => {
    const file = join(dir, 'legacy.db')
    const legacy = new DatabaseSync(file)
    legacy.exec(`CREATE TABLE events (
      session_key TEXT NOT NULL, seq INTEGER NOT NULL, ts TEXT NOT NULL, id TEXT NOT NULL,
      type TEXT NOT NULL, lane BLOB NOT NULL, v INTEGER NOT NULL, actor TEXT NOT NULL,
      origin TEXT NOT NULL, trust TEXT NOT NULL, register TEXT, ignorable INTEGER,
      surface_op TEXT, source_event_seqs TEXT, data TEXT NOT NULL,
      PRIMARY KEY (session_key, seq))`)
    legacy.exec(`INSERT INTO events VALUES (
      'k', 1, '2026-09-12T00:00:00.000Z', 'old', 'user/message', x'6d61696e', 1,
      '{"id":"u","org":"local","role":"owner","deptPath":[],"attrs":{}}',
      'principal', 'trusted', NULL, NULL, NULL, NULL, '{"content":[]}')`)
    legacy.close()

    const migrated = createSqliteStorage({ file, clock: () => now, tablesDir: join(dir, 'legacy-tables') })
    const opened = await migrated.open('k', { writerRunId: 'new', ttlMs: 1000 })
    expect(opened.lastSeq).toBe(1)
    expect(await migrated.scanIntegrity('k', { fromSeq: 1, toSeq: 1, limit: 10 })).toMatchObject([
      { sessionKey: 'k', event: { id: 'old', seq: 1 }, integrity: null },
    ])
    await migrated.close()
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
    await log.append([ev('user/message', { content: [{ type: 'text', text: 'original' }] })])
    await log.close()
    await s.close()

    const attacker = new DatabaseSync(file)
    attacker
      .prepare('UPDATE events SET data = ? WHERE session_key = ? AND seq = 1')
      .run(JSON.stringify({ content: [{ type: 'text', text: 'changed' }] }), 'protected')
    attacker.close()

    s = createSqliteStorage({ file, clock: () => now + 5000, tablesDir: join(dir, 'tables') })
    await expect(
      SessionLogImpl.open({
        storage: s,
        key: 'protected',
        writerRunId: 'reader',
        ttlMs: 1000,
        ids: defaultIds(),
        clock: () => now + 5000,
        timers: { setTimeout: () => 0, clearTimeout: () => undefined },
      }),
    ).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
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
})
