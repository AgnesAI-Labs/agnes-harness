import { expect, it } from 'vitest'
import type { PersistenceEventRecord, PersistenceSessionStore } from '../src/persistence.js'
import { PERSISTENCE_SCAN_PAGE_MAX } from '../src/persistence.js'

const NUL = '\u0000'

/** A fresh directory-bound factory. Each case calls `create` once and may `open` that store again. */
export type PersistenceContractFactory = {
  open(): PersistenceSessionStore | Promise<PersistenceSessionStore>
}

let nextId = 0

function event(
  type: string,
  data: unknown,
  over: Partial<PersistenceEventRecord> = {},
): PersistenceEventRecord {
  nextId += 1
  return {
    ts: '2026-09-07T00:00:00.000Z',
    id: nextId.toString(16).padStart(32, '0'),
    type,
    data,
    actor: { id: 'u', org: 'local', role: 'owner' },
    origin: 'principal',
    trust: 'trusted',
    lane: 'main',
    v: 1,
    ...over,
  }
}

/**
 * Append, paged scan, the single-writer lease and register cells. SQLite checks are a separate optional suite.
 * Run once per provider. `create` must point every `open` at the same empty directory.
 */
export function persistenceContract(name: string, create: () => PersistenceContractFactory): void {
  it(`${name}: assigns consecutive seqs from 1 and reads them back after reopen`, async () => {
    const factory = create()
    const first = await factory.open()
    await first.open('k', { writerRunId: 'r1', ttlMs: 60_000 })
    expect(
      (
        await first.commit('k', {
          events: [event('user/message', { n: 1 }), event('user/message', { n: 2 })],
          expectedWriterRunId: 'r1',
        })
      ).seqs,
    ).toEqual([1, 2])
    await first.close()
    const second = await factory.open()
    expect((await second.scan('k', { toSeq: 2, limit: 2 })).map((row) => row.seq)).toEqual([1, 2])
    await second.close()
  })

  it(`${name}: refuses a scan with neither toSeq nor limit`, async () => {
    const store = await create().open()
    await store.open('k', { writerRunId: 'r1', ttlMs: 60_000 })
    await expect(store.scan('k', {})).rejects.toMatchObject({ code: 'E_SCAN_UNBOUNDED' })
    await store.close()
  })

  it(`${name}: a short limit is one page and a full read past the page cap is refused`, async () => {
    const store = await create().open()
    await store.open('k', { writerRunId: 'r1', ttlMs: 60_000 })
    const events = Array.from({ length: PERSISTENCE_SCAN_PAGE_MAX + 1 }, (_, index) =>
      event('user/message', { index }),
    )
    await store.commit('k', { events, expectedWriterRunId: 'r1' })
    expect(await store.scan('k', { limit: 1 })).toHaveLength(1)
    await expect(store.scan('k', { toSeq: events.length })).rejects.toMatchObject({
      code: 'E_SCAN_TRUNCATED',
    })
    await store.close()
  })

  it(`${name}: refuses a commit from a run that does not hold the lease`, async () => {
    const store = await create().open()
    await store.open('k', { writerRunId: 'r1', ttlMs: 60_000 })
    await expect(
      store.commit('k', { events: [event('user/message', {})], expectedWriterRunId: 'r2' }),
    ).rejects.toMatchObject({ code: 'E_WRITER_LEASE' })
    await expect(store.renew('k', 'r2')).rejects.toMatchObject({ code: 'E_WRITER_LEASE' })
    await store.close()
  })

  it(`${name}: materializes a register and tombstones it on null`, async () => {
    const store = await create().open()
    await store.open('k', { writerRunId: 'r1', ttlMs: 60_000 })
    await store.commit('k', {
      events: [event('op.state', { step: 1 }, { register: 'op.state' })],
      expectedWriterRunId: 'r1',
    })
    expect(await store.registers('k')).toEqual([
      { register: 'op.state', key: 'main', seq: 1, data: { step: 1 } },
    ])
    await store.commit('k', {
      events: [event('op.state', null, { register: 'op.state' })],
      expectedWriterRunId: 'r1',
    })
    expect(await store.registers('k')).toEqual([])
    await store.close()
  })

  it(`${name}: keys a harness entry by kind and id and erases it on the explicit flag`, async () => {
    const store = await create().open()
    await store.open('k', { writerRunId: 'r1', ttlMs: 60_000 })
    await store.commit('k', {
      events: [
        event('harness/entry', { kind: 'skill', id: 'a', body: 1 }, { register: 'harness/entry' }),
        event('harness/entry', { kind: 'skill', id: 'b', body: 2 }, { register: 'harness/entry' }),
      ],
      expectedWriterRunId: 'r1',
    })
    expect((await store.registers('k')).map((row) => row.key)).toEqual([`skill${NUL}a`, `skill${NUL}b`])
    await store.commit('k', {
      events: [
        event('harness/entry', { kind: 'skill', id: 'a', tombstone: true }, { register: 'harness/entry' }),
      ],
      expectedWriterRunId: 'r1',
    })
    expect((await store.registers('k')).map((row) => row.key)).toEqual([`skill${NUL}b`])
    await store.close()
  })
}

/** Optional SQLite capability checks; ledger-only providers must not run this suite. */
export function persistenceSqliteContract(name: string, create: () => PersistenceContractFactory): void {
  it(`${name}: inserts and reads a package table, and refuses a NUL in text`, async () => {
    const store = await create().open()
    expect(store.sqlite?.dialect).toBe('sqlite')
    if (!store.sqlite) throw new Error('SQLite capability is missing')
    const tables = store.sqlite.tables('example.owner')
    const table = tables.table('notes')
    table.exec('create table notes (k text, v integer)')
    expect(table.run('insert into notes (k, v) values (?, ?)', ['a', 1])).toEqual({ changes: 1 })
    expect(tables.table('notes').get('select k, v from notes')).toEqual({ k: 'a', v: 1 })
    expect(() => table.run('insert into notes (k, v) values (?, ?)', [`a${NUL}b`, 2])).toThrow(
      /bind parameter 0 contains NUL/,
    )
    expect(table.all('select k from notes')).toEqual([{ k: 'a' }])
    expect(() => table.all('select v from missing')).toThrow(/no such table/)
    await store.close()
  })
}

function assertHostPorts(
  store: PersistenceSessionStore,
): asserts store is PersistenceSessionStore &
  Required<Pick<PersistenceSessionStore, 'metadata' | 'childControl' | 'reclaim' | 'scanIntegrity'>> {
  if (!store.metadata || !store.childControl || !store.reclaim || !store.scanIntegrity)
    throw new Error('full Host persistence ports are missing')
}

/** Mandatory full-Host ports, independently of the optional SQL suite. */
export function persistenceHostContract(name: string, create: () => PersistenceContractFactory): void {
  it(`${name}: persists owner-scoped metadata and rolls back failed transactions`, async () => {
    const factory = create()
    const first = await factory.open()
    assertHostPorts(first)
    const ns = first.metadata.namespace('owner', 'config')
    ns.set('a', { enabled: true })
    const value = ns.get('a') as { enabled: boolean }
    value.enabled = false
    expect(ns.get('a')).toEqual({ enabled: true })
    expect(() =>
      ns.transaction(() => {
        ns.set('a', false)
        ns.set('b', true)
        throw new Error('rollback')
      }),
    ).toThrow('rollback')
    expect(() =>
      ns.transaction(() => {
        ns.set('c', true)
        return Promise.resolve()
      }),
    ).toThrow(/synchronous/)
    expect(ns.entries()).toEqual([{ key: 'a', value: { enabled: true } }])
    expect(first.metadata.namespace('other', 'config').get('a')).toBeUndefined()
    await first.close()
    const second = await factory.open()
    assertHostPorts(second)
    expect(second.metadata.namespace('owner', 'config').get('a')).toEqual({ enabled: true })
    const unicode = second.metadata.namespace('owner', 'nul\u0000namespace')
    const keys = ['a\u0000b', '\ud800', '\ud801', 'astral-😀']
    for (const key of keys) unicode.set(key, { key })
    expect(new Set(unicode.entries().map((row) => row.key))).toEqual(new Set(keys))
    for (const key of keys) expect(unicode.get(key)).toEqual({ key })
    await second.close()
  })
  it(`${name}: commits integrity and operation state atomically with the ledger`, async () => {
    const factory = create()
    const first = await factory.open()
    assertHostPorts(first)
    await first.open('k', { writerRunId: 'r', ttlMs: 60_000 })
    const integrity = { seq: 1, mode: 'anchor' as const, previousDigest: null, digest: 'a'.repeat(64) }
    await first.commit('k', {
      events: [event('user/message', {})],
      expectedWriterRunId: 'r',
      integrity: [integrity],
      opState: { lane: 'main', data: { step: 1 } },
    })
    await expect(
      first.commit('k', {
        events: [event('user/message', {})],
        expectedWriterRunId: 'r',
        integrity: [integrity],
        opState: { lane: 'main', data: null },
      }),
    ).rejects.toMatchObject({ code: 'E_STORAGE_FAULT' })
    await first.close()
    const second = await factory.open()
    assertHostPorts(second)
    expect(await second.registers('k')).toEqual([
      { register: 'op.state', key: 'main', seq: 1, data: { step: 1 } },
    ])
    expect(
      (await second.scanIntegrity('k', { fromSeq: 1, toSeq: 2, limit: 2 })).map((row) => row.integrity),
    ).toEqual([{ mode: 'anchor', previousDigest: null, digest: 'a'.repeat(64) }])
    await second.close()
  })
  it(`${name}: keeps child identity, CAS and exact tree budgets across reopen`, async () => {
    const factory = create()
    const first = await factory.open()
    assertHostPorts(first)
    await first.open('parent', { writerRunId: 'r', ttlMs: 60_000 })
    const children = first.childControl
    const cap = 9007199254740993n
    await children.ensureRootScope('parent', cap)
    const input = {
      childKey: 'child',
      parentKey: 'parent',
      boundarySeq: 0,
      creationId: 'create',
      attemptId: 'attempt',
      kind: 'spawn' as const,
      rootTaskId: 'parent',
      runtimeOwnerSessionKey: 'parent',
      generationDepth: 1,
      generationLimit: 2,
      maxFanOut: 4,
      inputHash: 'hash',
      inputText: 'task',
      cwd: '/synthetic',
      actorId: 'actor',
      isolation: 'shared' as const,
      workspaceId: 'workspace',
      treeCapMicro: cap,
      childCapMicro: cap,
      writerRunId: 'r',
    }
    expect(await children.createDelegatedChild(input)).toMatchObject({
      status: 'created',
      record: { creationRevision: 1 },
    })
    expect(await children.createDelegatedChild(input)).toMatchObject({ status: 'existing' })
    expect(await children.createDelegatedChild({ ...input, inputHash: 'other' })).toMatchObject({
      status: 'conflict',
    })
    expect(
      await children.commitCreatingChild({
        childKey: 'child',
        creationId: 'create',
        attemptId: 'attempt',
        expectedRevision: 99,
      }),
    ).toBe(false)
    expect(
      await children.commitCreatingChild({
        childKey: 'child',
        creationId: 'create',
        attemptId: 'attempt',
        expectedRevision: 1,
      }),
    ).toBe(true)
    expect(await children.casState('child', 1, 'ready')).toBe(true)
    expect(await children.casState('child', 1, 'running')).toBe(false)
    const request = {
      rootTaskId: 'parent',
      scopeIds: ['root:parent', 'child:child'],
      qMicro: 50n,
      effectId: 'effect',
      requestHash: 'request',
      writerGeneration: 1,
    }
    const permit = await children.reserve(request)
    expect(permit).toMatchObject({ ok: true, existing: false })
    if (!permit.ok) throw new Error('reservation refused')
    expect(await children.reserve(request)).toMatchObject({
      ok: true,
      permitId: permit.permitId,
      existing: true,
    })
    await expect(
      children.settleOrigin({
        permitId: permit.permitId,
        writerGeneration: 2,
        originSessionKey: 'child',
        originCostSeq: 1,
        actualMicro: 30n,
        complete: true,
        creditSource: 'gateway',
      }),
    ).rejects.toMatchObject({ code: 'E_BUDGET' })
    const cost = {
      permitId: permit.permitId,
      writerGeneration: 1,
      originSessionKey: 'child',
      originCostSeq: 1,
      actualMicro: 30n,
      complete: true,
      creditSource: 'gateway' as const,
    }
    await children.settleOrigin(cost)
    await children.settleOrigin(cost)
    await expect(children.settleOrigin({ ...cost, actualMicro: 31n })).rejects.toMatchObject({
      code: 'E_BUDGET',
    })
    await first.close()
    const second = await factory.open()
    assertHostPorts(second)
    expect(await second.childControl.projectTree('parent')).toEqual({
      capMicro: cap,
      heldMicro: 0n,
      settledMicro: 30n,
      unknownHeld: false,
    })
    expect(await second.childControl.lookupByKey('child')).toMatchObject({
      state: 'ready',
      stateRevision: 2,
      creationPhase: 'committed',
    })
    expect(await second.childControl.workspace('workspace')).toMatchObject({
      path: '/synthetic',
      phase: 'planned',
    })
    await second.close()
  })
  it(`${name}: refuses stale reclaim and clears an expired idle lease`, async () => {
    const store = await create().open()
    assertHostPorts(store)
    await store.open('idle', { writerRunId: 'r', ttlMs: 1 })
    const now = Date.now() + 60_000
    const lease = store.reclaim.listExpired(now).find((row) => row.sessionKey === 'idle')
    if (!lease) throw new Error('expired lease missing')
    expect(store.reclaim.claimForReclaim('idle', 'stale', lease.until, now)).toBeNull()
    expect(store.reclaim.claimForReclaim('idle', lease.runId, lease.until, now)).toEqual({
      seq: 0,
      opState: undefined,
    })
    expect(store.reclaim.claimForReclaim('idle', lease.runId, lease.until, now)).toBeNull()
    await store.close()
  })
}
