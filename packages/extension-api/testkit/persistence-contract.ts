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
