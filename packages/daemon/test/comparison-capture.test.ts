import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createComparisonStore } from '@agnes/host'
import type { ComparisonSnapshot, EventEnvelope } from '@agnes/protocol'
import type { ComparisonRecord, Side } from '@agnes/runtime-comparison'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComparisonCapture } from '../src/local/comparison-capture.js'

const recorded = JSON.parse(
  await readFile(new URL('../../core/test/fixtures/comparison-real-cancel.json', import.meta.url), 'utf8'),
) as {
  pair: ComparisonSnapshot
  reports: Array<{ events: EventEnvelope[] }>
}
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose()
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'comparison-capture-'))
  const storage = createComparisonStore(join(directory, 'journal.db'))
  let closed = false
  const closeStorage = () => {
    if (!closed) storage.close()
    closed = true
  }
  const store = storage.scoped('owner')
  const sides: Side[] = ['left', 'right']
  const lanes = Object.fromEntries(
    recorded.pair.lanes.map((lane) => [lane.side, { ...lane, lastSeq: 1 }]),
  ) as ComparisonRecord['lanes']
  const record: ComparisonRecord = {
    id: 'capture-test',
    revision: 0,
    createPayload: '{}',
    creation: 'ready',
    lanes,
    rounds: [],
    cancellation: {},
    cleanup: { exited: [], released: false },
  }
  await store.compareAndSwap(record.id, null, record)
  const rows = new Map(sides.map((side, index) => [lanes[side]!.sessionId, recorded.reports[index]!.events]))
  const heads = new Map(sides.map((side) => [lanes[side]!.sessionId, 1]))
  const generations = new Map(sides.map((side) => [lanes[side]!.sessionId, {}]))
  const listeners = new Map<string, Set<(event: EventEnvelope) => void>>()
  const head = vi.fn(async (key: string) => heads.get(key)!)
  const authorize = vi.fn((principal: string, key: string) => {
    if (principal !== 'owner' || !rows.has(key)) throw new Error('not owned')
  })
  const ports = {
    storage,
    authorize,
    ledger: {
      head,
      async scan(key: string, query: { fromSeq?: number; toSeq?: number }) {
        return rows
          .get(key)!
          .filter((row) => row.seq >= (query.fromSeq ?? 1) && row.seq <= (query.toSeq ?? heads.get(key)!))
      },
    },
    generation: (key: string) => generations.get(key),
    subscribe(key: string, receive: (event: EventEnvelope) => void) {
      const set = listeners.get(key) ?? new Set()
      listeners.set(key, set)
      set.add(receive)
      return () => {
        set.delete(receive)
      }
    },
  }
  const capture = new ComparisonCapture(ports)
  cleanup.push(async () => {
    await capture.close().catch(() => undefined)
    closeStorage()
    await rm(directory, { recursive: true, force: true })
  })
  const emit = (side: Side, seq: number, replace?: Partial<EventEnvelope>) => {
    const key = lanes[side]!.sessionId
    heads.set(key, Math.max(seq, heads.get(key)!))
    const row = { ...rows.get(key)!.find((item) => item.seq === seq)!, ...replace }
    for (const receive of listeners.get(key) ?? []) receive(row)
  }
  return {
    capture,
    ports,
    store,
    closeStorage,
    rows,
    heads,
    generations,
    listeners,
    head,
    lanes,
    record,
    emit,
  }
}

describe('backend comparison committed-event capture from a real two-lane recording', () => {
  it('reproduces the interleaving observed by the real daemon publisher after its baseline', async () => {
    const actual = JSON.parse(
      await readFile(
        new URL('../../core/test/fixtures/comparison-real-journal.json', import.meta.url),
        'utf8',
      ),
    )
    const f = await fixture()
    for (const report of actual.reports) {
      f.rows.set(report.lane.sessionId, report.events)
      f.heads.set(report.lane.sessionId, 3)
    }
    await f.capture.ensure('owner', f.record.id)
    const published = actual.entries.filter((entry: { fact: { kind: string } }) => entry.fact.kind === 'lane')
    for (const entry of published) f.emit(entry.fact.side, entry.fact.localSeq)
    await f.capture.flush('owner', f.record.id)
    const replayed = (await f.store.journal.read(f.record.id)).entries.filter(
      (entry) => entry.fact.kind === 'lane',
    )
    expect(replayed.map(({ cuts, fact }) => ({ cuts, fact }))).toEqual(
      published.map(({ cuts, fact }: { cuts: unknown; fact: unknown }) => ({ cuts, fact })),
    )
    expect((await f.store.journal.head(f.record.id))?.cuts).toEqual({ left: 24, right: 37 })
  })
  it('shares concurrent ensures, publishes observer order, and makes duplicate delivery idempotent', async () => {
    const f = await fixture()
    await Promise.all([f.capture.ensure('owner', f.record.id), f.capture.ensure('owner', f.record.id)])
    expect([...f.listeners.values()].map((set) => set.size)).toEqual([1, 1])
    f.emit('right', 2)
    f.emit('left', 2)
    f.emit('right', 3)
    f.emit('right', 3)
    await f.capture.flush('owner', f.record.id)
    const page = await f.store.journal.read(f.record.id)
    expect(
      page.entries.filter((entry) => entry.fact.kind === 'lane').map((entry) => entry.fact),
    ).toMatchObject([
      { side: 'right', localSeq: 2 },
      { side: 'left', localSeq: 2 },
      { side: 'right', localSeq: 3 },
    ])
    expect(page.entries.at(-1)?.cuts).toEqual({ left: 2, right: 3 })
    expect(page.entries.find((entry) => entry.fact.kind === 'checkpoint')?.fact).toMatchObject({
      reason: 'baseline',
      coverage: 'unknown-interleaving',
    })
  })

  it('buffers subscribe/head races and labels generation gaps with an explicit recovery checkpoint', async () => {
    const f = await fixture()
    f.head.mockImplementationOnce(async (key) => {
      f.emit('left', 2)
      f.emit('right', 2)
      return f.heads.get(key)!
    })
    await f.capture.ensure('owner', f.record.id)
    expect((await f.store.journal.head(f.record.id))?.cuts).toEqual({ left: 2, right: 2 })
    const left = f.lanes.left!.sessionId
    f.generations.set(left, {})
    f.emit('right', 3) // a peer callback must also fence an automatically replaced worker
    await expect(f.capture.flush('owner', f.record.id)).rejects.toMatchObject({
      code: 'COMPARISON_CAPTURE_GENERATION_CHANGED',
    })
    f.heads.set(left, 5)
    f.heads.set(f.lanes.right!.sessionId, 4)
    await f.capture.ensure('owner', f.record.id)
    const recovered = await f.store.journal.read(f.record.id)
    expect(recovered.entries.at(-1)).toMatchObject({
      cuts: { left: 5, right: 4 },
      fact: { kind: 'checkpoint', reason: 'recovery', coverage: 'unknown-interleaving' },
    })
    expect(recovered.entries.filter((entry) => entry.fact.kind === 'lane')).toHaveLength(0)
    f.emit('left', 2) // a delayed callback covered by the checkpoint
    f.emit('right', 5)
    await f.capture.flush('owner', f.record.id)
    expect((await f.store.journal.head(f.record.id))?.cuts).toEqual({ left: 5, right: 5 })
    expect([...f.listeners.values()].map((set) => set.size)).toEqual([1, 1])
  })

  it.each(['gap', 'conflict', 'storage'] as const)(
    'poisons %s failures and never publishes later callbacks',
    async (kind) => {
      const f = await fixture()
      await f.capture.ensure('owner', f.record.id)
      if (kind === 'gap') f.emit('left', 3)
      if (kind === 'conflict') {
        f.emit('left', 2)
        f.emit('left', 2, { id: 'conflicting-event' })
      }
      if (kind === 'storage') {
        // Capture already owns this scoped store. A SQLite close is a real append failure.
        f.closeStorage()
        f.emit('left', 2)
      }
      f.emit('right', 2)
      await expect(f.capture.flush('owner', f.record.id)).rejects.toThrow()
      await expect(f.capture.ensure('owner', f.record.id)).rejects.toThrow()
      expect([...f.listeners.values()].every((set) => set.size === 0)).toBe(true)
      if (kind !== 'storage') expect((await f.store.journal.head(f.record.id))?.cuts.right).toBe(1)
    },
  )

  it('refuses foreign session identity without opening sessions and drains before disposing', async () => {
    const f = await fixture()
    const start = f.rows.get(f.lanes.left!.sessionId)![0]!
    f.rows.set(f.lanes.left!.sessionId, [
      { ...start, data: { ...(start.data as object), key: 'foreign-session' } },
    ])
    await expect(f.capture.ensure('owner', f.record.id)).rejects.toMatchObject({
      code: 'COMPARISON_CAPTURE_IDENTITY',
    })
    expect([...f.listeners.values()].every((set) => set.size === 0)).toBe(true)
    expect((await f.store.journal.head(f.record.id))?.cuts).toEqual({ left: 0, right: 0 })
    const good = await fixture()
    await good.capture.ensure('owner', good.record.id)
    good.emit('left', 2)
    good.capture.beginShutdown()
    good.generations.clear() // registry forgets an exiting writer before its final callbacks drain
    good.emit('right', 2)
    await good.capture.close()
    expect((await good.store.journal.head(good.record.id))?.cuts.left).toBe(2)
    good.emit('right', 3)
    expect((await good.store.journal.head(good.record.id))?.cuts.right).toBe(2)
  })
})

it('publishes independent child watermarks in the shared journal without advancing old selected prefixes', async () => {
  const f = await fixture()
  let childHead = 1
  Object.assign(f.ports.ledger, {
    captureTree: async (key: string) => {
      const side = key === f.lanes.left?.sessionId ? 'left' : 'right'
      const lane = f.lanes[side]
      if (!lane) throw new Error('Missing lane')
      return {
        complete: true,
        issues: [],
        members: [
          {
            sessionId: key,
            parentSessionId: null,
            runtime: lane.runtime,
            inheritedThroughSeq: 0,
            throughSeq: f.heads.get(key),
          },
          ...(side === 'left'
            ? [
                {
                  sessionId: 'owned-child',
                  parentSessionId: key,
                  runtime: lane.runtime,
                  inheritedThroughSeq: 0,
                  throughSeq: childHead,
                },
              ]
            : []),
        ],
      }
    },
  })
  await f.capture.ensure('owner', f.record.id)
  const first = await f.store.journal.head(f.record.id)
  if (!first) throw new Error('Missing journal')
  expect((await f.store.journal.treeCutsAt(f.record.id, first.seq))?.left?.members[1]?.throughSeq).toBe(1)
  childHead = 7
  await f.capture.flush('owner', f.record.id)
  const second = await f.store.journal.head(f.record.id)
  if (!second) throw new Error('Missing journal')
  expect(second.seq).toBeGreaterThan(first.seq)
  expect(second.cuts).toEqual(first.cuts)
  expect((await f.store.journal.treeCutsAt(f.record.id, second.seq))?.left?.members[1]?.throughSeq).toBe(7)
  expect((await f.store.journal.treeCutsAt(f.record.id, first.seq))?.left?.members[1]?.throughSeq).toBe(1)
  await f.capture.flush('owner', f.record.id)
  expect((await f.store.journal.head(f.record.id))?.seq).toBe(second.seq)
})
