import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSqliteStorage, DDL, type SqliteStorage } from '../../src/adapters/storage-sqlite.js'

describe('sqlite child control', () => {
  let dir: string
  let s: SqliteStorage
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agnes-child-sql-'))
    s = createSqliteStorage({ file: join(dir, 'sessions.db'), tablesDir: join(dir, 'tables') })
  })
  afterEach(async () => {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('persists a child identity and refuses a second overlapping reservation', async () => {
    await s.open('parent', { writerRunId: 'r1', ttlMs: 1000 })
    await s.ensureRootScope('root', 10_000_000n)
    const created = await s.createDelegatedChild({
      childKey: 'parent/child',
      parentKey: 'parent',
      boundarySeq: 1,
      creationId: 'parent:main:direct:1',
      kind: 'spawn',
      rootTaskId: 'root',
      runtimeOwnerSessionKey: 'parent',
      generationDepth: 1,
      generationLimit: 2,
      maxFanOut: 4,
      inputHash: 'abc',
      inputText: 'task',
      cwd: '/w',
      actorId: 'u',
      isolation: 'shared',
      workspaceId: 'ws:parent/child',
      treeCapMicro: 10_000_000n,
      childCapMicro: null,
      writerRunId: 'r1/child',
    })
    expect(created.status).toBe('created')
    const again = await s.createDelegatedChild({
      childKey: 'parent/other',
      parentKey: 'parent',
      boundarySeq: 1,
      creationId: 'parent:main:direct:1',
      kind: 'spawn',
      rootTaskId: 'root',
      runtimeOwnerSessionKey: 'parent',
      generationDepth: 1,
      generationLimit: 2,
      maxFanOut: 4,
      inputHash: 'abc',
      inputText: 'task',
      cwd: '/w',
      actorId: 'u',
      isolation: 'shared',
      workspaceId: 'ws:other',
      treeCapMicro: 10_000_000n,
      childCapMicro: null,
      writerRunId: 'r1/child',
    })
    expect(again.status).toBe('existing')
    const first = await s.reserve({
      rootTaskId: 'root',
      scopeIds: ['root:root'],
      qMicro: 8_000_000n,
      effectId: 'a',
      requestHash: 'a',
      writerGeneration: 1,
    })
    const second = await s.reserve({
      rootTaskId: 'root',
      scopeIds: ['root:root'],
      qMicro: 8_000_000n,
      effectId: 'b',
      requestHash: 'b',
      writerGeneration: 1,
    })
    expect(first.ok).toBe(true)
    expect(second).toMatchObject({ ok: false, reason: 'cap' })
  })

  it('rejects a stale writer generation after bump', async () => {
    await s.ensureRootScope('root', 10_000_000n)
    await s.bumpWriterGeneration?.('root')
    await s.bumpWriterGeneration?.('root')
    const stale = await s.reserve({
      rootTaskId: 'root',
      scopeIds: ['root:root'],
      qMicro: 1n,
      effectId: 'old',
      requestHash: 'h',
      writerGeneration: 1,
    })
    expect(stale).toMatchObject({ ok: false, reason: 'invalid' })
    const live = await s.reserve({
      rootTaskId: 'root',
      scopeIds: ['root:root'],
      qMicro: 1n,
      effectId: 'new',
      requestHash: 'h',
      writerGeneration: 3,
    })
    expect(live.ok).toBe(true)
    const sibling = await s.reserve({
      rootTaskId: 'root',
      scopeIds: ['root:root'],
      qMicro: 1n,
      effectId: 'new-sibling',
      requestHash: 's',
      writerGeneration: 3,
    })
    expect(sibling.ok).toBe(true)
    await expect(
      s.reserve({
        rootTaskId: 'root',
        scopeIds: ['root:root'],
        qMicro: 1n,
        effectId: 'future',
        requestHash: 'h',
        writerGeneration: 4,
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid' })
    if (!live.ok) throw new Error('expected live reservation')
    const takenOver = await s.takeoverReservation?.(live.permitId, 3)
    expect(takenOver).toMatchObject({ permitId: live.permitId, writerGeneration: 4, status: 'held' })
    if (!sibling.ok) throw new Error('expected sibling reservation')
    await expect(s.peekReservation?.(sibling.permitId)).resolves.toMatchObject({
      status: 'held',
      writerGeneration: 4,
    })
    await expect(s.releaseReservation({ permitId: sibling.permitId, writerGeneration: 3 })).rejects.toThrow(
      'stale reservation writer generation',
    )
    await expect(s.releaseReservation({ permitId: live.permitId, writerGeneration: 3 })).rejects.toThrow(
      'stale reservation writer generation',
    )
    await expect(
      s.settleOrigin({
        permitId: live.permitId,
        writerGeneration: 3,
        originSessionKey: 'session',
        originCostSeq: 90,
        actualMicro: 1n,
        complete: true,
        creditSource: 'estimated',
      }),
    ).rejects.toThrow('stale reservation writer generation')
    await expect(
      s.settleOrigin({
        permitId: live.permitId,
        writerGeneration: 4,
        originSessionKey: 'session',
        originCostSeq: 91,
        actualMicro: 1n,
        complete: true,
        creditSource: 'estimated',
      }),
    ).resolves.toBeUndefined()
    await expect(s.peekReservation?.(live.permitId)).resolves.toMatchObject({ status: 'settled' })
    await expect(
      s.releaseReservation({ permitId: sibling.permitId, writerGeneration: 4 }),
    ).resolves.toBeUndefined()
  })

  it('allocates a new permit id after the process reopens the same database', async () => {
    await s.ensureRootScope('root', 10_000_000n)
    const first = await s.reserve({
      rootTaskId: 'root',
      scopeIds: ['root:root'],
      qMicro: 1n,
      effectId: 'a',
      requestHash: 'h',
      writerGeneration: 1,
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    await s.close()
    s = createSqliteStorage({ file: join(dir, 'sessions.db'), tablesDir: join(dir, 'tables') })
    const again = await s.reserve({
      rootTaskId: 'root',
      scopeIds: ['root:root'],
      qMicro: 1n,
      effectId: 'b',
      requestHash: 'h',
      writerGeneration: 1,
    })
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.permitId).not.toBe(first.permitId)
  })

  it('atomically reuses a durable reservation identity across retries and process reopen', async () => {
    await s.ensureRootScope('root', 10_000_000n)
    const request = {
      rootTaskId: 'root',
      scopeIds: ['root:root'],
      qMicro: 2_000_000n,
      effectId: 'effect-idempotent',
      requestHash: 'a'.repeat(64),
      writerGeneration: 1,
    }
    const [first, concurrent] = await Promise.all([s.reserve(request), s.reserve(request)])
    expect(first).toMatchObject({ ok: true, existing: false, status: 'held' })
    expect(concurrent).toMatchObject({ ok: true, existing: true, status: 'held' })
    if (!first.ok || !concurrent.ok) return
    expect(concurrent.permitId).toBe(first.permitId)
    expect((await s.projectTree('root'))?.heldMicro).toBe(2_000_000n)

    await s.close()
    s = createSqliteStorage({ file: join(dir, 'sessions.db'), tablesDir: join(dir, 'tables') })
    await expect(s.reserve(request)).resolves.toMatchObject({
      ok: true,
      existing: true,
      status: 'held',
      permitId: first.permitId,
    })
    await expect(
      s.lookupReservationByIdentity?.('root', request.effectId, request.requestHash),
    ).resolves.toMatchObject({ permitId: first.permitId, status: 'held' })
    await expect(s.reserve({ ...request, qMicro: 3_000_000n })).resolves.toMatchObject({
      ok: false,
      reason: 'invalid',
    })
    await expect(s.reserve({ ...request, requestHash: 'b'.repeat(64) })).resolves.toMatchObject({
      ok: false,
      reason: 'invalid',
    })
  })

  it('durably binds a cost origin to one permit without consuming a colliding hold', async () => {
    await s.ensureRootScope('root', 10_000_000n)
    const first = await s.reserve({
      rootTaskId: 'root',
      scopeIds: ['root:root'],
      qMicro: 2_000_000n,
      effectId: 'origin-first',
      requestHash: 'a'.repeat(64),
      writerGeneration: 1,
    })
    const second = await s.reserve({
      rootTaskId: 'root',
      scopeIds: ['root:root'],
      qMicro: 3_000_000n,
      effectId: 'origin-second',
      requestHash: 'b'.repeat(64),
      writerGeneration: 1,
    })
    if (!first.ok || !second.ok) throw new Error('expected reservations')
    const origin = { originSessionKey: 'session', originCostSeq: 77 }
    await s.settleOrigin({
      permitId: first.permitId,
      writerGeneration: 1,
      ...origin,
      actualMicro: 1_000_000n,
      complete: true,
      creditSource: 'estimated',
    })
    await expect(
      s.settleOrigin({
        permitId: second.permitId,
        writerGeneration: 1,
        ...origin,
        actualMicro: 1_000_000n,
        complete: true,
        creditSource: 'estimated',
      }),
    ).rejects.toThrow('cost origin conflicts')
    await expect(s.peekReservation?.(second.permitId)).resolves.toMatchObject({ status: 'held' })
    await expect(s.projectTree('root')).resolves.toMatchObject({
      settledMicro: 1_000_000n,
      heldMicro: 3_000_000n,
    })

    await s.close()
    s = createSqliteStorage({ file: join(dir, 'sessions.db'), tablesDir: join(dir, 'tables') })
    await expect(
      s.settleOrigin({
        permitId: second.permitId,
        writerGeneration: 1,
        ...origin,
        actualMicro: 1_000_000n,
        complete: true,
        creditSource: 'estimated',
      }),
    ).rejects.toThrow('cost origin conflicts')
    await expect(s.peekReservation?.(second.permitId)).resolves.toMatchObject({ status: 'held' })
  })

  it('migrates legacy duplicate identities without dropping their conservative holds', async () => {
    await s.close()
    const file = join(dir, 'legacy.db')
    const legacy = new DatabaseSync(file)
    for (const ddl of DDL) legacy.exec(ddl)
    legacy
      .prepare(
        'INSERT INTO budget_scopes (scope_id, root_task_id, child_key, parent_scope_id, cap_micro, settled_micro, held_micro) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run('root:root', 'root', null, null, '10000000', '0', '4000000')
    const insert = legacy.prepare(
      'INSERT INTO budget_reservations (permit_id, root_task_id, scope_ids, q_micro, effect_id, request_hash, writer_generation, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    insert.run('p1', 'root', '["root:root"]', '2000000', 'duplicate', 'a'.repeat(64), 1, 'held')
    insert.run('p2', 'root', '["root:root"]', '2000000', 'duplicate', 'a'.repeat(64), 1, 'held')
    legacy.close()

    s = createSqliteStorage({ file, tablesDir: join(dir, 'tables-legacy') })
    expect(s.childControlFormat()).toBe(4)
    await expect(s.lookupReservationByIdentity?.('root', 'duplicate', 'a'.repeat(64))).resolves.toMatchObject(
      {
        permitId: 'p1',
        status: 'held',
      },
    )
    await expect(s.peekReservation?.('p2')).resolves.toMatchObject({
      permitId: 'p2',
      effectId: expect.stringContaining('__agnes_legacy_duplicate__:'),
      status: 'unknown',
    })
    expect((await s.projectTree('root'))?.heldMicro).toBe(4_000_000n)
    expect((await s.projectTree('root'))?.unknownHeld).toBe(true)
  })

  it('refuses a newer control format before applying the reservation migration', async () => {
    await s.close()
    const file = join(dir, 'future.db')
    const future = new DatabaseSync(file)
    for (const ddl of DDL) future.exec(ddl)
    future.prepare('INSERT INTO child_control_meta (id, version) VALUES (1, ?)').run(5)
    future.close()

    expect(() => createSqliteStorage({ file, tablesDir: join(dir, 'tables-future') })).toThrow(
      /newer than runtime 4/,
    )
  })

  it('persists exact creation-attempt CAS facts across reopen and fences a stale attempt', async () => {
    await s.open('parent', { writerRunId: 'r1', ttlMs: 1000 })
    await s.ensureRootScope('root', 10_000_000n)
    const input = {
      childKey: 'parent/attempt',
      parentKey: 'parent',
      boundarySeq: 1,
      creationId: 'creation:attempt',
      attemptId: 'attempt:1',
      attemptStartedAt: 100,
      kind: 'spawn',
      rootTaskId: 'root',
      runtimeOwnerSessionKey: 'parent',
      generationDepth: 1,
      generationLimit: 2,
      maxFanOut: 4,
      inputHash: 'abc',
      inputText: 'task',
      cwd: '/w',
      actorId: 'u',
      isolation: 'shared',
      workspaceId: 'ws:attempt',
      treeCapMicro: 10_000_000n,
      childCapMicro: null,
      writerRunId: 'r1/child',
    } as const
    const created = await s.createDelegatedChild(input)
    expect(created).toMatchObject({
      status: 'created',
      record: { attemptId: 'attempt:1', creationPhase: 'creating', creationRevision: 1 },
    })
    const deferred = await s.deferCreatingChild({
      childKey: 'parent/attempt',
      creationId: 'creation:attempt',
      attemptId: 'attempt:1',
      expectedRevision: 1,
      deferredAt: 110,
    })
    await expect(
      s.deferCreatingChild({
        childKey: 'parent/attempt',
        creationId: 'creation:attempt',
        attemptId: 'attempt:1',
        expectedRevision: 1,
        deferredAt: 999,
      }),
    ).resolves.toEqual(deferred)

    await s.close()
    s = createSqliteStorage({ file: join(dir, 'sessions.db'), tablesDir: join(dir, 'tables') })
    await expect(s.lookupByKey('parent/attempt')).resolves.toMatchObject({
      creationPhase: 'deferred',
      deferredFact: deferred,
    })
    const attached = await s.beginChildAttempt({
      childKey: 'parent/attempt',
      creationId: 'creation:attempt',
      previousAttemptId: 'attempt:1',
      nextAttemptId: 'attempt:2',
      expectedRevision: 2,
      startedAt: 120,
    })
    expect(attached).toMatchObject({
      attemptId: 'attempt:2',
      creationPhase: 'creating',
      creationRevision: 3,
      attemptStartedAt: 120,
    })
    await expect(s.listCreatingChildAttempts()).resolves.toHaveLength(1)
    await expect(
      s.cancelCreatingChild({
        childKey: 'parent/attempt',
        creationId: 'creation:attempt',
        attemptId: 'attempt:1',
        expectedRevision: 1,
        reason: 'open_failed',
        cancelledAt: 130,
      }),
    ).rejects.toMatchObject({ code: 'E_CAS' })
    const cancelled = await s.cancelCreatingChild({
      childKey: 'parent/attempt',
      creationId: 'creation:attempt',
      attemptId: 'attempt:2',
      expectedRevision: 3,
      reason: 'workspace_closed',
      cancelledAt: 140,
    })
    await expect(
      s.cancelCreatingChild({
        childKey: 'parent/attempt',
        creationId: 'creation:attempt',
        attemptId: 'attempt:2',
        expectedRevision: 3,
        reason: 'open_failed',
        cancelledAt: 999,
      }),
    ).resolves.toEqual(cancelled)

    await s.createDelegatedChild({
      ...input,
      childKey: 'parent/commit',
      creationId: 'creation:commit',
      attemptId: 'attempt:commit',
      workspaceId: 'ws:commit',
    })
    const commitCas = {
      childKey: 'parent/commit',
      creationId: 'creation:commit',
      attemptId: 'attempt:commit',
      expectedRevision: 1,
    }
    await expect(s.commitCreatingChild(commitCas)).resolves.toBe(true)
    await expect(s.commitCreatingChild(commitCas)).resolves.toBe(true)
    await expect(
      s.cancelCreatingChild({
        ...commitCas,
        reason: 'open_failed',
        cancelledAt: 150,
      }),
    ).rejects.toMatchObject({ code: 'E_CAS' })
  })

  it('migrates format-3 child rows to committed format-4 creation records', async () => {
    await s.close()
    const file = join(dir, 'format-3.db')
    const legacy = new DatabaseSync(file)
    for (const ddl of DDL) legacy.exec(ddl)
    legacy.exec('DROP TABLE child_tasks')
    legacy.exec(`CREATE TABLE child_tasks (
      child_key TEXT PRIMARY KEY, creation_id TEXT NOT NULL UNIQUE, parent_key TEXT NOT NULL,
      root_task_id TEXT NOT NULL, runtime_owner TEXT NOT NULL, kind TEXT NOT NULL,
      generation_depth INTEGER NOT NULL, generation_limit INTEGER NOT NULL, input_hash TEXT NOT NULL,
      input_text TEXT NOT NULL DEFAULT '', cwd TEXT NOT NULL, actor_id TEXT NOT NULL, budget_scope_id TEXT NOT NULL,
      ancestor_scope_ids TEXT NOT NULL, workspace_id TEXT, isolation TEXT NOT NULL,
      state TEXT NOT NULL, state_revision INTEGER NOT NULL, control_format INTEGER NOT NULL)`)
    legacy
      .prepare(
        'INSERT INTO sessions (session_key, format_version, parent_key, boundary_seq, created_at) VALUES (?, 1, ?, ?, ?)',
      )
      .run('parent/legacy', 'parent', 0, new Date(0).toISOString())
    legacy
      .prepare(`INSERT INTO child_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        'parent/legacy',
        'creation:legacy',
        'parent',
        'root',
        'parent',
        'spawn',
        1,
        2,
        'abc',
        'task',
        '/w',
        'u',
        'root:root',
        '["root:root"]',
        null,
        'shared',
        'ready',
        2,
        3,
      )
    legacy.prepare('INSERT INTO child_control_meta (id, version) VALUES (1, 3)').run()
    legacy.close()

    s = createSqliteStorage({ file, tablesDir: join(dir, 'tables-format-3') })
    expect(s.childControlFormat()).toBe(4)
    await expect(s.lookupByKey('parent/legacy')).resolves.toMatchObject({
      attemptId: 'legacy:creation:legacy',
      creationPhase: 'committed',
      creationRevision: 1,
      attemptStartedAt: 0,
      controlFormat: 4,
    })
  })
})
