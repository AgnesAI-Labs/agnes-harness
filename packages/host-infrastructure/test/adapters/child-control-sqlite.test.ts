import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CreateDelegatedChildInput } from '@agnes/core'
import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSqliteStorage, type SqliteStorage } from '../../src/adapters/storage-sqlite.js'

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

  it('reports the one child-control format without a format table', () => {
    expect(s.childControlFormat()).toBe(4)
    expect(() => s.assertWritableFormat()).not.toThrow()
    expect(s.coreTableNames()).not.toContain('child_control_meta')
  })

  it.each(
    (['memory', 'sqlite'] as const).flatMap((backend) =>
      [false, true].map((spawnFirst) => ({ backend, spawnFirst })),
    ),
  )(
    'security: $backend fences readmission versus spawn/recovery and terminal revival (spawnFirst=$spawnFirst)',
    async ({ backend, spawnFirst }) => {
      const store = backend === 'memory' ? new MemoryStorage() : s
      const peer =
        backend === 'memory'
          ? store
          : createSqliteStorage({ file: join(dir, 'sessions.db'), tablesDir: join(dir, 'tables') })
      const input = (id: string): CreateDelegatedChildInput => ({
        childKey: `parent/${id}`,
        parentKey: 'parent',
        boundarySeq: 0,
        creationId: id,
        kind: 'spawn',
        rootTaskId: 'root',
        runtimeOwnerSessionKey: 'parent',
        generationDepth: 1,
        generationLimit: 2,
        maxFanOut: 1,
        inputHash: id,
        inputText: 'bounded',
        cwd: '/w',
        actorId: 'u',
        isolation: 'shared',
        workspaceId: `ws:${id}`,
        treeCapMicro: 10000000n,
        childCapMicro: null,
        writerRunId: `writer:${id}`,
      })
      try {
        await store.open('parent', { writerRunId: 'parent-writer', ttlMs: 1000 })
        await store.ensureRootScope('root', 10000000n)
        await store.createDelegatedChild(input('idle'))
        let idle = (await store.lookupByKey('parent/idle'))!
        await store.casState(idle.childKey, idle.stateRevision, 'idle')
        idle = (await store.lookupByKey(idle.childKey))!
        const resume = () => store.casState(idle.childKey, idle.stateRevision, 'running', { maxFanOut: 1 })
        const spawn = () => peer.createDelegatedChild(input('fresh'))
        const raced = await Promise.allSettled(spawnFirst ? [spawn(), resume()] : [resume(), spawn()])
        expect(
          raced.filter(
            (result) =>
              result.status === 'fulfilled' &&
              (result.value === true ||
                (typeof result.value === 'object' && result.value.status === 'created')),
          ),
        ).toHaveLength(1)
        for (const result of raced) {
          if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'E_CHILD_LIMIT' })
          else if (typeof result.value === 'object' && result.value.status === 'refused')
            expect(result.value.reason).toBe('fan_out')
        }
        const active = (await store.listByRoot('root')).filter((row) =>
          ['creating', 'running'].includes(row.state),
        )
        expect(active).toHaveLength(1)
        const recovery = active[0]!
        await store.casState(recovery.childKey, recovery.stateRevision, 'recovery_pending')
        await expect(peer.createDelegatedChild(input('during-recovery'))).resolves.toMatchObject({
          status: 'refused',
          reason: 'fan_out',
        })
        const live = (await store.lookupByKey(recovery.childKey))!
        await store.casState(live.childKey, live.stateRevision, 'running')
        for (const terminal of ['completed', 'failed', 'cancelled'] as const) {
          const row = (await store.lookupByKey(live.childKey))!
          if (terminal === 'completed') await store.casState(row.childKey, row.stateRevision, terminal)
          else {
            await store.createDelegatedChild(input(terminal))
            const created = (await store.lookupByKey(`parent/${terminal}`))!
            await store.casState(created.childKey, created.stateRevision, terminal)
          }
          const ended = (await store.lookupByKey(
            terminal === 'completed' ? live.childKey : `parent/${terminal}`,
          ))!
          expect(await peer.casState(ended.childKey, ended.stateRevision, 'running', { maxFanOut: 1 })).toBe(
            false,
          )
        }
      } finally {
        if (peer !== store) await peer.close()
      }
    },
  )

  it('persists a child identity and refuses a second overlapping reservation', async () => {
    await s.open('parent', { writerRunId: 'r1', ttlMs: 1000 })
    await s.ensureRootScope('root', 10_000_000n)
    const input = {
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
    } satisfies CreateDelegatedChildInput
    const created = await s.createDelegatedChild(input)
    expect(created.status).toBe('created')
    const again = await s.createDelegatedChild({
      ...input,
      childKey: 'parent/other',
      workspaceId: 'ws:other',
    })
    expect(again.status).toBe('existing')
    if (created.status !== 'created') throw new Error('missing child')
    const current = (await s.lookupByKey('parent/child'))!
    expect(await s.casState(current.childKey, current.stateRevision, 'idle')).toBe(true)
    const idle = (await s.lookupByKey(current.childKey))!
    expect(await s.casState(idle.childKey, idle.stateRevision, 'running')).toBe(false)
    await expect(
      s.casState(idle.childKey, idle.stateRevision, 'running', { maxFanOut: 0 }),
    ).rejects.toMatchObject({ code: 'E_CHILD_LIMIT' })
    expect((await s.lookupByKey(idle.childKey))!.state).toBe('idle')
    const other = await s.createDelegatedChild({
      ...input,
      childKey: 'parent/other',
      creationId: 'parent:main:direct:2',
      workspaceId: 'ws:other',
    })
    expect(other.status).toBe('created')
    const otherRecord = (await s.lookupByKey('parent/other'))!
    await s.casState(otherRecord.childKey, otherRecord.stateRevision, 'interrupted')
    const otherIdle = (await s.lookupByKey(otherRecord.childKey))!
    const competing = createSqliteStorage({ file: join(dir, 'sessions.db'), tablesDir: join(dir, 'tables') })
    try {
      const results = await Promise.allSettled([
        s.casState(idle.childKey, idle.stateRevision, 'running', { maxFanOut: 1 }),
        competing.casState(otherIdle.childKey, otherIdle.stateRevision, 'running', { maxFanOut: 1 }),
      ])
      expect(results.filter((result) => result.status === 'fulfilled' && result.value)).toHaveLength(1)
      expect(results.find((result) => result.status === 'rejected')).toMatchObject({
        status: 'rejected',
        reason: { code: 'E_CHILD_LIMIT' },
      })
    } finally {
      await competing.close()
    }
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
})
