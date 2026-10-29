import type { Event } from '@agnes/core-common/types'
import type { SessionDeliverableSource as DeliverableSource, UITurn } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import type { ScanQuery } from '../src/log/storage.js'
import { projectDeliverableSources } from '../src/project/deliverables.js'
import { projectUI } from '../src/project/ui.js'

type Row = [type: string, data: Event['data'], extra?: Partial<Event>]

function ledger(rows: Row[]): Event[] {
  return rows.map(([type, data, extra], index) => ({
    seq: index + 1,
    ts: new Date(Date.UTC(2026, 9, 21, 0, 0, index + 1)).toISOString(),
    id: `01K0000000000000000000${String(index + 1).padStart(4, '0')}`,
    type,
    data,
    actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
    origin: 'system',
    trust: 'trusted',
    ...extra,
  }))
}

/** A storage double with the adapters' filter semantics that records every row it hands out. */
function store(events: Event[]) {
  const read: Event[] = []
  const queries: ScanQuery[] = []
  const scan = async (q: ScanQuery): Promise<Event[]> => {
    queries.push(q)
    const types = q.type === undefined ? undefined : new Set([q.type].flat())
    let rows = events.filter(
      (e) =>
        (q.fromSeq === undefined || e.seq >= q.fromSeq) &&
        (q.toSeq === undefined || e.seq <= q.toSeq) &&
        (!types || types.has(e.type)) &&
        (q.lane === undefined || (e.lane ?? 'main') === q.lane),
    )
    if (q.order === 'desc') rows = rows.reverse()
    rows = rows.slice(0, q.limit ?? rows.length)
    read.push(...rows)
    return structuredClone(rows)
  }
  return { scan, read, queries }
}

const call = (toolUseId: string, name = 'present'): Row => [
  'tool/call',
  { toolUseId, name, args: { files: [{ path: `${toolUseId}.md` }] }, ordinal: 0 },
]
const result = (
  toolUseId: string,
  structured?: DeliverableSource['structured'],
  extra: Partial<Event> = {},
): Row => [
  'tool/result',
  {
    toolUseId,
    content: [{ type: 'text', text: `Presented ${toolUseId}` }],
    ...(structured === undefined ? {} : { structured }),
    isError: false,
    enforcement: { level: 'full', scope: [] },
    authz: { decisionId: `d-${toolUseId}` },
  },
  extra,
]
const delivered = (toolUseId: string) => ({
  deliverables: [
    {
      name: `${toolUseId}.md`,
      description: '',
      ref: {
        uri: `artifact://sha256/${'a'.repeat(64)}`,
        sha256: 'a'.repeat(64),
        size: 1,
        mime: 'text/markdown',
      },
    },
  ],
  laneId: 'main',
  owner: 'agnes/deliverables',
  surfaceId: `card-${toolUseId}`,
})
const turnStart = (turn: number, extra: Record<string, unknown> = {}): Row => [
  'turn/start',
  { turn, trigger: 'prompt', ...extra },
]
const turnEnd = (reason = 'completed'): Row => ['turn/end', { reason, lastAssistantSeq: null }]

/** What the Web derives today: the full UI projection, each present node's durable result, its turn by seq. */
async function fromProjection(events: Event[]): Promise<DeliverableSource[]> {
  const timeline = await projectUI(events, { sessionKey: 'k', lane: 'main' })
  const turnOf = (turns: readonly UITurn[], seq: number) =>
    turns.find((turn) => seq >= turn.startSeq && (turn.endSeq === undefined || seq <= turn.endSeq))?.id
  return timeline.nodes.flatMap((node) => {
    if (node.kind !== 'tool' || node.name !== 'present' || !node.resultSeq) return []
    // The raw row, exactly as a tool-detail read returns it.
    const row = events.find((event) => event.seq === node.resultSeq)?.data as Pick<
      DeliverableSource,
      'structured'
    >
    const turnId = turnOf(timeline.turns, node.seq)
    return [
      {
        callSeq: node.seq,
        resultSeq: node.resultSeq,
        toolUseId: node.toolUseId,
        ...(turnId ? { turnId } : {}),
        ...('structured' in row ? { structured: row.structured } : {}),
      },
    ]
  })
}

const byCall = (sources: readonly DeliverableSource[]) => [...sources].sort((a, b) => a.callSeq - b.callSeq)

const scenarios: Record<string, Row[]> = {
  'plain turns with pending, bare and surface-only results': [
    ['user/message', { content: [{ type: 'text', text: 'go' }] }],
    turnStart(1),
    call('a'),
    call('read-1', 'read'),
    result('read-1', { lines: 3 }),
    result('a', delivered('a')),
    turnEnd(),
    turnStart(2),
    call('pending'),
    call('bare'),
    result('bare'),
    call('surface-only'),
    // Older results kept display metadata only in the durable UI surface.
    result('surface-only', { surfaceId: 'card-legacy' }),
    call('null'),
    result('null', null),
    turnEnd(),
  ],
  'parallel results arrive out of call order': [
    turnStart(1),
    call('first'),
    call('second'),
    result('second', delivered('second')),
    result('first', delivered('first')),
    turnEnd(),
  ],
  'an approval continuation reopens the parked turn': [
    turnStart(1),
    call('parked'),
    turnEnd('parked'),
    turnStart(2, { trigger: 'approval-resume', continues: { turn: 1, step: 1, toolUseId: 'parked' } }),
    result('parked', delivered('parked')),
    call('after'),
    result('after', delivered('after')),
    turnEnd(),
    turnStart(3),
    call('third'),
    result('third', delivered('third')),
    turnEnd(),
  ],
  'a fork keeps the inherited turns and numbers its own after them': [
    ['session/start', { profile: 'p' }],
    turnStart(1),
    call('inherited'),
    result('inherited', delivered('inherited')),
    turnEnd(),
    ['session/start', { profile: 'p', parent: { key: 'parent', boundarySeq: 5 } }],
    turnStart(2),
    call('own'),
    result('own', delivered('own')),
    turnEnd(),
  ],
  'other lanes, reused tool ids, summaries and orphans stay outside': [
    turnStart(1),
    call('x'),
    result('x', delivered('x')),
    // Same id on another lane: the projection never sees it.
    ['turn/start', { turn: 1, trigger: 'prompt' }, { lane: 'side' }],
    ['tool/call', { toolUseId: 'side', name: 'present', args: {}, ordinal: 0 }, { lane: 'side' }],
    result('side', delivered('side'), { lane: 'side' }),
    result('x', { from: 'side lane' }, { lane: 'side' }),
    ['turn/end', { reason: 'completed', lastAssistantSeq: null }, { lane: 'side' }],
    // A summary row is a compaction node, not a later result.
    result('x', { from: 'summary' }, { surfaceOp: { op: 'replace', start: 1, end: 2 } }),
    // A later call reusing the id takes every result after it.
    call('x', 'read'),
    result('x', { from: 'read' }),
    call('x'),
    result('x', delivered('x')),
    result('no-call', delivered('no-call')),
    // A second result for the same call replaces the first.
    call('twice'),
    result('twice', { attempt: 1 }),
    result('twice', { attempt: 2 }),
    turnEnd(),
  ],
}

// A reopened turn's seq range then spans the turn run in between, so the turn of a call there depends
// on how far the ledger is read: this one is compared at the head only.
const interleaved: Row[] = [
  turnStart(1),
  call('parked'),
  turnEnd('parked'),
  turnStart(2),
  call('between'),
  result('between', delivered('between')),
  turnEnd(),
  turnStart(3, { trigger: 'approval-resume', continues: { turn: 1, step: 1, toolUseId: 'parked' } }),
  result('parked', delivered('parked')),
  turnEnd(),
]

describe('present sources from typed ledger reads', () => {
  it.each(
    Object.entries({ ...scenarios, 'a turn runs between a parked turn and its continuation': interleaved }),
  )('%s: equal to the UI projection path', async (_name, rows) => {
    const events = ledger(rows)
    const expected = await fromProjection(events)
    expect(expected.length).toBeGreaterThan(0)
    const got = await projectDeliverableSources(store(events).scan, {
      lane: 'main',
      afterSeq: 0,
      toSeq: events.length,
    })
    expect(got.map((source) => source.resultSeq)).toEqual(
      [...got.map((source) => source.resultSeq)].sort((a, b) => a - b),
    )
    expect(byCall(got)).toStrictEqual(byCall(expected))
  })

  it.each(Object.entries(scenarios))(
    '%s: any incremental split merges to the full read',
    async (_name, rows) => {
      const events = ledger(rows)
      const full = byCall(
        await projectDeliverableSources(store(events).scan, {
          lane: 'main',
          afterSeq: 0,
          toSeq: events.length,
        }),
      )
      for (let cut = 0; cut <= events.length; cut++) {
        const ledgerAt = store(events)
        const merged = new Map<number, DeliverableSource>()
        for (const source of await projectDeliverableSources(ledgerAt.scan, {
          lane: 'main',
          afterSeq: 0,
          toSeq: cut,
        }))
          merged.set(source.callSeq, source)
        const later = await projectDeliverableSources(ledgerAt.scan, {
          lane: 'main',
          afterSeq: cut,
          toSeq: events.length,
        })
        expect(later.every((source) => source.resultSeq > cut)).toBe(true)
        for (const source of later) merged.set(source.callSeq, source)
        expect(byCall([...merged.values()]), `split at ${cut}`).toStrictEqual(full)
      }
    },
  )

  it.each(Object.entries(scenarios))('%s: bounded pages merge by callSeq', async (_name, rows) => {
    const events = ledger(rows)
    const expected = byCall(await fromProjection(events))
    for (const limit of [1, 2, 3]) {
      const merged = new Map<number, DeliverableSource>()
      let afterSeq = 0
      while (afterSeq < events.length) {
        const page = await projectDeliverableSources(
          store(events).scan,
          { lane: 'main', afterSeq, toSeq: events.length },
          { limit, fits: () => true },
        )
        expect(page.upto).toBeGreaterThan(afterSeq)
        expect(page.items.length).toBeLessThanOrEqual(limit)
        expect(page.items.every((item) => item.resultSeq > afterSeq && item.resultSeq <= page.upto)).toBe(
          true,
        )
        const atCut = (await fromProjection(events.slice(0, page.upto))).filter(
          (item) => item.resultSeq > afterSeq,
        )
        expect(byCall(page.items)).toEqual(byCall(atCut))
        for (const item of page.items) merged.set(item.callSeq, item)
        afterSeq = page.upto
      }
      expect(byCall([...merged.values()])).toEqual(expected)
    }
  })

  it('bounds repeated results even when they all replace a single call', async () => {
    const events = ledger([
      turnStart(1),
      call('repeat'),
      ...Array.from({ length: 8 }, (_, attempt) => result('repeat', { attempt })),
      turnEnd(),
    ])
    const ledgerAt = store(events)
    const page = await projectDeliverableSources(
      ledgerAt.scan,
      { lane: 'main', afterSeq: 0, toSeq: events.length },
      { limit: 2, fits: () => true },
    )
    expect(page.upto).toBe(4)
    expect(page.items).toEqual([
      { callSeq: 2, resultSeq: 4, toolUseId: 'repeat', turnId: 'turn:1', structured: { attempt: 1 } },
    ])
    expect(ledgerAt.read.filter((row) => row.type.startsWith('tool/')).length).toBeLessThanOrEqual(5)
  })

  it('attributes calls at the byte cut, before an interleaved turn is reopened', async () => {
    const events = ledger(interleaved)
    const page = await projectDeliverableSources(
      store(events).scan,
      { lane: 'main', afterSeq: 0, toSeq: events.length },
      { limit: 10, fits: (items) => items.length <= 1 },
    )
    expect(page.upto).toBe(6)
    expect(page.items).toEqual([
      { callSeq: 5, resultSeq: 6, toolUseId: 'between', turnId: 'turn:2', structured: delivered('between') },
    ])
    const continued = await projectDeliverableSources(
      store(events).scan,
      { lane: 'main', afterSeq: page.upto, toSeq: events.length },
      { limit: 1, fits: () => true },
    )
    expect(continued.items[0]).toMatchObject({ callSeq: 2, turnId: 'turn:1' })
  })

  it('restores an earlier result when a byte cut excludes its replacement', async () => {
    const events = ledger([
      turnStart(1),
      call('a'),
      result('a', { note: 'old' }),
      call('b'),
      result('b', { note: 'small' }),
      result('a', { note: 'large' }),
      turnEnd(),
    ])
    const page = await projectDeliverableSources(
      store(events).scan,
      { lane: 'main', afterSeq: 0, toSeq: events.length },
      {
        limit: 10,
        fits: (items) => items.every((item) => (item.structured as { note: string }).note !== 'large'),
      },
    )
    expect(page.upto).toBe(5)
    expect(page.items.map((item) => item.structured)).toEqual([{ note: 'old' }, { note: 'small' }])
    expect(page.items).toEqual(
      await projectDeliverableSources(store(events).scan, { lane: 'main', afterSeq: 0, toSeq: page.upto }),
    )
  })

  it('reads only main-lane tool and turn rows, and no turn rows when nothing was presented', async () => {
    const rows: Row[] = [
      ['user/message', { content: [{ type: 'text', text: 'go' }] }],
      turnStart(1),
      ['step/start', { turn: 1, step: 1 }],
      ['assistant/message', { content: [{ type: 'text', text: 'working' }], stopReason: 'tool_use' }],
      call('a'),
      result('a', delivered('a')),
      ['tool/call', { toolUseId: 'side', name: 'present', args: {}, ordinal: 0 }, { lane: 'side' }],
      ['step/end', { turn: 1, step: 1 }],
      turnEnd(),
    ]
    const events = ledger(rows)
    const ledgerAt = store(events)
    expect(
      await projectDeliverableSources(ledgerAt.scan, { lane: 'main', afterSeq: 0, toSeq: events.length }),
    ).toHaveLength(1)
    expect(new Set(ledgerAt.read.map((row) => row.type))).toEqual(
      new Set(['tool/call', 'tool/result', 'turn/start', 'turn/end']),
    )
    expect(ledgerAt.read.every((row) => (row.lane ?? 'main') === 'main')).toBe(true)
    expect(
      ledgerAt.queries.every((q) => q.type !== undefined && q.lane === 'main' && q.limit !== undefined),
    ).toBe(true)
    // Nothing new: only the tool rows after the cut are read.
    const quiet = store(events)
    expect(
      await projectDeliverableSources(quiet.scan, { lane: 'main', afterSeq: 6, toSeq: events.length }),
    ).toEqual([])
    expect(quiet.read.map((row) => row.seq)).toEqual([])
  })

  it('looks a result up from the call before the cut without rereading earlier results', async () => {
    const rows: Row[] = [
      turnStart(1),
      call('long'),
      call('other', 'read'),
      result('other', { large: 'x'.repeat(1000) }),
      result('long', delivered('long')),
      turnEnd(),
    ]
    const events = ledger(rows)
    const ledgerAt = store(events)
    const got = await projectDeliverableSources(ledgerAt.scan, {
      lane: 'main',
      afterSeq: 4,
      toSeq: events.length,
    })
    expect(got).toEqual([
      { callSeq: 2, resultSeq: 5, toolUseId: 'long', turnId: 'turn:1', structured: delivered('long') },
    ])
    expect(ledgerAt.read.filter((row) => row.type === 'tool/result').map((row) => row.seq)).toEqual([5])
  })
})
