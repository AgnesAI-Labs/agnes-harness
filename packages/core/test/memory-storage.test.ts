import { describe, expect, it } from 'vitest'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { cacheKey, isRegisterTombstone, RegisterMap, registerKey } from '../src/log/storage.js'
import type { Event } from '../src/types.js'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const ev = (type: string, data: unknown, extra: Partial<Event> = {}): Event =>
  ({
    seq: 0,
    ts: '2026-09-07T00:00:00Z',
    id: '01J6ZM2Q3R4S5T6V7W8X9Y0ZAB',
    type,
    data,
    actor,
    origin: 'principal',
    trust: 'trusted',
    ...extra,
  }) as Event

describe('MemoryStorage', () => {
  it('assigns strictly increasing seq per session and returns them in order', async () => {
    const s = new MemoryStorage()
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    const r = await s.commit('k', {
      events: [ev('user/message', { content: [] }), ev('turn/start', { turn: 1, trigger: 'prompt' })],
      expectedWriterRunId: 'r1',
    })
    expect(r).toEqual({ firstSeq: 1, seqs: [1, 2] })
    const r2 = await s.commit('k', {
      events: [ev('step/start', { turn: 1, step: 1 })],
      expectedWriterRunId: 'r1',
    })
    expect(r2.seqs).toEqual([3])
  })

  it('enforces the writer lease and TTL expiry', async () => {
    let now = 0
    const s = new MemoryStorage({ clock: () => now })
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    await expect(s.open('k', { writerRunId: 'r2', ttlMs: 1000 })).rejects.toMatchObject({
      code: 'E_WRITER_LEASE',
    })
    await expect(
      s.commit('k', { events: [ev('user/message', {})], expectedWriterRunId: 'r2' }),
    ).rejects.toMatchObject({ code: 'E_WRITER_LEASE' })
    now = 1001
    // The lease has expired, so a new writer may take it over.
    await s.open('k', { writerRunId: 'r2', ttlMs: 1000 })
    await expect(
      s.commit('k', { events: [ev('user/message', {})], expectedWriterRunId: 'r1' }),
    ).rejects.toMatchObject({ code: 'E_WRITER_LEASE' })
  })

  it('materializes registers in the same commit, tombstone removes the key', async () => {
    const s = new MemoryStorage()
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    await s.commit('k', {
      events: [ev('op.state', { step: 1 }, { register: 'op.state', lane: 'main' })],
      expectedWriterRunId: 'r1',
    })
    expect(await s.registers('k')).toEqual([{ register: 'op.state', key: 'main', seq: 1, data: { step: 1 } }])
    await s.commit('k', {
      events: [ev('op.state', null, { register: 'op.state', lane: 'main' })],
      expectedWriterRunId: 'r1',
    })
    expect(await s.registers('k')).toEqual([])
    const rows = await s.scan('k', { fromSeq: 1, limit: 10 })
    // A tombstone drops the register key but never removes the rows themselves.
    expect(rows).toHaveLength(2)
  })

  it('seeds program-counter cells from a fixture', async () => {
    const e: Event = {
      seq: 1,
      ts: '2026-01-01T00:00:00Z',
      id: '01J6ZM2Q3R4S5T6V7W8X9Y0ZAB',
      type: 'user/message',
      lane: 'main',
      v: 1,
      actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
      origin: 'principal',
      trust: 'trusted',
      data: {},
    } as Event
    const cell = { register: 'op.state', key: 'main', seq: 1, data: { step: 2 } }
    const s = MemoryStorage.fromEvents('k', [e], { opCells: [cell] })
    expect(await s.registers('k')).toEqual([cell])
    // Other registers are folded from the rows themselves; a fixture cannot plant one beside them.
    expect(() => MemoryStorage.fromEvents('k', [e], { opCells: [{ ...cell, register: 'inbox' }] })).toThrow(
      'not op.state',
    )
  })
  it('CAS on register seq', async () => {
    const s = new MemoryStorage()
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    await s.commit('k', {
      events: [ev('op.state', { step: 1 }, { register: 'op.state', lane: 'main' })],
      expectedWriterRunId: 'r1',
    })
    await expect(
      s.commit('k', {
        events: [ev('op.state', { step: 2 }, { register: 'op.state', lane: 'main' })],
        expectedWriterRunId: 'r1',
        expectedRegisterSeq: { register: 'op.state', key: 'main', seq: 99 },
      }),
    ).rejects.toMatchObject({ code: 'E_CAS' })
    await s.commit('k', {
      events: [ev('op.state', { step: 2 }, { register: 'op.state', lane: 'main' })],
      expectedWriterRunId: 'r1',
      expectedRegisterSeq: { register: 'op.state', key: 'main', seq: 1 },
    })
  })

  it('rejects unbounded scan and filters by type/lane', async () => {
    const s = new MemoryStorage()
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    await s.commit('k', {
      events: [ev('user/message', {}), ev('assistant/message', {}, { lane: 'side' })],
      expectedWriterRunId: 'r1',
    })
    await expect(s.scan('k', {})).rejects.toMatchObject({ code: 'E_SCAN_UNBOUNDED' })
    expect((await s.scan('k', { type: 'assistant/message', limit: 10 })).map((e) => e.seq)).toEqual([2])
    expect((await s.scan('k', { lane: 'main', limit: 10 })).map((e) => e.seq)).toEqual([1])
    expect((await s.scan('k', { toSeq: 2, order: 'desc' })).map((e) => e.seq)).toEqual([2, 1])
  })

  it('child session reads parent prefix read-only and continues seq', async () => {
    const s = new MemoryStorage()
    await s.open('p', { writerRunId: 'r1', ttlMs: 1000 })
    await s.commit('p', {
      events: [ev('user/message', { n: 1 }), ev('assistant/message', { n: 2 }), ev('user/message', { n: 3 })],
      expectedWriterRunId: 'r1',
    })
    await s.createChild('p', 2, 'c')
    const opened = await s.open('c', { writerRunId: 'r9', ttlMs: 1000 })
    expect(opened).toMatchObject({ lastSeq: 2, parent: { key: 'p', boundarySeq: 2 } })
    const r = await s.commit('c', { events: [ev('session/start', {})], expectedWriterRunId: 'r9' })
    expect(r.seqs).toEqual([3])
    expect(
      (await s.scan('c', { fromSeq: 1, limit: 10 })).map((e) => [e.seq, (e.data as { n?: number }).n]),
    ).toEqual([
      [1, 1],
      [2, 2],
      [3, undefined],
    ])
  })
  it('keeps register and key apart with a separator that cannot occur in either half', async () => {
    // Under a printable separator such as a space, ('a', 'b c') and ('a b', 'c') collapse onto the
    // same composite key and the second commit overwrites the first cell. That is a silent loss of a
    // register on the resume path, so the separator is pinned here rather than left to the caller.
    expect(cacheKey('a', 'b c')).toContain('\u0000')
    expect(cacheKey('a', 'b c')).not.toBe(cacheKey('a b', 'c'))
    // The cache is addressed by the two halves, never by a composite the caller spelled, so the
    // separator has one place to live and reseeding folds through the same door.
    const m = new RegisterMap()
    m.apply({ register: 'a', key: 'b c', seq: 1, data: { which: 'first' } })
    m.apply({ register: 'a b', key: 'c', seq: 2, data: { which: 'second' } })
    expect(m.get('a', 'b c')).toMatchObject({ data: { which: 'first' } })
    expect(m.values()).toHaveLength(2)
    m.apply({ register: 'a', key: 'b c', seq: 3, data: null })
    expect(m.get('a', 'b c')).toBeUndefined()
    m.replaceAll([{ register: 'z', key: 'main', seq: 4, data: 1 }])
    expect(m.values()).toEqual([{ register: 'z', key: 'main', seq: 4, data: 1 }])
    // The cell store is hard-private, so there is no backing Map to reach past apply() and drop a
    // raw-string-keyed cell into. A TS-private field would be erased at runtime and let exactly that
    // through: the cell would then be listed by values() and invisible to get().
    expect(Object.keys(m)).toEqual([])
    expect(() => (m as unknown as { cells: Map<string, unknown> }).cells.set('z\u0000main', 1)).toThrow(
      TypeError,
    )
    const s = new MemoryStorage()
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    await s.commit('k', {
      events: [
        ev('inbox', { which: 'first' }, { register: 'a', lane: 'b c' }),
        ev('inbox', { which: 'second' }, { register: 'a b', lane: 'c' }),
      ],
      expectedWriterRunId: 'r1',
    })
    expect(await s.registers('k')).toEqual([
      { register: 'a', key: 'b c', seq: 1, data: { which: 'first' } },
      { register: 'a b', key: 'c', seq: 2, data: { which: 'second' } },
    ])
  })

  it('keeps a harness entry kind and id apart with the same separator', async () => {
    // Joined with a slash, {kind:'a/b', id:'c'} and {kind:'a', id:'b/c'} both spell 'a/b/c' and land
    // in one cell: the same collision the composite key avoids, one level down. A slash is legal in
    // an entry id, so the join uses the separator that cannot occur in either half.
    const key = (kind: string, id: string) =>
      registerKey(ev('harness/entry', { kind, id }, { register: 'harness/entry' }))
    expect(key('a/b', 'c')).not.toBe(key('a', 'b/c'))
    expect(key('memory', 'm1')).toBe('memory\u0000m1')
    const s = new MemoryStorage()
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    await s.commit('k', {
      events: [
        ev('harness/entry', { kind: 'a/b', id: 'c', title: 'first' }, { register: 'harness/entry' }),
        ev('harness/entry', { kind: 'a', id: 'b/c', title: 'second' }, { register: 'harness/entry' }),
      ],
      expectedWriterRunId: 'r1',
    })
    expect((await s.registers('k')).map((r) => (r.data as { title: string }).title)).toEqual([
      'first',
      'second',
    ])
  })

  it('erases a harness entry through its keyed tombstone, not a null payload', async () => {
    // A harness/entry cell is keyed by kind/id read out of `data`, so `data: null` cannot say which
    // key it removes. Its tombstone carries the key plus a flag; every other register keeps null.
    expect(isRegisterTombstone('plan.items', null)).toBe(true)
    expect(isRegisterTombstone('harness/entry', { kind: 'memory', id: 'm1', tombstone: true })).toBe(true)
    expect(isRegisterTombstone('harness/entry', { kind: 'memory', id: 'm1' })).toBe(false)
    expect(isRegisterTombstone('plan.items', { tombstone: true })).toBe(false)
    const s = new MemoryStorage()
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    await s.commit('k', {
      events: [ev('harness/entry', { kind: 'memory', id: 'm1', title: 't' }, { register: 'harness/entry' })],
      expectedWriterRunId: 'r1',
    })
    expect(await s.registers('k')).toHaveLength(1)
    await s.commit('k', {
      events: [
        ev('harness/entry', { kind: 'memory', id: 'm1', tombstone: true }, { register: 'harness/entry' }),
      ],
      expectedWriterRunId: 'r1',
    })
    expect(await s.registers('k')).toEqual([])
  })

  it('renewal resets the full term instead of preserving the time left', async () => {
    // With the term preserved rather than reset, `until` never moves: the lease lapses on its
    // original deadline while its holder is alive and renewing on schedule, and a second writer
    // takes the same ledger over. Two live writers on an append-only log is unrecoverable, so the
    // whole renewal schedule is walked here rather than a single call.
    let now = 0
    const s = new MemoryStorage({ clock: () => now })
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    for (const t of [300, 600, 900]) {
      now = t
      await s.renew('k', 'r1')
    }
    now = 1100
    await expect(s.open('k', { writerRunId: 'r2', ttlMs: 1000 })).rejects.toMatchObject({
      code: 'E_WRITER_LEASE',
    })
    now = 1200
    const r = await s.commit('k', { events: [ev('user/message', {})], expectedWriterRunId: 'r1' })
    expect(r.seqs).toEqual([1])
    // The renewed term still ends: 1900 is one term after the last renewal at 900.
    now = 1901
    await s.open('k', { writerRunId: 'r2', ttlMs: 1000 })
  })

  it('holds the lease up to and including its deadline, and no longer', async () => {
    let now = 0
    const s = new MemoryStorage({ clock: () => now })
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    now = 1000
    // On the deadline itself the lease is still held: the holder may write and nobody may take over.
    await s.commit('k', { events: [ev('user/message', {})], expectedWriterRunId: 'r1' })
    await expect(s.open('k', { writerRunId: 'r2', ttlMs: 1000 })).rejects.toMatchObject({
      code: 'E_WRITER_LEASE',
    })
    now = 1001
    await s.open('k', { writerRunId: 'r2', ttlMs: 1000 })
  })

  it('refuses a renewal from a writer that does not hold the lease', async () => {
    let now = 0
    const s = new MemoryStorage({ clock: () => now })
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    await expect(s.renew('k', 'r2')).rejects.toMatchObject({ code: 'E_WRITER_LEASE' })
    now = 1001
    await s.open('k', { writerRunId: 'r2', ttlMs: 1000 })
    // The old holder must not be able to renew its way back in over the new one.
    await expect(s.renew('k', 'r1')).rejects.toMatchObject({ code: 'E_WRITER_LEASE' })
    await s.commit('k', { events: [ev('user/message', {})], expectedWriterRunId: 'r2' })
  })

  it('ignores a release from a writer that does not hold the lease', async () => {
    const s = new MemoryStorage()
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    await s.release('k', 'r2')
    // r1 still holds it, so r2 cannot open and r1 can still write.
    await expect(s.open('k', { writerRunId: 'r2', ttlMs: 1000 })).rejects.toMatchObject({
      code: 'E_WRITER_LEASE',
    })
    await s.commit('k', { events: [ev('user/message', {})], expectedWriterRunId: 'r1' })
    await s.release('k', 'r1')
    await s.open('k', { writerRunId: 'r2', ttlMs: 1000 })
  })

  it('CAS with a null expectation creates the register only while it is absent', async () => {
    const s = new MemoryStorage()
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    // null means "there must be no cell yet": the create-if-absent path, which is how a register is
    // claimed exactly once by concurrent writers.
    await s.commit('k', {
      events: [ev('op.state', { step: 1 }, { register: 'op.state', lane: 'main' })],
      expectedWriterRunId: 'r1',
      expectedRegisterSeq: { register: 'op.state', key: 'main', seq: null },
    })
    await expect(
      s.commit('k', {
        events: [ev('op.state', { step: 2 }, { register: 'op.state', lane: 'main' })],
        expectedWriterRunId: 'r1',
        expectedRegisterSeq: { register: 'op.state', key: 'main', seq: null },
      }),
    ).rejects.toMatchObject({ code: 'E_CAS', detail: { expected: null, actual: 1 } })
    // A tombstone puts the cell back to absent, so the null expectation holds again.
    await s.commit('k', {
      events: [ev('op.state', null, { register: 'op.state', lane: 'main' })],
      expectedWriterRunId: 'r1',
    })
    await s.commit('k', {
      events: [ev('op.state', { step: 3 }, { register: 'op.state', lane: 'main' })],
      expectedWriterRunId: 'r1',
      expectedRegisterSeq: { register: 'op.state', key: 'main', seq: null },
    })
    // seq 3, not 4: the refused batch above consumed no sequence.
    expect(await s.registers('k')).toEqual([{ register: 'op.state', key: 'main', seq: 3, data: { step: 3 } }])
  })

  it('a forked child reads the parent registers as of the boundary', async () => {
    const s = new MemoryStorage()
    await s.open('p', { writerRunId: 'r1', ttlMs: 1000 })
    await s.commit('p', {
      events: [
        ev('op.state', { step: 1 }, { register: 'op.state', lane: 'main' }),
        ev('inbox', { keep: true }, { register: 'a', lane: 'main' }),
      ],
      expectedWriterRunId: 'r1',
    })
    await s.createChild('p', 2, 'c')
    // The parent keeps writing after the fork; none of it may reach the child.
    await s.commit('p', {
      events: [
        ev('op.state', { step: 99 }, { register: 'op.state', lane: 'main' }),
        ev('inbox', null, { register: 'a', lane: 'main' }),
      ],
      expectedWriterRunId: 'r1',
    })
    await s.open('c', { writerRunId: 'r9', ttlMs: 1000 })
    expect(await s.registers('c')).toEqual([
      { register: 'op.state', key: 'main', seq: 1, data: { step: 1 } },
      { register: 'a', key: 'main', seq: 2, data: { keep: true } },
    ])
    // The child's own rows sit on top of the inherited ones, tombstones included.
    await s.commit('c', {
      events: [
        ev('op.state', { step: 2 }, { register: 'op.state', lane: 'main' }),
        ev('inbox', null, { register: 'a', lane: 'main' }),
      ],
      expectedWriterRunId: 'r9',
    })
    expect(await s.registers('c')).toEqual([{ register: 'op.state', key: 'main', seq: 3, data: { step: 2 } }])
    // A CAS on the child reads the same view, so an inherited cell is not seen as absent.
    await expect(
      s.commit('c', {
        events: [ev('op.state', { step: 4 }, { register: 'op.state', lane: 'main' })],
        expectedWriterRunId: 'r9',
        expectedRegisterSeq: { register: 'op.state', key: 'main', seq: null },
      }),
    ).rejects.toMatchObject({ code: 'E_CAS', detail: { actual: 3 } })
  })

  it('a fork of a fork still reads the whole ancestor chain', async () => {
    const s = new MemoryStorage()
    await s.open('p', { writerRunId: 'r1', ttlMs: 1000 })
    await s.commit('p', {
      events: [ev('user/message', { n: 1 }, { register: 'g', lane: 'main' }), ev('user/message', { n: 2 })],
      expectedWriterRunId: 'r1',
    })
    await s.createChild('p', 2, 'c')
    await s.open('c', { writerRunId: 'r2', ttlMs: 1000 })
    await s.commit('c', { events: [ev('user/message', { n: 3 })], expectedWriterRunId: 'r2' })
    await s.createChild('c', 3, 'g')
    const opened = await s.open('g', { writerRunId: 'r3', ttlMs: 1000 })
    expect(opened).toMatchObject({ lastSeq: 3 })
    await s.commit('g', { events: [ev('user/message', { n: 4 })], expectedWriterRunId: 'r3' })
    // The grandchild sees the grandparent prefix, the parent prefix and its own rows, in seq order.
    expect((await s.scan('g', { fromSeq: 1, limit: 10 })).map((e) => (e.data as { n: number }).n)).toEqual([
      1, 2, 3, 4,
    ])
    expect(await s.registers('g')).toEqual([{ register: 'g', key: 'main', seq: 1, data: { n: 1 } }])
  })

  it('refuses a child key that already exists and a boundary past the parent tail', async () => {
    const s = new MemoryStorage()
    await s.open('p', { writerRunId: 'r1', ttlMs: 1000 })
    await s.commit('p', { events: [ev('user/message', {})], expectedWriterRunId: 'r1' })
    await expect(s.createChild('p', 99, 'c')).rejects.toMatchObject({
      code: 'E_STORAGE_FAULT',
      detail: { boundarySeq: 99 },
    })
    await s.createChild('p', 1, 'c')
    await expect(s.createChild('p', 1, 'c')).resolves.toBeUndefined()
    await expect(s.createChild('p', 1, 'p')).rejects.toMatchObject({
      code: 'E_STORAGE_FAULT',
      detail: { childKey: 'p' },
    })
  })
})
