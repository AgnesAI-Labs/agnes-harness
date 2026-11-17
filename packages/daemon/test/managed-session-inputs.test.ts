import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { TableHandle } from '@agnes/daemon-foundation/storage/table'
import { describe, expect, it } from 'vitest'
import { ManagedSessionInputs, type NewManagedInput } from '../src/supervisor/managed-session-inputs.js'
import { ManagedSessionRecords } from '../src/supervisor/managed-session-records.js'

function open(wrap?: (table: TableHandle) => TableHandle): { table: TableHandle; db: DatabaseSync } {
  const db = new DatabaseSync(':memory:')
  const table: TableHandle = {
    exec(sql, values) {
      if (values?.length) db.prepare(sql).run(...(values as SQLInputValue[]))
      else db.exec(sql)
    },
    get: (sql, values) => db.prepare(sql).get(...((values ?? []) as SQLInputValue[])) as never,
    all: (sql, values) => db.prepare(sql).all(...((values ?? []) as SQLInputValue[])) as never,
    transaction(fn) {
      db.exec('BEGIN')
      try {
        const value = fn()
        db.exec('COMMIT')
        return value
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
  return { table: wrap ? wrap(table) : table, db }
}

const session = (sessionId: string, owner = 'pkg-a#row', startKey = `start-${sessionId}`) => ({
  sessionId,
  owner,
  startKey,
  bundle: 'bundle',
  workspace: '/w',
  retention: 'task' as const,
  permission: 'default' as const,
  model: null,
  memoryWrites: true,
  skillInstalls: true,
})

const input = (over: Partial<NewManagedInput> = {}): NewManagedInput => ({
  owner: 'pkg-a#row',
  sessionId: 's1',
  key: 'k1',
  bindingDigest: 'digest-1',
  actorOwner: 'row',
  receiptId: null,
  kind: 'ownerMessage',
  taskId: 'task',
  taskGeneration: 1,
  startKey: 'start-s1',
  contentDigest: null,
  text: 'hello',
  source: { eventId: 'e1' },
  state: 'queued',
  reason: 'busy',
  itemCommandId: null,
  submittedSeq: null,
  consumedTurn: null,
  consumedSeq: null,
  ...over,
})

function fixture(clock = () => 1_000) {
  const { table, db } = open()
  return {
    table,
    db,
    records: new ManagedSessionRecords(table),
    inputs: new ManagedSessionInputs(table, clock),
  }
}

const columns = (db: DatabaseSync, name: string) => db.prepare(`PRAGMA table_info(${name})`).all()

describe('managed session records: bindings and owner inputs', () => {
  it('opening an existing database adds the two tables and leaves managed_sessions and managed_session_sends unchanged', () => {
    const { table, db } = open()
    table.exec(`CREATE TABLE managed_sessions (
      session_id TEXT PRIMARY KEY, owner TEXT NOT NULL, start_key TEXT NOT NULL, bundle TEXT NOT NULL,
      workspace TEXT NOT NULL, retention TEXT NOT NULL, permission TEXT NOT NULL,
      model TEXT, memory_writes INTEGER NOT NULL DEFAULT 1,
      skill_installs INTEGER NOT NULL DEFAULT 1, started INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0, UNIQUE (owner, start_key)
    )`)
    table.exec(`CREATE TABLE managed_session_sends (
      owner TEXT NOT NULL, session_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, state TEXT NOT NULL,
      PRIMARY KEY (owner, session_id, idempotency_key)
    )`)
    const before = [columns(db, 'managed_sessions'), columns(db, 'managed_session_sends')]
    new ManagedSessionRecords(table)
    new ManagedSessionRecords(table)
    expect([columns(db, 'managed_sessions'), columns(db, 'managed_session_sends')]).toEqual(before)
    expect(columns(db, 'managed_session_bindings').map((c) => (c as { name: string }).name)).toEqual([
      'session_id',
      'task_id',
      'task_generation',
      'input_digest',
    ])
    expect(columns(db, 'managed_session_inputs')).toHaveLength(23)
  })

  it('insert with a binding writes both rows in one transaction', () => {
    const { records } = fixture()
    records.insert(session('s1'), { taskId: 't', taskGeneration: 3, inputDigest: 'd' })
    expect(records.binding('s1')).toEqual({
      sessionId: 's1',
      taskId: 't',
      taskGeneration: 3,
      inputDigest: 'd',
    })
    expect(records.get('s1')?.startKey).toBe('start-s1')

    const failing = open((inner) => ({
      ...inner,
      exec(sql, values) {
        if (sql.includes('INSERT INTO managed_session_bindings')) throw new Error('injected')
        inner.exec(sql, values)
      },
    }))
    const broken = new ManagedSessionRecords(failing.table)
    expect(() => broken.insert(session('s2'), { taskId: 't', taskGeneration: 1, inputDigest: null })).toThrow(
      'injected',
    )
    expect(broken.get('s2')).toBeUndefined()
    expect(broken.binding('s2')).toBeUndefined()
  })

  it('a repeated or conflicting insert never rewrites or orphans a binding', () => {
    const { records } = fixture()
    records.insert(session('s1'), { taskId: 't', taskGeneration: 1, inputDigest: 'd' })
    records.insert(session('s1'), { taskId: 'other', taskGeneration: 9, inputDigest: 'x' })
    expect(records.binding('s1')).toMatchObject({ taskId: 't', taskGeneration: 1, inputDigest: 'd' })
    // Same (owner, startKey) under another session id: the session insert is ignored, so no binding is written.
    records.insert(session('s3', undefined, 'start-s1'), {
      taskId: 't',
      taskGeneration: 1,
      inputDigest: null,
    })
    expect(records.binding('s3')).toBeUndefined()
  })

  it('bindLate binds once and returns false afterwards', () => {
    const { records } = fixture()
    records.insert(session('s1'))
    expect(records.binding('s1')).toBeUndefined()
    expect(records.bindLate({ sessionId: 's1', taskId: 't', taskGeneration: 2, inputDigest: null })).toBe(
      true,
    )
    expect(records.binding('s1')).toEqual({
      sessionId: 's1',
      taskId: 't',
      taskGeneration: 2,
      inputDigest: null,
    })
    expect(records.bindLate({ sessionId: 's1', taskId: 'u', taskGeneration: 5, inputDigest: null })).toBe(
      false,
    )
    expect(records.binding('s1')?.taskId).toBe('t')
    // A session without a record cannot be bound: nothing could ever release it.
    expect(records.bindLate({ sessionId: 'ghost', taskId: 't', taskGeneration: 1, inputDigest: null })).toBe(
      false,
    )
    expect(records.binding('ghost')).toBeUndefined()
  })

  it('reserve returns exists for the same key and receiptTaken for a receipt bound elsewhere', () => {
    const { inputs } = fixture()
    expect(inputs.reserve(input({ receiptId: 'r1' }))).toBe('reserved')
    const stored = inputs.get('pkg-a#row', 's1', 'k1')
    expect(stored).toMatchObject({
      version: 1,
      state: 'queued',
      reason: 'busy',
      text: 'hello',
      source: { eventId: 'e1' },
    })
    expect(stored?.history).toEqual([
      { version: 1, state: 'queued', reason: 'busy', at: 1_000, by: 'platform' },
    ])
    expect(stored).toMatchObject({ createdAt: 1_000, updatedAt: 1_000 })
    expect(inputs.reserve(input({ receiptId: 'r1', text: 'changed' }))).toBe('exists')
    expect(inputs.get('pkg-a#row', 's1', 'k1')?.text).toBe('hello')
    expect(inputs.reserve(input({ key: 'k2', receiptId: 'r1' }))).toBe('receiptTaken')
    expect(inputs.reserve(input({ sessionId: 's2', receiptId: 'r1' }))).toBe('receiptTaken')
    expect(inputs.get('pkg-a#row', 's1', 'k2')).toBeUndefined()
    // Rows without a receipt never collide with each other.
    expect(inputs.reserve(input({ key: 'k3' }))).toBe('reserved')
    expect(inputs.reserve(input({ key: 'k4' }))).toBe('reserved')
  })

  it('transition is compare-and-set on version, bumps version by one and appends history', () => {
    let now = 1_000
    const { inputs } = fixture(() => now)
    inputs.reserve(input())
    now = 2_000
    const next = inputs.transition(
      'pkg-a#row',
      's1',
      'k1',
      1,
      { state: 'enqueued', reason: 'eligible', itemCommandId: 'cmd', submittedSeq: 7 },
      'platform',
    )
    expect(next).toMatchObject({
      version: 2,
      state: 'enqueued',
      reason: 'eligible',
      itemCommandId: 'cmd',
      submittedSeq: 7,
      text: 'hello',
      updatedAt: 2_000,
      createdAt: 1_000,
    })
    expect(next?.history.map((h) => [h.version, h.state, h.reason, h.at, h.by])).toEqual([
      [1, 'queued', 'busy', 1_000, 'platform'],
      [2, 'enqueued', 'eligible', 2_000, 'platform'],
    ])
    // Stale version: nothing changes.
    expect(
      inputs.transition('pkg-a#row', 's1', 'k1', 1, { state: 'retained', reason: 'ownerDiscarded' }, 'owner'),
    ).toBeUndefined()
    expect(inputs.get('pkg-a#row', 's1', 'k1')).toMatchObject({ version: 2, state: 'enqueued' })
    // Unknown row.
    expect(
      inputs.transition(
        'pkg-a#row',
        's1',
        'nope',
        1,
        { state: 'retained', reason: 'ownerDiscarded' },
        'owner',
      ),
    ).toBeUndefined()
    // An explicit null clears; omitted fields are kept.
    const done = inputs.transition(
      'pkg-a#row',
      's1',
      'k1',
      2,
      { state: 'consumed', reason: 'eligible', text: null, consumedTurn: 4, consumedSeq: 9 },
      'owner',
    )
    expect(done).toMatchObject({
      version: 3,
      text: null,
      itemCommandId: 'cmd',
      submittedSeq: 7,
      consumedTurn: 4,
      consumedSeq: 9,
    })
    expect(done?.history.at(-1)).toMatchObject({ version: 3, by: 'owner' })
  })

  it('held lists unsubmitted rows in admission order; inFlight lists submitted unconsumed rows', () => {
    const { inputs } = fixture()
    const owner = 'pkg-a#row'
    inputs.reserve(input({ key: 'a', state: 'queued' }))
    inputs.reserve(input({ key: 'b', state: 'waitingQuestion', reason: 'questionOpen' }))
    inputs.reserve(input({ key: 'c', state: 'enqueued', reason: 'busy' }))
    inputs.reserve(
      input({ key: 'd', state: 'enqueued', reason: 'eligible', submittedSeq: 5, itemCommandId: 'x' }),
    )
    inputs.reserve(input({ key: 'e', state: 'consumed', reason: 'eligible', submittedSeq: 3 }))
    inputs.reserve(input({ key: 'f', state: 'needsOwner', reason: 'grantRevoked' }))
    inputs.reserve(input({ key: 'g', sessionId: 'other', state: 'queued' }))
    expect(inputs.held('s1').map((r) => r.key)).toEqual(['a', 'b', 'c'])
    expect(inputs.inFlight('s1').map((r) => r.key)).toEqual(['d'])
    expect(inputs.held('nobody')).toEqual([])
    expect(inputs.sessionsWithWork().sort()).toEqual(['other', 's1'])
    // Non-terminal rows of one owner, for revocation: needsOwner still awaits the owner; consumed does not.
    expect(inputs.byOwner(owner).map((r) => r.key)).toEqual(['a', 'b', 'c', 'd', 'f', 'g'])
    expect(inputs.byOwner('nobody')).toEqual([])
    inputs.transition(
      owner,
      's1',
      'd',
      1,
      { state: 'consumed', reason: 'eligible', consumedTurn: 1, consumedSeq: 6 },
      'platform',
    )
    expect(inputs.inFlight('s1')).toEqual([])
  })

  it('text over 64 KiB is refused', () => {
    const { inputs } = fixture()
    const limit = 64 * 1024
    expect(inputs.reserve(input({ key: 'ok', text: 'x'.repeat(limit) }))).toBe('reserved')
    expect(() => inputs.reserve(input({ key: 'big', text: 'x'.repeat(limit + 1) }))).toThrow(RangeError)
    // The limit counts UTF-8 bytes, not characters.
    expect(() =>
      inputs.reserve(input({ key: 'wide', text: '中'.repeat(Math.floor(limit / 3) + 1) })),
    ).toThrow(RangeError)
    expect(inputs.get('pkg-a#row', 's1', 'big')).toBeUndefined()
    expect(() =>
      inputs.transition(
        'pkg-a#row',
        's1',
        'ok',
        1,
        { state: 'queued', reason: 'busy', text: 'x'.repeat(limit + 1) },
        'platform',
      ),
    ).toThrow(RangeError)
    expect(inputs.get('pkg-a#row', 's1', 'ok')?.version).toBe(1)
  })

  it("releasePackage removes the package's bindings and inputs and keeps other packages' rows", () => {
    const { records, inputs, db } = fixture()
    const mine = 'pkg-a#row'
    const theirs = 'pkg-b#row'
    records.insert(session('s1', mine), { taskId: 't', taskGeneration: 1, inputDigest: null })
    records.insert(session('s2', theirs), { taskId: 't', taskGeneration: 1, inputDigest: null })
    inputs.reserve(input({ owner: mine, sessionId: 's1', receiptId: 'r1' }))
    inputs.reserve(input({ owner: theirs, sessionId: 's2', key: 'k9', receiptId: 'r2' }))
    records.releasePackage('pkg-a')
    expect(records.binding('s1')).toBeUndefined()
    expect(inputs.get(mine, 's1', 'k1')).toBeUndefined()
    expect(inputs.sessionsWithWork()).toEqual(['s2'])
    expect(records.binding('s2')).toBeDefined()
    expect(inputs.get(theirs, 's2', 'k9')).toBeDefined()
    // The session record stays, moved to an owner no grant key can produce.
    expect(records.get('s1')?.owner).toBe('~s1')
    // The released receipt is free again.
    expect(inputs.reserve(input({ owner: theirs, sessionId: 's2', key: 'k10', receiptId: 'r1' }))).toBe(
      'reserved',
    )
    expect(db.prepare('SELECT COUNT(*) AS n FROM managed_session_inputs').get()).toEqual({ n: 2 })
  })

  it('held and inFlight use managed_session_inputs_open, the sweep too (a partial index), the receipt lookup its unique index', () => {
    const { table } = fixture()
    const seen: string[] = []
    const spy: TableHandle = {
      ...table,
      all: (sql, values) => {
        seen.push(sql)
        return table.all(sql, values)
      },
    }
    const inputs = new ManagedSessionInputs(spy)
    inputs.held('s1')
    inputs.inFlight('s1')
    inputs.sessionsWithWork()
    const plans = seen.map((sql) =>
      table
        .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, sql.includes('?') ? ['s1'] : [])
        .map((row) => row.detail)
        .join('\n'),
    )
    expect(plans[0]).toContain('managed_session_inputs_open')
    expect(plans[1]).toContain('managed_session_inputs_open')
    expect(plans[2]).toContain('managed_session_inputs_open')
    for (const plan of plans) expect(plan).not.toMatch(/\bSCAN managed_session_inputs$/m)
    expect(
      table
        .all<{ detail: string }>(
          'EXPLAIN QUERY PLAN SELECT * FROM managed_session_inputs WHERE receipt_id = ?',
          ['r'],
        )
        .map((row) => row.detail)
        .join('\n'),
    ).toContain('managed_session_inputs_receipt')
  })
})
