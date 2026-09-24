import type { Provider, UISpan } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChildExecutionState } from '../src/child/types.js'
import { Kernel } from '../src/kernel.js'
import type { ScanQuery } from '../src/log/storage.js'
import { ChildTraceCache } from '../src/project/child-trace-cache.js'
import { projectUI, UIProjectionCell } from '../src/project/ui.js'
import type { Event, Seq } from '../src/types.js'
import {
  answerThenHang,
  cancel,
  childRows,
  closeKernels,
  hangingProvider,
  row,
  scripted,
  setupWith,
  slowCommits,
  spawnChild,
  spawnTurn,
  subagentSpan,
  uncachedProjection,
  until,
  wait,
} from './helpers/child-traces.js'
import { actor } from './helpers/open-session.js'

const setup = (provider: Provider) => setupWith(provider, (options) => Kernel.create(options))

afterEach(closeKernels)

describe('a cancelled child can still write after its record turns terminal', () => {
  it('cancel() returns with a terminal record while the in-flight run keeps appending', async () => {
    const { storage, parent } = await setup(hangingProvider())
    const handle = await spawnChild(parent, 'child work')
    const slow = slowCommits(storage, () => handle.key)
    const running = handle.run('child work').catch((error: unknown) => error)
    expect(
      await until(async () =>
        (await childRows(storage, handle.key)).some((e) => e.type === 'assistant/output'),
      ),
    ).toBe(true)

    slow.value = true
    await cancel(handle)
    const record = await storage.lookupByKey(handle.key)
    expect(record?.state).toBe('cancelled')
    const atCancel = (await childRows(storage, handle.key)).length
    expect((await childRows(storage, handle.key)).map((e) => e.type)).not.toContain('turn/end')

    await running
    const after = await childRows(storage, handle.key)
    // The terminal record plus an empty scan is therefore not proof the child ledger is settled.
    expect(after.length).toBeGreaterThan(atCancel)
    expect(after.map((e) => e.type)).toContain('turn/end')
  })

  it('a web patch driven by the next parent event carries the child rows written after cancel', async () => {
    const { storage, parent } = await setup(hangingProvider())
    const handle = await spawnChild(parent, 'child work')
    const slow = slowCommits(storage, () => handle.key)
    const running = handle.run('child work').catch((error: unknown) => error)
    expect(
      await until(async () =>
        (await childRows(storage, handle.key)).some((e) => e.type === 'assistant/output'),
      ),
    ).toBe(true)
    await parent.d.log.append(spawnTurn(1, [handle.key]))
    const opening = await parent.projectUIOpening({ surface: 'web', maxNodes: 500, maxBytes: 1024 * 1024 })
    expect(subagentSpan(opening.timeline.turns, handle.key)?.children[0]?.status).toBe('running')

    slow.value = true
    await cancel(handle)
    await running
    await parent.d.log.append([row('user/message', { content: [{ type: 'text', text: 'next' }] })])
    const update = await parent.projectUIPatch(opening.timeline.upto, undefined, { surface: 'web' })
    if (update.kind !== 'patch') throw new Error('expected a live patch')
    const resent = update.patch.turnChanges.flatMap((change) => (change.op === 'upsert' ? [change.turn] : []))
    const nested = subagentSpan(resent, handle.key)
    expect(nested?.children[0]?.status).toBe('cancelled')
    expect(nested?.children[0]?.endSeq).toBeDefined()
    const full = await parent.projectUI()
    expect(resent.find((turn) => turn.id === 'turn:1')).toEqual(
      full.turns.find((turn) => turn.id === 'turn:1'),
    )
  })
})

/** One closed child turn with `calls` title calls, appended in one step to an open child session. */
async function childTurn(k: Kernel, childKey: string, turn: number, calls = 3) {
  const child = k.get(childKey)
  if (!child) throw new Error('child session is not open')
  await child.append([
    row('turn/start', { turn, trigger: 'prompt' }),
    ...Array.from({ length: calls }, (_, i) =>
      row('cost/ledger', {
        purpose: 'title',
        effectId: `call-${turn}-${i}`,
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        creditSource: 'estimated',
        model: `model-${i}`,
        sourceTurn: turn,
      }),
    ),
    row('turn/end', { reason: 'completed', lastAssistantSeq: null }),
  ])
}

describe('web projection holds one session-level lock across probe and compute', () => {
  it('a client whose patch probed a child before it changed still gets the change on its next patch', async () => {
    const { storage, k, parent } = await setup(scripted(['unused']))
    const c1 = await spawnChild(parent, 'one')
    const c2 = await spawnChild(parent, 'two')
    await childTurn(k, c1.key, 1)
    await childTurn(k, c2.key, 1)
    // A terminal child keeps no live fold, so a change to it is folded into a new cache entry and
    // an earlier probe's view of it goes stale.
    const record = await storage.lookupByKey(c1.key)
    if (!record || !(await storage.casState(c1.key, record.stateRevision, 'cancelled')))
      throw new Error('could not end child 1')
    await parent.d.log.append(spawnTurn(1, [c1.key, c2.key]))
    const opening = await parent.projectUIOpening({ surface: 'web', maxNodes: 500, maxBytes: 1024 * 1024 })
    await parent.d.log.append([row('user/message', { content: [{ type: 'text', text: 'flush' }] })])
    const flushed = await parent.projectUIPatch(opening.timeline.upto, undefined, { surface: 'web' })
    if (flushed.kind !== 'patch') throw new Error('expected a live patch')
    const base = flushed.patch.upto

    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let armed = true
    const original = storage.scan.bind(storage)
    const scan = vi.spyOn(storage, 'scan').mockImplementation(async (key, q) => {
      if (key === c2.key && armed) {
        armed = false
        await gate
      }
      return original(key, q)
    })
    // Client B's patch reads child 1 (unchanged) and stops inside child 2's read.
    const b1 = parent.projectUIPatch(base, undefined, { surface: 'web' })
    expect(await until(() => !armed, 300)).toBe(true)
    // Child 1 changes; client A's patch may observe it; then the parent moves on.
    await childTurn(k, c1.key, 2)
    const a1 = parent.projectUIPatch(base, undefined, { surface: 'web' })
    await wait(20)
    await parent.d.log.append([row('user/message', { content: [{ type: 'text', text: 'moved on' }] })])
    release()
    const [b, a] = await Promise.all([b1, a1])
    scan.mockRestore()
    if (b.kind !== 'patch' || a.kind !== 'patch') throw new Error('expected live patches')
    const b2 = await parent.projectUIPatch(b.patch.upto, undefined, { surface: 'web' })
    if (b2.kind !== 'patch') throw new Error('expected a live patch')
    const full = await parent.projectUI()
    // Whatever client B saw last for turn 1 must be the current tree.
    const seen = [b, b2]
      .flatMap((update) => update.patch.turnChanges)
      .flatMap((change) => (change.op === 'upsert' && change.turn.id === 'turn:1' ? [change.turn] : []))
      .at(-1)
    expect(seen).toEqual(full.turns.find((turn) => turn.id === 'turn:1'))
    expect(seen && subagentSpan([seen], c1.key)?.children).toHaveLength(2)
  })

  it('a second web patch does not probe children while the first is still probing', async () => {
    const { storage, parent } = await setup(scripted(['child answer']))
    const handle = await spawnChild(parent, 'child work')
    await handle.run('child work')
    await parent.d.log.append(spawnTurn(1, [handle.key]))
    const opening = await parent.projectUIOpening({ surface: 'web', maxNodes: 500, maxBytes: 1024 * 1024 })

    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = storage.scan.bind(storage)
    const scan = vi.spyOn(storage, 'scan').mockImplementation(async (key, q) => {
      if (key === handle.key) await gate
      return original(key, q)
    })
    const childScans = () => scan.mock.calls.filter((call) => call[0] === handle.key).length

    const first = parent.projectUIPatch(opening.timeline.upto, undefined, { surface: 'web' })
    const probing = await until(() => childScans() === 1, 300)
    const second = parent.projectUIPatch(opening.timeline.upto, undefined, { surface: 'web' })
    await wait(20)
    const overlapped = childScans()
    release()
    await Promise.all([first, second])
    expect(probing).toBe(true)
    expect(overlapped).toBe(1)
    expect(childScans()).toBe(2)
  })
})

// ---------------------------------------------------------------------------------------------
// The cache itself, against a scripted child ledger.

const childEvent = (seq: number, type: string, data: Event['data']): Event => ({
  seq: seq as Seq,
  ts: new Date(Date.UTC(2026, 8, 24, 1, 0, seq)).toISOString(),
  id: `01K00000000000000000C${String(seq).padStart(5, '0')}`,
  type,
  data,
  actor,
  origin: 'system',
  trust: 'trusted',
})

/** `turns` whole child turns, numbered from `firstTurn`, starting right after `after`. */
function childTurns(after: number, turns: number, firstTurn = 1): Event[] {
  const out: Event[] = []
  let seq = after
  for (let t = firstTurn; t < firstTurn + turns; t += 1) {
    const effectId = `inf-${t}`
    out.push(childEvent(++seq, 'turn/start', { turn: t, trigger: 'prompt' }))
    out.push(childEvent(++seq, 'step/start', { turn: t, step: 1 }))
    out.push(childEvent(++seq, 'effect/intent', { effectId, kind: 'inference', replay: 'safe' }))
    out.push(
      childEvent(++seq, 'cost/ledger', {
        purpose: 'inference',
        effectId,
        tokens: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        creditSource: 'estimated',
        model: 'child-model',
        timing: { durationMs: 5 },
      }),
    )
    out.push(childEvent(++seq, 'step/end', { turn: t, step: 1 }))
    out.push(childEvent(++seq, 'turn/end', { reason: 'completed', lastAssistantSeq: null }))
  }
  return out
}

/** A child ledger the test edits between probes, served by a spyable source. */
function scriptedChildren(parentKey = 'parent', delay: (childKey: string) => number = () => 0) {
  const ledgers = new Map<string, { boundarySeq: Seq; state: string; parentKey: string; rows: Event[] }>()
  const source = {
    lookup: vi.fn(async (childKey: string) => {
      const ledger = ledgers.get(childKey)
      return ledger
        ? {
            parentKey: ledger.parentKey,
            boundarySeq: ledger.boundarySeq,
            state: ledger.state as ChildExecutionState,
          }
        : null
    }),
    scan: vi.fn(async (childKey: string, q: ScanQuery) => {
      // Microtask-sized pauses, so concurrent resolves interleave between each other's steps.
      for (let turn = delay(childKey); turn > 0; turn -= 1) await Promise.resolve()
      const rows = ledgers.get(childKey)?.rows ?? []
      return rows.filter((row) => row.seq >= (q.fromSeq ?? 1)).slice(0, q.limit)
    }),
  }
  const set = (childKey: string, boundarySeq: number, rows: Event[], state = 'running') =>
    ledgers.set(childKey, { boundarySeq: boundarySeq as Seq, state, parentKey, rows })
  return { ledgers, source, set }
}

async function expectedSpans(childKey: string, boundarySeq: number, rows: Event[]): Promise<UISpan[]> {
  const timeline = await projectUI(rows, { sessionKey: childKey, lane: 'main', afterSeq: boundarySeq as Seq })
  return timeline.turns.map((turn) => turn.trace).filter((span): span is UISpan => span !== undefined)
}

const scanStarts = (source: { scan: { mock: { calls: Array<[string, ScanQuery]> } } }, childKey: string) =>
  source.scan.mock.calls.filter((call) => call[0] === childKey).map((call) => call[1].fromSeq)

describe('ChildTraceCache', () => {
  afterEach(() => vi.restoreAllMocks())

  it('builds the same spans the old full fold did, and reads only new rows on the next probe', async () => {
    const { source, set, ledgers } = scriptedChildren()
    set('c', 4, childTurns(4, 2))
    const cache = new ChildTraceCache('parent', source)
    const first = await cache.resolve('c', 10 as Seq)
    expect(first?.spans).toEqual(await expectedSpans('c', 4, childTurns(4, 2)))
    expect(first?.changedAtParentSeq).toBe(10)
    expect(scanStarts(source, 'c')).toEqual([5])

    source.scan.mockClear()
    const apply = vi.spyOn(UIProjectionCell.prototype, 'apply')
    const again = await cache.resolve('c', 11 as Seq)
    expect(scanStarts(source, 'c')).toEqual([17])
    expect(apply).not.toHaveBeenCalled()
    expect(again?.spans).toEqual(first?.spans)
    expect(again?.changedAtParentSeq).toBe(10)

    const rows = childTurns(4, 3)
    const ledger = ledgers.get('c')
    if (ledger) ledger.rows = rows
    source.scan.mockClear()
    const grown = await cache.resolve('c', 12 as Seq)
    expect(scanStarts(source, 'c')).toEqual([17])
    expect(apply.mock.calls.reduce((sum, call) => sum + call[0].length, 0)).toBe(6)
    expect(grown?.spans).toEqual(await expectedSpans('c', 4, rows))
    expect(grown?.changedAtParentSeq).toBe(12)
  })

  it('pages a long child ledger in bounded reads', async () => {
    const { source, set } = scriptedChildren()
    const rows = childTurns(0, 120)
    set('c', 0, rows)
    const cache = new ChildTraceCache('parent', source)
    const found = await cache.resolve('c', 1 as Seq)
    expect(found?.spans).toEqual(await expectedSpans('c', 0, rows))
    for (const [, q] of source.scan.mock.calls) expect(q.limit).toBeLessThanOrEqual(500)
    expect(scanStarts(source, 'c')).toEqual([1, 501])
  })

  it('keeps the authorization gate on every probe', async () => {
    const { source, set, ledgers } = scriptedChildren()
    set('c', 0, childTurns(0, 1))
    const cache = new ChildTraceCache('parent', source)
    expect(await cache.resolve('c', 1 as Seq)).toBeDefined()
    const ledger = ledgers.get('c')
    if (ledger) ledger.parentKey = 'someone-else'
    expect(await cache.resolve('c', 2 as Seq)).toBeUndefined()
    ledgers.delete('c')
    expect(await cache.resolve('c', 3 as Seq)).toBeUndefined()
    expect(source.lookup).toHaveBeenCalledTimes(3)
  })

  it('rebuilds from the boundary when the boundary moves or the ledger skips a seq', async () => {
    const { source, set, ledgers } = scriptedChildren()
    set('c', 4, childTurns(4, 1))
    const cache = new ChildTraceCache('parent', source)
    await cache.resolve('c', 1 as Seq)

    set('c', 7, childTurns(7, 2, 5))
    source.scan.mockClear()
    const moved = await cache.resolve('c', 2 as Seq)
    expect(scanStarts(source, 'c')).toEqual([8])
    expect(moved?.spans).toEqual(await expectedSpans('c', 7, childTurns(7, 2, 5)))
    expect(moved?.changedAtParentSeq).toBe(2)

    // The next rows no longer continue the folded tail (seq 20 is missing), so the tail is rebuilt.
    const replaced = [...childTurns(7, 2, 5), ...childTurns(19, 1, 7)].map((row) =>
      row.seq >= 20 ? { ...row, seq: (row.seq + 1) as Seq } : row,
    )
    const ledger = ledgers.get('c')
    if (ledger) ledger.rows = replaced
    source.scan.mockClear()
    const rebuilt = await cache.resolve('c', 3 as Seq)
    expect(scanStarts(source, 'c')).toEqual([20, 8])
    // The cold fold refuses the non-contiguous ledger the same way the old full fold did.
    expect(rebuilt).toBeUndefined()

    const repaired = [...childTurns(7, 2, 5), ...childTurns(19, 1, 7)]
    if (ledger) ledger.rows = repaired
    const again = await cache.resolve('c', 4 as Seq)
    expect(again?.spans).toEqual(await expectedSpans('c', 7, repaired))
  })

  it('drops the live fold of a terminal child and rebuilds if the child writes again', async () => {
    const { source, set, ledgers } = scriptedChildren()
    set('c', 0, childTurns(0, 1), 'cancelled')
    const cache = new ChildTraceCache('parent', source)
    await cache.resolve('c', 1 as Seq)
    const ledger = ledgers.get('c')
    if (ledger) ledger.rows = childTurns(0, 2)
    source.scan.mockClear()
    const late = await cache.resolve('c', 2 as Seq)
    expect(scanStarts(source, 'c')).toEqual([7, 1])
    expect(late?.spans).toEqual(await expectedSpans('c', 0, childTurns(0, 2)))
    expect(late?.changedAtParentSeq).toBe(2)
  })

  it('evicts least recently used entries and live folds; an evicted child is rebuilt correctly', async () => {
    const { source, set, ledgers } = scriptedChildren()
    for (const key of ['a', 'b', 'c']) set(key, 0, childTurns(0, 1))
    const cache = new ChildTraceCache('parent', source, {
      maxEntries: 2,
      maxBytes: 8 * 1024 * 1024,
      maxCells: 1,
    })
    await cache.resolve('a', 1 as Seq)
    await cache.resolve('b', 1 as Seq)
    // Only one live fold is kept: 'a' lost its fold to 'b', so its new rows rebuild from the boundary.
    const a = ledgers.get('a')
    if (a) a.rows = childTurns(0, 2)
    source.scan.mockClear()
    expect((await cache.resolve('a', 2 as Seq))?.spans).toEqual(await expectedSpans('a', 0, childTurns(0, 2)))
    expect(scanStarts(source, 'a')).toEqual([7, 1])

    // A third entry pushes out the least recently used one ('b').
    await cache.resolve('c', 3 as Seq)
    source.scan.mockClear()
    expect((await cache.resolve('b', 4 as Seq))?.spans).toEqual(await expectedSpans('b', 0, childTurns(0, 1)))
    expect(scanStarts(source, 'b')).toEqual([1])

    // Over the byte bound the child just resolved stays; the others go.
    const tiny = new ChildTraceCache('parent', source, { maxEntries: 10, maxBytes: 16, maxCells: 8 })
    expect((await tiny.resolve('c', 1 as Seq))?.spans).toEqual(await expectedSpans('c', 0, childTurns(0, 1)))
    await tiny.resolve('b', 2 as Seq)
    source.scan.mockClear()
    await tiny.resolve('c', 3 as Seq)
    expect(scanStarts(source, 'c')).toEqual([1])
    await tiny.resolve('c', 4 as Seq)
    expect(scanStarts(source, 'c')).toEqual([1, 7])
  })

  it('falls back to a cold rebuild when an incremental read fails, and to nothing when that fails too', async () => {
    const { source, set, ledgers } = scriptedChildren()
    set('c', 0, childTurns(0, 1))
    const cache = new ChildTraceCache('parent', source)
    await cache.resolve('c', 1 as Seq)
    const ledger = ledgers.get('c')
    if (ledger) ledger.rows = childTurns(0, 2)
    const scan = source.scan.getMockImplementation()
    source.scan.mockImplementationOnce(async () => {
      throw new Error('transient')
    })
    source.scan.mockClear()
    expect((await cache.resolve('c', 2 as Seq))?.spans).toEqual(await expectedSpans('c', 0, childTurns(0, 2)))
    expect(scanStarts(source, 'c')).toEqual([7, 1])

    source.scan.mockImplementation(async () => {
      throw new Error('gone')
    })
    expect(await cache.resolve('c', 3 as Seq)).toBeUndefined()
    if (scan) source.scan.mockImplementation(scan)
    source.scan.mockClear()
    await cache.resolve('c', 4 as Seq)
    expect(scanStarts(source, 'c')).toEqual([1])
  })

  it('keeps its byte count true when resolves for different children interleave', async () => {
    const keys = Array.from({ length: 10 }, (_, i) => `k${i}`)
    // Uneven read delays so every round's resolves finish in a different order than they start.
    const { source, set } = scriptedChildren('parent', (key) => (Number(key.slice(1)) * 7) % 5)
    for (const key of keys) set(key, 0, childTurns(0, 1))
    const entryBytes = new TextEncoder().encode(
      JSON.stringify(await expectedSpans('k0', 0, childTurns(0, 1))),
    ).byteLength
    const cache = new ChildTraceCache('parent', source, { maxBytes: 3 * entryBytes, maxCells: 0 })
    for (let round = 1; round <= 3; round += 1)
      await Promise.all(keys.map((key) => cache.resolve(key, round as Seq)))
    const stats = cache.stats()
    expect(stats.bytes).toBe(stats.entries * entryBytes)
    expect(stats.entries).toBeLessThanOrEqual(3)
  })

  it('keeps the child it just resolved even when that child alone is over the byte bound', async () => {
    const { source, set, ledgers } = scriptedChildren()
    set('small', 0, childTurns(0, 1))
    set('big', 0, childTurns(0, 40))
    const small = new TextEncoder().encode(
      JSON.stringify(await expectedSpans('small', 0, childTurns(0, 1))),
    ).byteLength
    const cache = new ChildTraceCache('parent', source, { maxBytes: 2 * small, maxCells: 8 })
    await cache.resolve('small', 1 as Seq)
    await cache.resolve('big', 2 as Seq)
    source.scan.mockClear()
    // The big child is read from its tail, not folded again; the small one made room for it.
    expect((await cache.resolve('big', 3 as Seq))?.spans).toEqual(
      await expectedSpans('big', 0, childTurns(0, 40)),
    )
    expect(scanStarts(source, 'big')).toEqual([241])
    await cache.resolve('small', 4 as Seq)
    expect(scanStarts(source, 'small')).toEqual([1])
    // 'small' then pushed it out; folded again, it keeps its live fold and applies new rows.
    await cache.resolve('big', 5 as Seq)
    const big = ledgers.get('big')
    if (big) big.rows = childTurns(0, 41)
    source.scan.mockClear()
    const grown = await cache.resolve('big', 6 as Seq)
    expect(grown?.spans).toEqual(await expectedSpans('big', 0, childTurns(0, 41)))
    expect(scanStarts(source, 'big')).toEqual([241])
  })

  it('remembers when an evicted child last changed, so refolding the same rows is not a change', async () => {
    const { source, set, ledgers } = scriptedChildren()
    set('a', 0, childTurns(0, 1))
    set('b', 0, childTurns(0, 1))
    const cache = new ChildTraceCache('parent', source, { maxEntries: 1 })
    expect((await cache.resolve('a', 3 as Seq))?.changedAtParentSeq).toBe(3)
    await cache.resolve('b', 4 as Seq)
    source.scan.mockClear()
    // 'a' was evicted by 'b'; it is folded again, from the same rows, and did not change.
    expect((await cache.resolve('a', 9 as Seq))?.changedAtParentSeq).toBe(3)
    expect(scanStarts(source, 'a')).toEqual([1])
    await cache.resolve('b', 10 as Seq)
    const a = ledgers.get('a')
    if (a) a.rows = childTurns(0, 2)
    expect((await cache.resolve('a', 11 as Seq))?.changedAtParentSeq).toBe(11)
    // A moved boundary is a new fold even at the same tail.
    set('b', 1, childTurns(1, 1))
    const b = await cache.resolve('b', 12 as Seq)
    expect(b?.changedAtParentSeq).toBe(12)
  })

  it('counts the rows behind each live fold against the byte bound and drops older folds first', async () => {
    const { source, set, ledgers } = scriptedChildren()
    set('a', 0, childTurns(0, 1))
    set('b', 0, childTurns(0, 1))
    const spans = new TextEncoder().encode(
      JSON.stringify(await expectedSpans('a', 0, childTurns(0, 1))),
    ).byteLength
    const rows = childTurns(0, 1).reduce(
      (sum, row) => sum + new TextEncoder().encode(JSON.stringify(row)).byteLength,
      0,
    )
    // Room for both children's spans and one live fold, not two.
    const cache = new ChildTraceCache('parent', source, { maxBytes: 2 * spans + rows, maxCells: 8 })
    await cache.resolve('a', 1 as Seq)
    await cache.resolve('b', 2 as Seq)
    expect(cache.stats()).toMatchObject({ entries: 2, cells: 1 })
    source.scan.mockClear()
    // 'a' is still cached (read from its tail) but lost its fold, so its new rows are refolded.
    await cache.resolve('a', 3 as Seq)
    expect(scanStarts(source, 'a')).toEqual([7])
    const a = ledgers.get('a')
    if (a) a.rows = childTurns(0, 2)
    source.scan.mockClear()
    expect((await cache.resolve('a', 4 as Seq))?.spans).toEqual(await expectedSpans('a', 0, childTurns(0, 2)))
    expect(scanStarts(source, 'a')).toEqual([7, 1])
  })

  it('reuses the spans of turns that were already closed when new rows arrive', async () => {
    const { source, set, ledgers } = scriptedChildren()
    set('c', 0, childTurns(0, 2))
    const cache = new ChildTraceCache('parent', source)
    const first = [...((await cache.resolve('c', 1 as Seq))?.spans ?? [])]
    const ledger = ledgers.get('c')
    if (ledger) ledger.rows = childTurns(0, 3)
    const grown = await cache.resolve('c', 2 as Seq)
    expect(grown?.spans).toEqual(await expectedSpans('c', 0, childTurns(0, 3)))
    expect(grown?.spans[0]).toBe(first[0])
    expect(grown?.spans[1]).toBe(first[1])
    expect(grown?.bytes).toBe(new TextEncoder().encode(JSON.stringify(grown?.spans)).byteLength)
  })

  it('returns nothing for a child with no rows past its boundary yet', async () => {
    const { source, set } = scriptedChildren()
    set('c', 3, [])
    const cache = new ChildTraceCache('parent', source)
    expect(await cache.resolve('c', 1 as Seq)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------------------------
// Session projection through the cache.

describe('SessionImpl.projectUI through the child trace cache', () => {
  afterEach(() => vi.restoreAllMocks())

  it('keeps full projections byte-identical for every surface while a child grows and ends', async () => {
    const { storage, parent } = await setup(answerThenHang())
    const done = await spawnChild(parent, 'first')
    await done.run('first')
    const live = await spawnChild(parent, 'second')
    const slow = slowCommits(storage, () => live.key)
    const running = live.run('second').catch((error: unknown) => error)
    expect(
      await until(async () =>
        (await childRows(storage, live.key)).some((e) => e.type === 'assistant/output'),
      ),
    ).toBe(true)
    // The same child is spawned from two turns; only its first span gets the subtree.
    await parent.d.log.append(spawnTurn(1, [done.key, live.key]))
    await parent.d.log.append(spawnTurn(2, [done.key]))

    const surfaces = [undefined, 'tui', 'web', 'channel'] as const
    for (const surface of surfaces) {
      const { current, reference } = await uncachedProjection(parent, storage, surface)
      expect(JSON.stringify(current)).toBe(JSON.stringify(reference))
    }
    expect(subagentSpan((await parent.projectUI()).turns, live.key)?.children[0]?.status).toBe('running')

    slow.value = true
    await cancel(live)
    await running
    for (const surface of surfaces) {
      const { current, reference } = await uncachedProjection(parent, storage, surface)
      expect(JSON.stringify(current)).toBe(JSON.stringify(reference))
    }
    expect(subagentSpan((await parent.projectUI()).turns, live.key)?.children[0]?.status).toBe('cancelled')
  })

  it('reads only rows a child appended since the last projection and folds exactly those', async () => {
    const { storage, parent } = await setup(answerThenHang())
    const done = await spawnChild(parent, 'first')
    await done.run('first')
    const live = await spawnChild(parent, 'second')
    const slow = slowCommits(storage, () => live.key)
    const running = live.run('second').catch((error: unknown) => error)
    expect(
      await until(async () =>
        (await childRows(storage, live.key)).some((e) => e.type === 'assistant/output'),
      ),
    ).toBe(true)
    await parent.d.log.append(spawnTurn(1, [done.key, live.key]))
    await parent.projectUI()
    const before = await childRows(storage, live.key)
    const doneTail = (await childRows(storage, done.key)).at(-1)?.seq ?? 0

    slow.value = true
    await cancel(live)
    await running
    const after = await childRows(storage, live.key)
    const scan = vi.spyOn(storage, 'scan')
    const apply = vi.spyOn(UIProjectionCell.prototype, 'apply')
    await parent.projectUI()
    const starts = (key: string) =>
      scan.mock.calls.filter((call) => call[0] === key).map((call) => call[1].fromSeq)
    expect(starts(done.key)).toEqual([doneTail + 1])
    expect(starts(live.key)).toEqual([(before.at(-1)?.seq ?? 0) + 1])
    expect(apply.mock.calls.reduce((sum, call) => sum + call[0].length, 0)).toBe(after.length - before.length)

    scan.mockClear()
    apply.mockClear()
    await parent.projectUI()
    expect(starts(done.key)).toEqual([doneTail + 1])
    expect(starts(live.key)).toEqual([(after.at(-1)?.seq ?? 0) + 1])
    expect(apply).not.toHaveBeenCalled()
  })
})
