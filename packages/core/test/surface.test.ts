import { describe, expect, it } from 'vitest'
import { defaultIds } from '../src/ids.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { computeSurface, pairClosed, SurfaceCache, validateReplace } from '../src/project/surface.js'
import { openTracked } from '../src/reduce/tracker.js'
import type { Event, EventInput } from '../src/types.js'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
let seq = 0
const ev = (type: string, data: unknown, extra: Partial<Event> = {}): Event =>
  ({
    seq: ++seq,
    ts: '2026-01-01T00:00:00.000Z',
    id: `01J6ZM2Q3R4S5T6V7W8X9Y0Z${String(seq).padStart(2, '0')}`,
    type,
    data,
    actor,
    origin: 'principal',
    trust: 'trusted',
    lane: 'main',
    v: 1,
    ...extra,
  }) as Event
// Every batch must satisfy the batch-end rule "an open turn on a lane iff an op.state cell on it",
// so a fixture that opens a turn writes this alongside it.
const opstateData = (lane = 'main') => ({
  meta: {
    turn: 1,
    lane,
    acceptedAt: 't',
    triggerSeq: 1,
    presetName: 'standard',
    profileHash: null,
    depthLimit: 1,
  },
  control: { status: 'running' },
  step: 0,
  latestAssistantSeq: null,
  taint: false,
  phase: { kind: 'checkpoint', continuation: 'need_assistant', triggerSeq: 1 },
})

const user = (t: string, extra: Partial<Event> = {}) =>
  ev('user/message', { content: [{ type: 'text', text: t }] }, extra)
const asst = (t: string, extra: Partial<Event> = {}) =>
  ev('assistant/message', { content: [{ type: 'text', text: t }], stopReason: 'end_turn' }, extra)
const res = (id: string, extra: Partial<Event> = {}) =>
  ev(
    'tool/result',
    {
      toolUseId: id,
      content: [],
      isError: false,
      enforcement: { level: 'full', scope: [] },
      authz: { decisionId: 'n/a' },
    },
    extra,
  )

describe('surface', () => {
  it('keeps the three visible types in order and ignores others', () => {
    seq = 0
    const events = [
      user('a'),
      ev('tool/call', { toolUseId: 't', name: 'read', args: {}, ordinal: 0 }),
      res('t'),
      asst('b'),
      ev('cost/ledger', {}),
    ]
    expect(computeSurface(events, {}).map((n) => [n.seq, n.kind])).toEqual([
      [1, 'user'],
      [3, 'tool_result'],
      [4, 'assistant'],
    ])
  })

  it('filters by lane and stops at upto', () => {
    seq = 0
    const events = [user('a'), user('b', { lane: 'side' }), asst('c'), asst('d', { lane: 'side' })]
    expect(computeSurface(events, {}).map((n) => n.seq)).toEqual([1, 3])
    expect(computeSurface(events, { lane: 'side' }).map((n) => n.seq)).toEqual([2, 4])
    expect(computeSurface(events, { upto: 2 }).map((n) => n.seq)).toEqual([1])
  })

  it('replace masks a contiguous range with one summary node and re-masks the previous summary', () => {
    seq = 0
    const events = [user('a'), asst('b'), user('c'), asst('d')]
    const s1 = ev(
      'assistant/message',
      { content: [{ type: 'text', text: 'sum1' }], stopReason: 'end_turn' },
      { surfaceOp: { op: 'replace', start: 1, end: 2 }, sourceEventSeqs: [1, 2] },
    )
    const after1 = computeSurface([...events, s1], {})
    expect(after1.map((n) => [n.seq, n.kind])).toEqual([
      [5, 'summary'],
      [3, 'user'],
      [4, 'assistant'],
    ])
    const s2 = ev(
      'assistant/message',
      { content: [{ type: 'text', text: 'sum2' }], stopReason: 'end_turn' },
      { surfaceOp: { op: 'replace', start: 5, end: 3 }, sourceEventSeqs: [5, 3] },
    )
    const after2 = computeSurface([...events, s1, s2], {})
    expect(after2.map((n) => [n.seq, n.kind])).toEqual([
      [6, 'summary'],
      [4, 'assistant'],
    ])
    expect(after2[0]?.masked).toEqual({ start: 5, end: 3, sourceEventSeqs: [5, 3] })
    // The summary sits where the range sat, not at the end of the surface.
    expect(after1[0]?.seq).toBe(5)
  })

  it('validateReplace rejects non-contiguous ranges, pinned nodes, split tool calls and bad sourceEventSeqs', () => {
    seq = 0
    const events = [user('a'), asst('b'), res('t'), user('c')]
    const surface = computeSurface(events, { pins: new Set([2]) })
    const byId = new Map(events.map((e) => [e.seq, e]))
    expect(() => validateReplace({ start: 1, end: 2 }, [1, 2], surface, byId)).toThrow(
      'E_SURFACE_RANGE: replace range covers a pinned node',
    )
    // Ending on the batch's last result keeps the call and its result on the same side: no orphan.
    expect(() =>
      validateReplace({ start: 1, end: 3 }, [1, 2, 3], computeSurface(events, {}), byId),
    ).not.toThrow()
    // Ending on the calling assistant leaves its result right behind the summary: an orphan.
    expect(() => validateReplace({ start: 1, end: 2 }, [1, 2], computeSurface(events, {}), byId)).toThrow(
      'E_SURFACE_RANGE: replace range splits a tool call from its result',
    )
    expect(() => validateReplace({ start: 1, end: 4 }, [1, 2], computeSurface(events, {}), byId)).toThrow(
      'E_SURFACE_RANGE: sourceEventSeqs must start/end at the range boundaries',
    )
    expect(() => validateReplace({ start: 1, end: 9 }, [1, 9], computeSurface(events, {}), byId)).toThrow(
      'E_SURFACE_RANGE: replace range is not contiguous on the current surface',
    )
    // Reversed boundaries are a range too, and not one that can be masked.
    expect(() => validateReplace({ start: 4, end: 1 }, [4, 1], computeSurface(events, {}), byId)).toThrow(
      'not contiguous',
    )
    // A pin inside the range counts, not only one on a boundary.
    const pinnedMiddle = computeSurface(events, { pins: new Set([3]) })
    expect(() => validateReplace({ start: 1, end: 4 }, [1, 4], pinnedMiddle, byId)).toThrow('pinned')
    // A well-formed range passes.
    seq = 0
    const clean = [user('a'), asst('b'), user('c')]
    expect(() =>
      validateReplace(
        { start: 1, end: 2 },
        [1, 2],
        computeSurface(clean, {}),
        new Map(clean.map((e) => [e.seq, e])),
      ),
    ).not.toThrow()
  })

  describe('replace pairing, judged by surface position', () => {
    const SPLIT = 'E_SURFACE_RANGE: replace range splits a tool call from its result'
    const rc = (t: string) => user(t, { origin: 'system' })
    const judge = (events: Event[], start: number, end: number) => {
      const surface = computeSurface(events, {})
      const i = surface.findIndex((n) => n.seq === start)
      const j = surface.findIndex((n) => n.seq === end)
      const seqs = surface.slice(i, j + 1).map((n) => n.seq)
      return () => validateReplace({ start, end }, seqs, surface, new Map(events.map((e) => [e.seq, e])))
    }

    it('accepts a range that ends on the last result of a batch followed by an assistant', () => {
      seq = 0
      const events = [user('u'), asst('a'), res('t1'), asst('a2')]
      expect(judge(events, 1, 3)).not.toThrow()
      expect(pairClosed(computeSurface(events, {}), 0, 2)).toBe(true)
    })

    it('rejects a range that ends inside a parallel batch', () => {
      seq = 0
      const events = [user('u'), asst('a'), res('t1'), res('t2'), asst('a2')]
      expect(judge(events, 1, 3)).toThrow(SPLIT)
    })

    it('rejects a range that ends on an assistant whose result follows the next user', () => {
      // The next node is not a result, so only the ownership check sees the split.
      seq = 0
      const events = [user('u'), asst('a'), rc('note'), res('t1'), asst('a2')]
      expect(judge(events, 1, 2)).toThrow(SPLIT)
    })

    it('rejects an unparsed-shape range that stops between refused and executed results', () => {
      // [u, a, refused, runtime_context, executed]: stopping on the refused result leaves the
      // executed one behind the summary; stopping on the runtime_context user does the same.
      seq = 0
      const events = [user('u'), asst('a'), res('refused'), rc('note'), res('ran'), asst('a2')]
      expect(judge(events, 1, 3)).toThrow(SPLIT)
      expect(judge(events, 1, 4)).toThrow(SPLIT)
      // Masking only the runtime_context user keeps the ownership sides equal, but the executed
      // result would then sit directly behind the summary.
      expect(judge(events, 4, 4)).toThrow(SPLIT)
      // Taking the executed result along closes the batch.
      expect(judge(events, 1, 5)).not.toThrow()
    })

    it('rejects a range that starts on a result', () => {
      seq = 0
      const events = [user('u'), asst('a'), res('t1'), asst('a2'), user('u2')]
      expect(judge(events, 3, 4)).toThrow(SPLIT)
      expect(pairClosed(computeSurface(events, {}), 2, 3)).toBe(false)
    })

    it('accepts masking a result whose call was already masked, which repairs the orphan', () => {
      seq = 0
      const events = [user('u'), asst('a'), res('t1'), res('t2'), asst('a2'), user('u2')]
      // An earlier replace the old rule could never have written: it strands t2 behind the summary.
      const earlier = ev(
        'assistant/message',
        { content: [{ type: 'text', text: 'sum' }], stopReason: 'end_turn' },
        { surfaceOp: { op: 'replace', start: 1, end: 3 }, sourceEventSeqs: [1, 2, 3] },
      )
      const all = [...events, earlier]
      expect(computeSurface(all, {}).map((n) => n.kind)).toEqual([
        'summary',
        'tool_result',
        'assistant',
        'user',
      ])
      // The stranded result's owner does not resolve: the scan stops at the summary.
      expect(judge(all, earlier.seq, 4)).not.toThrow()
      expect(judge(all, earlier.seq, 5)).not.toThrow()
    })

    it('does not look past a summary for an owner', () => {
      // [u, a, S, r]: the result's real call is masked; the assistant before the summary is not it.
      seq = 0
      const events = [user('u'), asst('a'), user('u2'), asst('b'), res('t1'), asst('c')]
      const earlier = ev(
        'assistant/message',
        { content: [{ type: 'text', text: 'sum' }], stopReason: 'end_turn' },
        { surfaceOp: { op: 'replace', start: 3, end: 4 }, sourceEventSeqs: [3, 4] },
      )
      const surface = computeSurface([...events, earlier], {})
      expect(surface.map((n) => n.kind)).toEqual(['user', 'assistant', 'summary', 'tool_result', 'assistant'])
      // Masking [u, a] would split a from the result if ownership were read across the summary.
      expect(pairClosed(surface, 0, 1)).toBe(true)
    })
  })

  it('SurfaceCache is incremental and bumps replaceGeneration', () => {
    seq = 0
    const c = new SurfaceCache('main')
    c.push([user('a'), asst('b')])
    expect(c.nodes()).toHaveLength(2)
    expect(c.replaceGeneration).toBe(0)
    c.push([
      ev(
        'assistant/message',
        { content: [], stopReason: 'end_turn' },
        { surfaceOp: { op: 'replace', start: 1, end: 2 }, sourceEventSeqs: [1, 2] },
      ),
    ])
    expect(c.nodes().map((n) => n.kind)).toEqual(['summary'])
    expect(c.replaceGeneration).toBe(1)
    // A pin marks the node in place, and the cache serves the boundary events validateReplace reads.
    c.push([user('d')])
    c.pin(4)
    expect(c.nodes().map((n) => [n.seq, n.pinned])).toEqual([
      [3, false],
      [4, true],
    ])
    expect(c.eventsById().get(4)?.type).toBe('user/message')
    // A later append inherits the pin rather than losing it.
    c.push([asst('e')])
    expect(c.nodes().find((n) => n.seq === 4)?.pinned).toBe(true)
    // Rows on another lane are not this surface's.
    c.push([user('f', { lane: 'side' })])
    expect(c.nodes().map((n) => n.seq)).toEqual([3, 4, 5])
  })

  it('counts the masks actually applied, not the replaces attempted', () => {
    // The counter exists so a consumer caching something derived from the surface can tell an append
    // from a rewrite. A replace whose range no longer resolves is tolerated on the fold rather than
    // fatal, and it changes nothing — counting it would invalidate every downstream cache for a
    // rewrite that did not happen. This is reachable only through push: the append path refuses such
    // a range up front, so a rebuild is where an unresolvable one arrives.
    seq = 0
    const c = new SurfaceCache('main')
    c.push([user('a'), asst('b')])
    const before = c.nodes()
    const stale = ev(
      'assistant/message',
      { content: [], stopReason: 'end_turn' },
      { surfaceOp: { op: 'replace', start: 40, end: 41 }, sourceEventSeqs: [40, 41] },
    )
    c.push([stale])
    expect(c.replaceGeneration).toBe(0)
    expect(c.nodes()).toEqual(before)
    // A range that does resolve still counts, so the counter is not simply stuck.
    c.push([
      ev(
        'assistant/message',
        { content: [], stopReason: 'end_turn' },
        { surfaceOp: { op: 'replace', start: 1, end: 2 }, sourceEventSeqs: [1, 2] },
      ),
    ])
    expect(c.replaceGeneration).toBe(1)
  })

  it('a lane registered in the surfaces map is fed and consulted', async () => {
    // openTracked returns the registry, not just the opened lane's cache: a cache built on the side
    // is fed by nothing and read by nothing, so it reports an empty surface while the relation check
    // refuses every replace on that lane. Registering it in the map is what closes that door.
    const storage = new MemoryStorage()
    const noTimers = { setTimeout: () => 0, clearTimeout: () => undefined }
    const sys = { actor, origin: 'system' as const, trust: 'trusted' as const }
    const { log, surface, surfaces } = await openTracked({
      storage,
      key: 'k',
      writerRunId: 'r1',
      ttlMs: 900,
      ids: defaultIds(),
      clock: () => Date.now(),
      timers: noTimers,
    })
    expect(surfaces.get('main')).toBe(surface)
    const side = new SurfaceCache('side')
    surfaces.set('side', side)
    await log.append([
      { ...sys, type: 'turn/start', data: { turn: 1, trigger: 'job' }, lane: 'side' },
      { ...sys, type: 'op.state', register: 'op.state', lane: 'side', data: opstateData('side') },
      { ...sys, type: 'user/message', lane: 'side', data: { content: [{ type: 'text', text: 'a' }] } },
      {
        ...sys,
        type: 'assistant/message',
        lane: 'side',
        data: { content: [{ type: 'text', text: 'b' }], stopReason: 'end_turn' },
      },
    ])
    // Fed: the registered cache saw the batch, and the opened lane's did not take side's rows.
    expect(side.nodes().map((n) => n.seq)).toEqual([3, 4])
    expect(surface.nodes()).toEqual([])
    // Consulted: a replace on `side` is now judged against side's own surface rather than refused
    // for want of one.
    await log.append([
      {
        ...sys,
        type: 'assistant/message',
        lane: 'side',
        data: { content: [{ type: 'text', text: 'sum' }], stopReason: 'end_turn' },
        surfaceOp: { op: 'replace', start: 3, end: 4 },
        sourceEventSeqs: [3, 4],
      },
    ])
    expect(side.nodes().map((n) => [n.seq, n.kind])).toEqual([[5, 'summary']])
    expect(side.replaceGeneration).toBe(1)
    await log.close()
  })

  it('openTracked owns the cache: it replays on open and stays live on append', async () => {
    const storage = new MemoryStorage()
    const noTimers = { setTimeout: () => 0, clearTimeout: () => undefined }
    const common = {
      storage,
      key: 'k',
      ttlMs: 900,
      ids: defaultIds(),
      clock: () => Date.now(),
      timers: noTimers,
    }
    const sys = { actor, origin: 'system' as const, trust: 'trusted' as const }
    const opstate = (): EventInput => ({
      ...sys,
      type: 'op.state',
      register: 'op.state',
      data: opstateData(),
    })
    const first = await openTracked({ ...common, writerRunId: 'r1' })
    await first.log.append([
      { ...sys, type: 'turn/start', data: { turn: 1, trigger: 'prompt' } },
      {
        actor,
        origin: 'principal',
        trust: 'trusted',
        type: 'user/message',
        data: { content: [{ type: 'text', text: 'hi' }] },
      },
      opstate(),
    ])
    // onAppended has already fed it.
    expect(first.surface.nodes().map((n) => n.kind)).toEqual(['user'])
    await first.log.close()
    const again = await openTracked({ ...common, writerRunId: 'r2' })
    // Replayed page by page on reopen.
    expect(again.surface.nodes().map((n) => n.kind)).toEqual(['user'])
    await again.log.close()
  })

  it('append validates a replace against the cache openTracked owns', async () => {
    const storage = new MemoryStorage()
    const noTimers = { setTimeout: () => 0, clearTimeout: () => undefined }
    const sys = { actor, origin: 'system' as const, trust: 'trusted' as const }
    const said = (text: string): EventInput => ({
      actor,
      origin: 'principal',
      trust: 'trusted',
      type: 'user/message',
      data: { content: [{ type: 'text', text }] },
    })
    const opstate = (): EventInput => ({
      ...sys,
      type: 'op.state',
      register: 'op.state',
      data: opstateData(),
    })
    const summary = (text: string, start: number, end: number): EventInput => ({
      ...sys,
      type: 'assistant/message',
      data: { content: [{ type: 'text', text }], stopReason: 'end_turn' },
      surfaceOp: { op: 'replace', start, end },
      sourceEventSeqs: [start, end],
    })
    const { log, surface } = await openTracked({
      storage,
      key: 'k',
      writerRunId: 'r1',
      ttlMs: 900,
      ids: defaultIds(),
      clock: () => Date.now(),
      timers: noTimers,
    })
    await log.append([
      { ...sys, type: 'turn/start', data: { turn: 1, trigger: 'prompt' } },
      opstate(),
      said('one'),
      said('two'),
    ])
    expect(surface.nodes().map((n) => n.seq)).toEqual([3, 4])
    // A range naming rows that are on the surface is accepted and masks them.
    await log.append([summary('sum', 3, 4)])
    expect(surface.nodes().map((n) => [n.seq, n.kind])).toEqual([[5, 'summary']])
    expect(surface.replaceGeneration).toBe(1)
    // A range naming rows that are no longer on the surface is refused, and nothing is written.
    await expect(log.append([summary('again', 3, 4)])).rejects.toThrow(
      'E_SURFACE_RANGE: replace range is not contiguous on the current surface',
    )
    expect(log.lastSeq).toBe(5)
    expect(surface.nodes().map((n) => n.seq)).toEqual([5])
    expect(surface.replaceGeneration).toBe(1)
    await log.close()
  })
})
