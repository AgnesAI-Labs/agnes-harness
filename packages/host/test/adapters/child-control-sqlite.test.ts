import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSqliteStorage, DDL, type SqliteStorage } from '../../src/adapters/storage-sqlite.js'
import { ev } from './events.js'

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

  it('atomically fences all delegated allocation phases, including fresh children and later raw reopen', async () => {
    await s.open('parent', { writerRunId: 'owner', ttlMs: 100000 })
    await s.commit('parent', {
      expectedWriterRunId: 'owner',
      events: [ev('turn/start', {}), ev('turn/end', {})],
    })
    await s.ensureRootScope('budget-tree', null)
    const input = (childKey: string, parentKey = 'parent') => ({
      childKey,
      parentKey,
      boundarySeq: 0,
      creationId: `create:${childKey}`,
      attemptId: `attempt:${childKey}`,
      kind: 'spawn' as const,
      seedMode: 'fresh' as const,
      rootTaskId: 'budget-tree',
      runtimeOwnerSessionKey: 'parent',
      generationDepth: 1,
      generationLimit: 4,
      maxFanOut: 8,
      inputHash: 'task',
      inputText: 'task',
      cwd: '/w',
      actorId: 'u',
      isolation: 'shared' as const,
      workspaceId: `ws:${childKey}`,
      treeCapMicro: null,
      childCapMicro: null,
      writerRunId: `writer:${childKey}`,
    })
    await s.createDelegatedChild(input('fresh'))
    await s.createDelegatedChild(input('grandchild', 'fresh'))
    await s.createDelegatedChild(input('deferred'))
    await s.deferCreatingChild({
      childKey: 'deferred',
      creationId: 'create:deferred',
      attemptId: 'attempt:deferred',
      expectedRevision: 1,
      deferredAt: 1,
    })
    await s.createDelegatedChild(input('failed'))
    await s.cancelCreatingChild({
      childKey: 'failed',
      creationId: 'create:failed',
      attemptId: 'attempt:failed',
      expectedRevision: 1,
      reason: 'open_failed',
      cancelledAt: 1,
    })
    expect((await s.open('fresh', { writerRunId: 'fresh-owner', ttlMs: 100000 })).parent).toBeUndefined()
    expect(await s.scan('grandchild', { limit: 1 })).toEqual([])
    await s.createChild('parent', 2, 'external-history')
    const reservation = await s.reserve({
      rootTaskId: 'budget-tree',
      scopeIds: ['root:budget-tree'],
      qMicro: null,
      effectId: 'before',
      requestHash: 'before',
      writerGeneration: 1,
    })
    expect(reservation.ok).toBe(true)
    const other = createSqliteStorage({ file: join(dir, 'sessions.db') })
    const writer = new DatabaseSync(join(dir, 'sessions.db'))
    const retirement = { rootSessionKey: 'parent', retirementId: 'retire', epoch: 1 }
    try {
      writer.exec(
        "CREATE TRIGGER fail_seal BEFORE INSERT ON session_retirement_members WHEN NEW.session_key='grandchild' BEGIN SELECT RAISE(ABORT,'seal failed'); END",
      )
      await expect(s.sealSessionTree(retirement)).rejects.toThrow('seal failed')
      expect((await other.inspectSessionTree('parent')).sealed).toBeUndefined()
      expect(() => other.assertSessionAdmittedTree('parent')).not.toThrow()
      writer.exec('DROP TRIGGER fail_seal')
      const sealed = await s.sealSessionTree(retirement)
      expect(sealed.members.map((row) => row.sessionKey)).toEqual([
        'deferred',
        'failed',
        'fresh',
        'grandchild',
        'parent',
      ])
      expect(sealed.externalHistoryDependents.map((row) => row.sessionKey)).toEqual(['external-history'])
      expect(await s.lookupByKey('fresh')).toMatchObject({ state: 'creating', creationPhase: 'creating' })
      await expect(other.createDelegatedChild(input('late', 'fresh'))).rejects.toMatchObject({
        code: 'E_CLOSED',
      })
      expect(await s.existsSession('late')).toBe(false)
      await expect(
        other.beginChildAttempt({
          childKey: 'deferred',
          creationId: 'create:deferred',
          previousAttemptId: 'attempt:deferred',
          nextAttemptId: 'next',
          expectedRevision: 2,
          startedAt: 2,
        }),
      ).rejects.toMatchObject({ code: 'E_CLOSED' })
      await expect(
        other.commitCreatingChild({
          childKey: 'fresh',
          creationId: 'create:fresh',
          attemptId: 'attempt:fresh',
          expectedRevision: 1,
        }),
      ).rejects.toMatchObject({ code: 'E_CLOSED' })
      await expect(other.casState('fresh', 1, 'ready')).rejects.toMatchObject({ code: 'E_CLOSED' })
      await expect(
        other.reserve({
          rootTaskId: 'budget-tree',
          scopeIds: ['root:budget-tree'],
          qMicro: null,
          effectId: 'after',
          requestHash: 'after',
          writerGeneration: 1,
        }),
      ).rejects.toMatchObject({ code: 'E_CLOSED' })
      if (reservation.ok)
        await other.releaseReservation({ permitId: reservation.permitId, writerGeneration: 1 })
      await other.cancelCreatingChild({
        childKey: 'fresh',
        creationId: 'create:fresh',
        attemptId: 'attempt:fresh',
        expectedRevision: 1,
        reason: 'workspace_closed',
        cancelledAt: 2,
      })
      // Future physical cleanup must not erase the permanent admission receipt.
      writer.exec('DELETE FROM child_tasks; DELETE FROM child_workspaces')
      for (const member of sealed.members) {
        expect(() => other.assertSessionAdmittedTree(member.sessionKey)).toThrow('permanently sealed')
        await expect(
          other.open(member.sessionKey, { writerRunId: 'raw-reopen', ttlMs: 1000 }),
        ).rejects.toMatchObject({ code: 'E_CLOSED' })
      }
      expect((await other.inspectSessionTree('parent')).members.map((row) => row.sessionKey)).toEqual(
        sealed.members.map((row) => row.sessionKey),
      )
    } finally {
      writer.close()
      await other.close()
    }
    await s.close()
    s = createSqliteStorage({ file: join(dir, 'sessions.db') })
    expect(() => s.assertSessionAdmittedTree('grandchild')).toThrow('permanently sealed')
    await expect(
      s.reserve({
        rootTaskId: 'budget-tree',
        scopeIds: ['root:budget-tree'],
        qMicro: null,
        effectId: 'reopen',
        requestHash: 'reopen',
        writerGeneration: 1,
      }),
    ).rejects.toMatchObject({ code: 'E_CLOSED' })
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
    expect(s.childControlFormat()).toBe(5)
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
    future.prepare('INSERT INTO child_control_meta (id, version) VALUES (1, ?)').run(6)
    future.close()

    // The refused file is closed again: Windows cannot delete a directory holding an open database.
    const closes = vi.spyOn(DatabaseSync.prototype, 'close')
    try {
      expect(() => createSqliteStorage({ file, tablesDir: join(dir, 'tables-future') })).toThrow(
        /newer than runtime 5/,
      )
      expect(closes).toHaveBeenCalledOnce()
    } finally {
      closes.mockRestore()
    }
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

  it('migrates format-3 child rows to committed creation records', async () => {
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
    expect(s.childControlFormat()).toBe(5)
    await expect(s.lookupByKey('parent/legacy')).resolves.toMatchObject({
      attemptId: 'legacy:creation:legacy',
      creationPhase: 'committed',
      creationRevision: 1,
      attemptStartedAt: 0,
      controlFormat: 4,
    })
  })

  it('persists unlimited scopes and unknown quotes across reopen without inventing amounts', async () => {
    await s.ensureRootScope('unlimited', null)
    const request = {
      rootTaskId: 'unlimited',
      scopeIds: ['root:unlimited'],
      qMicro: null,
      effectId: 'unknown-quote',
      requestHash: 'bound-request',
      writerGeneration: 1,
    }
    const permit = await s.reserve(request)
    if (!permit.ok) throw new Error(permit.message)
    expect(await s.projectTree('unlimited')).toEqual({
      capMicro: null,
      settledMicro: 0n,
      heldMicro: 0n,
      unknownHeld: true,
    })
    await s.close()
    s = createSqliteStorage({ file: join(dir, 'sessions.db'), tablesDir: join(dir, 'tables') })
    expect(await s.reserve(request)).toMatchObject({ ok: true, permitId: permit.permitId, existing: true })
    expect(await s.peekReservation?.(permit.permitId)).toMatchObject({ qMicro: null, status: 'held' })
    const settle = {
      permitId: permit.permitId,
      writerGeneration: 1,
      originSessionKey: 'parent',
      originCostSeq: 5,
      actualMicro: 9_000_000_000_000n,
      complete: true,
      creditSource: 'gateway' as const,
    }
    await s.settleOrigin(settle)
    await s.close()
    s = createSqliteStorage({ file: join(dir, 'sessions.db'), tablesDir: join(dir, 'tables') })
    await s.settleOrigin(settle)
    expect(await s.projectTree('unlimited')).toEqual({
      capMicro: null,
      settledMicro: settle.actualMicro,
      heldMicro: 0n,
      unknownHeld: false,
    })
    const quoted = await s.reserve({ ...request, effectId: 'known-estimate', qMicro: 1n })
    if (!quoted.ok) throw new Error(quoted.message)
    await s.settleOrigin({ ...settle, permitId: quoted.permitId, originCostSeq: 6, actualMicro: 10n })
    expect((await s.peekReservation?.(quoted.permitId))?.status).toBe('settled')
  })

  it('retains unknown actual spend and fences unknown-quote permits through takeover and release', async () => {
    await s.ensureRootScope('unlimited', null)
    const request = {
      rootTaskId: 'unlimited',
      scopeIds: ['root:unlimited'],
      qMicro: null,
      effectId: 'unknown',
      requestHash: 'bound',
      writerGeneration: 1,
    }
    const permit = await s.reserve(request)
    if (!permit.ok) throw new Error(permit.message)
    await s.takeoverReservation?.(permit.permitId, 1)
    await expect(s.releaseReservation({ permitId: permit.permitId, writerGeneration: 1 })).rejects.toThrow(
      'stale',
    )
    const settlement = {
      permitId: permit.permitId,
      writerGeneration: 2,
      originSessionKey: 'parent',
      originCostSeq: 7,
      actualMicro: null,
      complete: false,
      creditSource: 'unknown' as const,
    }
    await s.settleOrigin(settlement)
    await s.close()
    s = createSqliteStorage({ file: join(dir, 'sessions.db'), tablesDir: join(dir, 'tables') })
    await s.settleOrigin(settlement)
    await s.releaseReservation({ permitId: permit.permitId, writerGeneration: 2 })
    expect(await s.peekReservation?.(permit.permitId)).toMatchObject({ qMicro: null, status: 'unknown' })
    expect((await s.projectTree('unlimited'))?.unknownHeld).toBe(true)
    const notSent = await s.reserve({ ...request, effectId: 'not-sent', writerGeneration: 2 })
    if (!notSent.ok) throw new Error(notSent.message)
    await s.releaseReservation({ permitId: notSent.permitId, writerGeneration: 2 })
    expect((await s.peekReservation?.(notSent.permitId))?.status).toBe('released')
  })

  it('preserves finite ancestors and local caps under unlimited roots', async () => {
    await s.open('parent', { writerRunId: 'writer', ttlMs: 1000 })
    await s.ensureRootScope('unlimited', null)
    const child = await s.createDelegatedChild({
      childKey: 'parent/capped',
      parentKey: 'parent',
      boundarySeq: 0,
      creationId: 'capped-child',
      kind: 'spawn',
      rootTaskId: 'unlimited',
      runtimeOwnerSessionKey: 'parent',
      generationDepth: 1,
      generationLimit: 2,
      maxFanOut: 3,
      inputHash: 'input',
      inputText: 'task',
      cwd: '/w',
      actorId: 'u',
      isolation: 'shared',
      workspaceId: 'ws:capped',
      treeCapMicro: null,
      childCapMicro: 10n,
      writerRunId: 'child-writer',
    })
    if (child.status !== 'created') throw new Error('Child creation refused')
    const request = {
      rootTaskId: 'unlimited',
      scopeIds: child.record.ancestorScopeIds,
      qMicro: null,
      effectId: 'local',
      requestHash: 'bound',
      writerGeneration: 1,
    }
    expect(await s.reserve(request)).toMatchObject({ ok: false, reason: 'unknown_bound' })
    expect(await s.reserve({ ...request, qMicro: 11n })).toMatchObject({ ok: false, reason: 'cap' })
    expect(await s.reserve({ ...request, qMicro: 10n })).toMatchObject({ ok: true })
    await s.ensureRootScope('finite', 5n)
    expect((await s.ensureRootScope('finite', null)).capMicro).toBe(5n)
    await expect(s.ensureRootScope('unlimited', 5n)).rejects.toThrow('tighter')
    await expect(s.ensureRootScope('finite', 3n)).rejects.toThrow('tighter')
    expect(await s.reserve({ ...request, rootTaskId: 'finite', scopeIds: ['root:finite'] })).toMatchObject({
      ok: false,
      reason: 'unknown_bound',
    })
    expect(await s.reserve({ ...request, scopeIds: [] })).toMatchObject({ ok: false, reason: 'invalid' })
  })

  it('migrates real format-4 NOT NULL tables while preserving finite reservations and refusing newer writers', async () => {
    await s.close()
    const file = join(dir, 'format-4.db')
    const legacy = new DatabaseSync(file)
    for (const ddl of DDL)
      legacy.exec(
        ddl
          .replace('cap_micro TEXT,', 'cap_micro TEXT NOT NULL,')
          .replace('q_micro TEXT,', 'q_micro TEXT NOT NULL,'),
      )
    legacy.exec(`INSERT INTO child_control_meta VALUES (1,4);
      INSERT INTO budget_scopes VALUES ('root:finite','finite',NULL,NULL,'10','2','3');
      INSERT INTO budget_reservations VALUES ('p1','finite','["root:finite"]','3','legacy-effect','legacy-hash',1,'held')`)
    legacy.close()
    s = createSqliteStorage({ file, tablesDir: join(dir, 'tables-v5') })
    expect(s.childControlFormat()).toBe(5)
    expect(await s.projectTree('finite')).toEqual({
      capMicro: 10n,
      settledMicro: 2n,
      heldMicro: 3n,
      unknownHeld: false,
    })
    expect(await s.lookupReservationByIdentity?.('finite', 'legacy-effect', 'legacy-hash')).toMatchObject({
      permitId: 'p1',
      qMicro: 3n,
    })
    await s.ensureRootScope('unlimited', null)
    const permit = await s.reserve({
      rootTaskId: 'unlimited',
      scopeIds: ['root:unlimited'],
      qMicro: null,
      effectId: 'unknown',
      requestHash: 'hash',
      writerGeneration: 1,
    })
    if (!permit.ok) throw new Error(permit.message)
    const external = new DatabaseSync(file)
    expect(
      external.prepare("SELECT cap_micro FROM budget_scopes WHERE scope_id='root:unlimited'").get()
        ?.cap_micro,
    ).toBeNull()
    expect(
      external.prepare('SELECT q_micro FROM budget_reservations WHERE permit_id=?').get(permit.permitId)
        ?.q_micro,
    ).toBeNull()
    external.exec('UPDATE child_control_meta SET version=6')
    external.close()
    await expect(s.releaseReservation({ permitId: permit.permitId, writerGeneration: 1 })).rejects.toThrow(
      'newer than runtime 5',
    )
    await expect(
      s.settleOrigin({
        permitId: permit.permitId,
        writerGeneration: 1,
        originSessionKey: 's',
        originCostSeq: 1,
        actualMicro: null,
        complete: false,
        creditSource: 'unknown',
      }),
    ).rejects.toThrow('newer than runtime 5')
  })

  it('freezes child runtime, seed and effective model identity while cwd becomes a worktree', async () => {
    await s.open('parent', { writerRunId: 'writer', ttlMs: 1000 })
    await s.ensureRootScope('root', null)
    const input = {
      childKey: 'parent/jev',
      parentKey: 'parent',
      boundarySeq: 0,
      creationId: 'jev-creation',
      kind: 'spawn' as const,
      rootTaskId: 'root',
      runtimeOwnerSessionKey: 'parent',
      generationDepth: 1,
      generationLimit: 2,
      maxFanOut: 3,
      inputHash: 'input',
      inputText: 'task',
      cwd: '/w',
      actorId: 'u',
      isolation: 'worktree' as const,
      workspaceId: 'ws:jev',
      treeCapMicro: null,
      childCapMicro: null,
      writerRunId: 'child-writer',
      runtime: { id: 'jevloop', version: '1' },
      seedMode: 'fresh' as const,
      model: { route: 'provider', model: 'selected' },
      creationCwd: '/w',
    }
    expect((await s.createDelegatedChild(input)).status).toBe('created')
    const { seedMode: _seedMode, runtime: _runtime, ...legacyInput } = input
    for (const suffix of ['history', 'legacy'] as const)
      expect(
        (
          await s.createDelegatedChild({
            ...legacyInput,
            childKey: `${input.childKey}/${suffix}`,
            creationId: `${input.creationId}/${suffix}`,
            workspaceId: `${input.workspaceId}/${suffix}`,
            ...(suffix === 'history' ? { kind: 'fork', seedMode: 'history', runtime: input.runtime } : {}),
          })
        ).status,
      ).toBe('created')
    await s.updateWorkspace?.('ws:jev', { path: '/allocated/worktree' })
    await s.close()
    s = createSqliteStorage({ file: join(dir, 'sessions.db'), tablesDir: join(dir, 'tables') })
    expect(await s.lookupByKey(input.childKey)).toMatchObject({
      runtime: input.runtime,
      seedMode: 'fresh',
      model: input.model,
      creationCwd: '/w',
      cwd: '/allocated/worktree',
    })
    const opened = await s.open(input.childKey, { writerRunId: 'reopened-child', ttlMs: 1_000 })
    expect(opened.parent).toBeUndefined()
    expect(await s.scan(input.childKey, { limit: 10 })).toEqual([])
    expect(await s.lookupByKey(input.childKey)).toMatchObject({ parentKey: 'parent' })
    for (const suffix of ['history', 'legacy'] as const) {
      const historical = await s.open(`${input.childKey}/${suffix}`, {
        writerRunId: `reopened-${suffix}`,
        ttlMs: 1_000,
      })
      expect(historical.parent).toEqual({ key: 'parent', boundarySeq: 0 })
      expect(await s.scan(`${input.childKey}/${suffix}`, { limit: 10 })).toEqual([])
    }
    expect((await s.createDelegatedChild(input)).status).toBe('existing')
    for (const change of [
      { runtime: { id: 'native', version: '1' } },
      { runtime: { id: 'jevloop', version: '2' } },
      { seedMode: 'history' as const },
      { boundarySeq: 5 },
      { kind: 'fork' as const },
      { model: { route: 'provider', model: 'changed' } },
      { creationCwd: '/other' },
      { isolation: 'shared' as const },
    ])
      expect((await s.createDelegatedChild({ ...input, ...change })).status).toBe('conflict')
  })
})
