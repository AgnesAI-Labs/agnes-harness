import type { PreparedEvent, StorageAdapter } from '@agnes/core'
import { expect, it } from 'vitest'

// The separator core joins a harness/entry cell's kind and id with. It cannot occur in either
// half, so a kind ending in a slash and an id starting with one cannot land on the same cell.
const NUL = '\u0000'

/** The behaviour every StorageAdapter owes core, run against each implementation in turn. */
export function storageContract(
  name: string,
  open: () => StorageAdapter,
  ev: (type: string, data: unknown, over?: Partial<PreparedEvent>) => PreparedEvent,
): void {
  it(`${name}: assigns consecutive seqs from 1`, async () => {
    const s = open()
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    expect(
      (
        await s.commit('k', {
          events: [ev('user/message', {}), ev('user/message', {})],
          expectedWriterRunId: 'r1',
        })
      ).seqs,
    ).toEqual([1, 2])
    await s.close()
  })
  it(`${name}: stores integrity metadata beside events without exposing it in public scans`, async () => {
    const s = open()
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    const digest = 'a'.repeat(64)
    await s.commit('k', {
      events: [ev('user/message', {})],
      integrity: [{ seq: 1, mode: 'anchor', previousDigest: null, digest }],
      expectedWriterRunId: 'r1',
    })
    expect(await s.scanIntegrity('k', { fromSeq: 1, toSeq: 1, limit: 1 })).toMatchObject([
      { sessionKey: 'k', event: { seq: 1 }, integrity: { mode: 'anchor', previousDigest: null, digest } },
    ])
    expect(await s.scan('k', { toSeq: 1 })).not.toHaveProperty('0.integrity')
    await s.close()
  })
  it(`${name}: atomically stores a fold checkpoint at the committed tail`, async () => {
    const s = open()
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    const record = {
      version: 2 as const,
      seq: 1,
      payload: '{"lastSeq":1}',
      checksum: 'a'.repeat(64),
      integrity: { lastSeq: 1, legacyThroughSeq: 1, headDigest: null },
    }
    await s.commit('k', {
      events: [ev('user/message', {})],
      expectedWriterRunId: 'r1',
      foldCache: record,
    })
    expect(await s.foldCache?.('k')).toEqual(record)
    await expect(
      s.commit('k', {
        events: [ev('user/message', {})],
        expectedWriterRunId: 'r1',
        foldCache: { ...record, seq: 99 },
      }),
    ).rejects.toMatchObject({ code: 'E_STORAGE_FAULT' })
    expect((await s.scan('k', { toSeq: 10 })).map((event) => event.seq)).toEqual([1])
    expect(await s.foldCache?.('k')).toEqual(record)
    await s.close()
  })
  it(`${name}: rejects mismatched integrity sequences before writing`, async () => {
    const s = open()
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    await expect(
      s.commit('k', {
        events: [ev('user/message', {})],
        integrity: [{ seq: 2, mode: 'anchor', previousDigest: null, digest: 'a'.repeat(64) }],
        expectedWriterRunId: 'r1',
      }),
    ).rejects.toMatchObject({ code: 'E_STORAGE_FAULT' })
    expect(await s.scan('k', { toSeq: 10 })).toEqual([])
    await s.close()
  })
  it(`${name}: refuses a scan with neither toSeq nor limit`, async () => {
    const s = open()
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    await expect(s.scan('k', {})).rejects.toMatchObject({ code: 'E_SCAN_UNBOUNDED' })
    await s.close()
  })
  it(`${name}: refuses a commit from a run that does not hold the lease`, async () => {
    const s = open()
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    await expect(
      s.commit('k', { events: [ev('user/message', {})], expectedWriterRunId: 'r2' }),
    ).rejects.toMatchObject({ code: 'E_WRITER_LEASE' })
    await s.close()
  })
  it(`${name}: materializes a register and tombstones it on null`, async () => {
    const s = open()
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    await s.commit('k', {
      events: [ev('op.state', { step: 1 }, { register: 'op.state' })],
      expectedWriterRunId: 'r1',
    })
    expect(await s.registers('k')).toHaveLength(1)
    await s.commit('k', {
      events: [ev('op.state', null, { register: 'op.state' })],
      expectedWriterRunId: 'r1',
    })
    expect(await s.registers('k')).toEqual([])
    await s.close()
  })
  // A harness/entry cell is keyed by kind/id read out of its own data, so a null payload could not
  // name the key it erases; its tombstone carries the key alongside an explicit flag. The two
  // adapters spell that rule separately, and this is the case that keeps them agreeing.
  it(`${name}: keys a harness/entry cell by kind and id, and erases it on the explicit flag`, async () => {
    const s = open()
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    await s.commit('k', {
      events: [
        ev('harness/entry', { kind: 'skill', id: 'a', body: 1 }, { register: 'harness/entry' }),
        ev('harness/entry', { kind: 'skill', id: 'b', body: 2 }, { register: 'harness/entry' }),
      ],
      expectedWriterRunId: 'r1',
    })
    expect((await s.registers('k')).map((r) => r.key)).toEqual([`skill${NUL}a`, `skill${NUL}b`])
    await s.commit('k', {
      events: [
        ev('harness/entry', { kind: 'skill', id: 'a', tombstone: true }, { register: 'harness/entry' }),
      ],
      expectedWriterRunId: 'r1',
    })
    expect((await s.registers('k')).map((r) => r.key)).toEqual([`skill${NUL}b`])
    await s.close()
  })
  // The key space, run against both adapters because that is the only way a durable adapter's
  // encoding can be caught disagreeing with the reference. A cell key is built out of event data,
  // which is JSON from a model or an extension, so every one of these is reachable: JSON admits a
  // lone surrogate, and a NUL is what joins the two halves of a harness/entry key.
  it(`${name}: round-trips a cell key through every shape core can build`, async () => {
    const s = open()
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    const kinds: Array<[string, string]> = [
      ['skill', 'a'],
      ['sk\u0000ill', 'b'],
      ['', 'leading'],
      ['trailing', ''],
      ['', ''],
      ['astral', '\u{1F600}'],
      ['lone', '\ud800'],
      ['lone', '\ud801'],
      ['slash/kind', 'id'],
      ['slash', 'kind/id'],
    ]
    await s.commit('k', {
      events: kinds.map(([kind, id]) =>
        ev('harness/entry', { kind, id, body: `${kind}|${id}` }, { register: 'harness/entry' }),
      ),
      expectedWriterRunId: 'r1',
    })
    const rows = await s.registers('k')
    expect(rows).toHaveLength(kinds.length)
    expect(new Set(rows.map((r) => r.key)).size).toBe(kinds.length)
    expect(new Set(rows.map((r) => r.key))).toEqual(new Set(kinds.map(([kind, id]) => `${kind}${NUL}${id}`)))
    // The tombstone names the same key, so a key that did not survive the round trip erases nothing
    // or erases the wrong cell.
    await s.commit('k', {
      events: [
        ev('harness/entry', { kind: 'lone', id: '\ud800', tombstone: true }, { register: 'harness/entry' }),
      ],
      expectedWriterRunId: 'r1',
    })
    const left = (await s.registers('k')).map((r) => r.key)
    expect(left).toHaveLength(kinds.length - 1)
    expect(left).toContain(`lone${NUL}\ud801`)
    expect(left).not.toContain(`lone${NUL}\ud800`)
    await s.close()
  })
  // A lane is the register key for every register but harness/entry and artifact/job, so a lane
  // that does not survive the round trip makes the durable event and its own materialised register
  // disagree - and a register map derived by replaying the ledger stops matching the stored one.
  it(`${name}: a lane round-trips into both the event and the register it keys`, async () => {
    const s = open()
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    const lanes = ['main', 'm\u0000x', 'm\u0000y', '\ud800', 'sub/1']
    await s.commit('k', {
      events: lanes.map((lane) => ev('op.state', { lane }, { register: 'op.state', lane })),
      expectedWriterRunId: 'r1',
    })
    expect(new Set((await s.registers('k')).map((r) => r.key))).toEqual(new Set(lanes))
    expect((await s.scan('k', { limit: 10 })).map((e) => e.lane)).toEqual(lanes)
    for (const lane of lanes)
      expect(
        (await s.scan('k', { lane, limit: 10 })).map((e) => e.lane),
        lane,
      ).toEqual([lane])
    await s.close()
  })
  it(`${name}: a register write only replaces the cell its own key names`, async () => {
    const s = open()
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    await s.commit('k', {
      events: [
        ev('op.state', { step: 1 }, { register: 'op.state', lane: 'main' }),
        ev('op.state', { step: 9 }, { register: 'op.state', lane: 'side' }),
      ],
      expectedWriterRunId: 'r1',
    })
    expect((await s.registers('k')).map((r) => [r.key, r.data])).toEqual([
      ['main', { step: 1 }],
      ['side', { step: 9 }],
    ])
    await s.close()
  })
  it(`${name}: refuses a commit whose expectedRegisterSeq does not match`, async () => {
    const s = open()
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    await s.commit('k', {
      events: [ev('op.state', { step: 1 }, { register: 'op.state' })],
      expectedWriterRunId: 'r1',
    })
    await expect(
      s.commit('k', {
        events: [ev('op.state', { step: 2 }, { register: 'op.state' })],
        expectedWriterRunId: 'r1',
        expectedRegisterSeq: { register: 'op.state', key: 'main', seq: 99 },
      }),
    ).rejects.toMatchObject({ code: 'E_CAS' })
    await expect(
      s.commit('k', {
        events: [ev('op.state', { step: 2 }, { register: 'op.state' })],
        expectedWriterRunId: 'r1',
        expectedRegisterSeq: { register: 'op.state', key: 'main', seq: 1 },
      }),
    ).resolves.toMatchObject({ seqs: [2] })
    await s.close()
  })
  it(`${name}: scan filters by type, lane and order the same way`, async () => {
    const s = open()
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    await s.commit('k', {
      events: [ev('user/message', {}), ev('assistant/message', {}, { lane: 'side' }), ev('user/message', {})],
      expectedWriterRunId: 'r1',
    })
    expect((await s.scan('k', { type: 'user/message', limit: 10 })).map((e) => e.seq)).toEqual([1, 3])
    expect((await s.scan('k', { lane: 'side', limit: 10 })).map((e) => e.seq)).toEqual([2])
    expect((await s.scan('k', { toSeq: 3, order: 'desc' })).map((e) => e.seq)).toEqual([3, 2, 1])
    expect((await s.scan('k', { fromSeq: 2, toSeq: 3 })).map((e) => e.seq)).toEqual([2, 3])
    await s.close()
  })
  it(`${name}: a child reads the parent prefix and continues its seq`, async () => {
    const s = open()
    await s.open('p', { writerRunId: 'r1', ttlMs: 1000 })
    await s.commit('p', {
      events: [ev('user/message', {}), ev('user/message', {})],
      expectedWriterRunId: 'r1',
    })
    await s.createChild('p', 2, 'c')
    expect(await s.open('c', { writerRunId: 'r9', ttlMs: 1000 })).toMatchObject({ lastSeq: 2 })
    expect(
      (await s.commit('c', { events: [ev('session/start', {})], expectedWriterRunId: 'r9' })).seqs,
    ).toEqual([3])
    await s.close()
  })
  it(`${name}: refuses an invalid fork boundary and an existing child key`, async () => {
    const s = open()
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
    await s.close()
  })
  it(`${name}: a renewal restarts the term rather than preserving the time left`, async () => {
    const s = open()
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    await s.renew('k', 'r1')
    await expect(s.renew('k', 'r2')).rejects.toMatchObject({ code: 'E_WRITER_LEASE' })
    await s.close()
  })
}

/**
 * Renew-on-write and conditional self-claim: what every adapter owes core.
 * `open` receives the clock the adapter must use.
 */
export function claimContract(
  name: string,
  open: (clock: () => number) => StorageAdapter,
  ev: (type: string, data: unknown, over?: Partial<PreparedEvent>) => PreparedEvent,
): void {
  const setup = async () => {
    let now = 1_000_000
    const s = open(() => now)
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    await s.commit('k', { events: [ev('user/message', {})], expectedWriterRunId: 'r1' })
    const at = (t: number) => {
      now = t
    }
    const write = (runId: string, claim?: { ttlMs: number; expectedLastSeq: number }) =>
      s.commit('k', {
        events: [ev('user/message', {})],
        expectedWriterRunId: runId,
        ...(claim ? { claim } : {}),
      })
    return { s, at, write, start: now }
  }

  it(`${name}: a claimed commit extends the lease from the time of the write`, async () => {
    const t = await setup()
    t.at(t.start + 900)
    await t.write('r1', { ttlMs: 1000, expectedLastSeq: 1 })
    t.at(t.start + 1800)
    await expect(t.s.renew('k', 'r1')).resolves.toBeUndefined()
    await t.s.close()
  })
  it(`${name}: reclaims its own lapsed lease when nothing was written since`, async () => {
    const t = await setup()
    t.at(t.start + 5000)
    await expect(t.write('r1')).rejects.toMatchObject({ code: 'E_WRITER_LEASE' })
    await expect(t.write('r1', { ttlMs: 2000, expectedLastSeq: 1 })).resolves.toMatchObject({ seqs: [2] })
    t.at(t.start + 6900)
    await expect(t.s.renew('k', 'r1')).resolves.toBeUndefined()
    await t.s.close()
  })
  it(`${name}: reclaims a lease row that was removed`, async () => {
    const t = await setup()
    await t.s.release('k', 'r1')
    await expect(t.write('r1', { ttlMs: 1000, expectedLastSeq: 1 })).resolves.toMatchObject({ seqs: [2] })
    await expect(t.s.open('k', { writerRunId: 'r2', ttlMs: 1000 })).rejects.toMatchObject({
      code: 'E_WRITER_LEASE',
    })
    await t.s.close()
  })
  it(`${name}: refuses to claim over another writer, live or lapsed`, async () => {
    const t = await setup()
    t.at(t.start + 5000)
    await t.s.open('k', { writerRunId: 'r2', ttlMs: 1000 })
    await expect(t.write('r1', { ttlMs: 1000, expectedLastSeq: 1 })).rejects.toMatchObject({
      code: 'E_WRITER_LEASE',
    })
    t.at(t.start + 9000)
    await expect(t.write('r1', { ttlMs: 1000, expectedLastSeq: 1 })).rejects.toMatchObject({
      code: 'E_WRITER_LEASE',
    })
    await t.s.close()
  })
  it(`${name}: refuses to claim once someone else has written, even after they left`, async () => {
    const t = await setup()
    t.at(t.start + 5000)
    await t.s.open('k', { writerRunId: 'r2', ttlMs: 1000 })
    await t.write('r2')
    await t.s.release('k', 'r2')
    await expect(t.write('r1', { ttlMs: 1000, expectedLastSeq: 1 })).rejects.toMatchObject({
      code: 'E_WRITER_LEASE',
    })
    await t.s.close()
  })
  it(`${name}: a fork child with no rows of its own claims against its boundary`, async () => {
    const t = await setup()
    await t.s.createChild('k', 1, 'c')
    await t.s.open('c', { writerRunId: 'rc', ttlMs: 1000 })
    t.at(t.start + 5000)
    await expect(
      t.s.commit('c', {
        events: [ev('session/start', {})],
        expectedWriterRunId: 'rc',
        claim: { ttlMs: 1000, expectedLastSeq: 1 },
      }),
    ).resolves.toMatchObject({ seqs: [2] })
    await t.s.close()
  })
  it(`${name}: a new-session discard claims the same way, and not over another writer`, async () => {
    const t = await setup()
    t.at(t.start + 5000)
    await expect(t.s.discardNewSession?.('k', 'r1')).rejects.toMatchObject({ code: 'E_WRITER_LEASE' })
    await expect(
      t.s.discardNewSession?.('k', 'r1', { ttlMs: 1000, expectedLastSeq: 2 }),
    ).rejects.toMatchObject({ code: 'E_WRITER_LEASE' })
    await t.s.discardNewSession?.('k', 'r1', { ttlMs: 1000, expectedLastSeq: 1 })
    expect(await t.s.scan('k', { toSeq: 10 })).toEqual([])
    await t.s.close()
  })
  it(`${name}: a renewal with a claim takes a lapsed lease back, and not over another writer`, async () => {
    const t = await setup()
    t.at(t.start + 5000)
    await expect(t.s.renew('k', 'r1')).rejects.toMatchObject({ code: 'E_WRITER_LEASE' })
    await t.s.renew('k', 'r1', { ttlMs: 1000, expectedLastSeq: 1 })
    await t.s.release('k', 'r1')
    await t.s.open('k', { writerRunId: 'r2', ttlMs: 1000 })
    await expect(t.s.renew('k', 'r1', { ttlMs: 1000, expectedLastSeq: 1 })).rejects.toMatchObject({
      code: 'E_WRITER_LEASE',
    })
    await t.s.close()
  })
}

/** Writing the program counter's register cell alongside a batch: what every adapter owes core. */
export function opWriteContract(
  name: string,
  open: () => StorageAdapter,
  ev: (type: string, data: unknown, over?: Partial<PreparedEvent>) => PreparedEvent,
): void {
  const op = (step: number) => ({ step, phase: { kind: 'checkpoint' } })
  const opCells = async (s: StorageAdapter, key = 'k') =>
    (await s.registers(key)).filter((row) => row.register === 'op.state')
  const opened = async () => {
    const s = open()
    await s.open('k', { writerRunId: 'r1', ttlMs: 60_000 })
    return s
  }

  it(`${name}: writes the op cell at the batch's last seq and acknowledges it`, async () => {
    const s = await opened()
    const receipt = await s.commit('k', {
      events: [ev('user/message', {}), ev('user/message', {})],
      expectedWriterRunId: 'r1',
      opState: { lane: 'main', data: op(1) as never },
    })
    expect(receipt).toMatchObject({ seqs: [1, 2], opState: { seq: 2 } })
    expect(await opCells(s)).toEqual([{ register: 'op.state', key: 'main', seq: 2, data: op(1) }])
    await s.close()
  })
  it(`${name}: an op write of null removes the cell`, async () => {
    const s = await opened()
    await s.commit('k', {
      events: [ev('user/message', {})],
      expectedWriterRunId: 'r1',
      opState: { lane: 'main', data: op(1) as never },
    })
    const receipt = await s.commit('k', {
      events: [ev('user/message', {})],
      expectedWriterRunId: 'r1',
      opState: { lane: 'main', data: null },
    })
    expect(receipt).toMatchObject({ opState: { seq: 2 } })
    expect(await opCells(s)).toEqual([])
    await s.close()
  })
  it(`${name}: refuses an op write that comes with no rows, and writes nothing`, async () => {
    const s = await opened()
    await expect(
      s.commit('k', {
        events: [],
        expectedWriterRunId: 'r1',
        opState: { lane: 'main', data: op(1) as never },
      }),
    ).rejects.toMatchObject({ code: 'E_STORAGE_FAULT' })
    expect(await s.scan('k', { toSeq: 10 })).toEqual([])
    expect(await opCells(s)).toEqual([])
    await s.close()
  })
  it(`${name}: a failed CAS writes neither rows nor the op cell`, async () => {
    const s = await opened()
    await s.commit('k', {
      events: [ev('user/message', {})],
      expectedWriterRunId: 'r1',
      opState: { lane: 'main', data: op(1) as never },
    })
    await expect(
      s.commit('k', {
        events: [ev('user/message', {})],
        expectedWriterRunId: 'r1',
        expectedRegisterSeq: { register: 'op.state', key: 'main', seq: 99 },
        opState: { lane: 'main', data: op(2) as never },
      }),
    ).rejects.toMatchObject({ code: 'E_CAS' })
    expect(await s.scan('k', { toSeq: 10 })).toHaveLength(1)
    expect(await opCells(s)).toEqual([{ register: 'op.state', key: 'main', seq: 1, data: op(1) }])
    await s.close()
  })
  it(`${name}: the CAS reads an op cell written this way`, async () => {
    const s = await opened()
    await s.commit('k', {
      events: [ev('user/message', {})],
      expectedWriterRunId: 'r1',
      opState: { lane: 'main', data: op(1) as never },
    })
    await expect(
      s.commit('k', {
        events: [ev('user/message', {})],
        expectedWriterRunId: 'r1',
        expectedRegisterSeq: { register: 'op.state', key: 'main', seq: 1 },
        opState: { lane: 'main', data: op(2) as never },
      }),
    ).resolves.toMatchObject({ opState: { seq: 2 } })
    await s.close()
  })
  it(`${name}: a child does not see its parent's op cell`, async () => {
    const s = await opened()
    await s.commit('k', {
      events: [ev('user/message', {})],
      expectedWriterRunId: 'r1',
      opState: { lane: 'main', data: op(1) as never },
    })
    await s.createChild('k', 1, 'c')
    await s.open('c', { writerRunId: 'rc', ttlMs: 60_000 })
    expect(await opCells(s, 'c')).toEqual([])
    await s.commit('c', {
      events: [ev('session/start', {})],
      expectedWriterRunId: 'rc',
      opState: { lane: 'main', data: op(7) as never },
    })
    expect(await opCells(s, 'c')).toEqual([{ register: 'op.state', key: 'main', seq: 2, data: op(7) }])
    expect(await opCells(s)).toEqual([{ register: 'op.state', key: 'main', seq: 1, data: op(1) }])
    await s.close()
  })
}
