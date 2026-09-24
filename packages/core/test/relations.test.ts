import { describe, expect, it } from 'vitest'
import { checkRelations } from '../src/log/relations.js'
import { SurfaceCache } from '../src/project/surface.js'
import { foldEvents } from '../src/reduce/reducer.js'
import { CoreError, type Event, type PreparedEvent } from '../src/types.js'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
let seq = 0
const ev = (type: string, data: unknown, extra: Partial<Event> = {}): Event =>
  ({
    seq: ++seq,
    ts: 't',
    id: `01J6ZM2Q3R4S5T6V7W8X9Y0Z${String(seq).padStart(2, '0')}`,
    type,
    data,
    actor,
    origin: 'system',
    trust: 'trusted',
    lane: 'main',
    v: 1,
    ...extra,
  }) as Event
// The row a transition with no row of its own writes; the program counter itself is a cell, which
// the batch-end check is handed as the lanes holding one.
const opstate = (extra: Partial<Event> = {}) =>
  ev('x/core/op-mark', { phase: 'checkpoint' }, { ignorable: true, ...extra })
const main = new Set(['main'])
const result = (toolUseId: string, extra: Record<string, unknown> = {}, env: Partial<Event> = {}) =>
  ev(
    'tool/result',
    {
      toolUseId,
      content: [],
      isError: false,
      enforcement: { level: 'full', scope: [] },
      authz: { decisionId: 'n/a' },
      ...extra,
    },
    env,
  )

/** Strips the sequence storage has not assigned yet, which is the shape append hands the check. */
const unnumbered = (e: Event): PreparedEvent => {
  const { seq: _seq, ...rest } = e
  return rest
}

describe('checkRelations', () => {
  it('accepts a well-formed turn batch', () => {
    seq = 0
    const batch = [ev('turn/start', { turn: 1, trigger: 'prompt' }), opstate()]
    expect(() => checkRelations(batch, foldEvents([]))).not.toThrow()
  })

  it('rejects a second turn/start on an open lane and a step outside a turn', () => {
    seq = 0
    const open = foldEvents([ev('turn/start', { turn: 1, trigger: 'prompt' }), opstate()])
    expect(() => checkRelations([ev('turn/start', { turn: 2, trigger: 'prompt' })], open)).toThrow(
      'E_LANE_BUSY: turn already open',
    )
    expect(() => checkRelations([ev('step/start', { turn: 1, step: 1 })], foldEvents([]))).toThrow(
      'E_RELATION: step/start outside an open turn',
    )
    // A lane that is busy is busy on its own lane only.
    seq = 0
    expect(() =>
      checkRelations(
        [ev('turn/start', { turn: 1, trigger: 'job' }, { lane: 'side' }), opstate({ lane: 'side' })],
        open,
      ),
    ).not.toThrow()
  })

  it('reads the in-turn gate on the row own lane, not on any lane', () => {
    // A gate that asked only "is some turn open" admits an execution row on a lane that has none,
    // and nothing downstream catches it: the batch-end rule iterates the lanes appearing in openTurn
    // or op.state, and a lane with neither is in neither set, so it is never looked at at all.
    seq = 0
    const mainOpen = foldEvents([ev('turn/start', { turn: 1, trigger: 'prompt' }), opstate()])
    expect(mainOpen.openTurn.has('side')).toBe(false)
    for (const row of [
      () => ev('step/start', { turn: 1, step: 1 }, { lane: 'side' }),
      () => ev('tool/call', { toolUseId: 't1', name: 'read', args: {}, ordinal: 0 }, { lane: 'side' }),
      () => ev('effect/intent', { effectId: 'e1', kind: 'job', replay: 'safe' }, { lane: 'side' }),
      () => ev('plan.items', { items: [] }, { lane: 'side', register: 'plan.items' }),
    ]) {
      seq = 10
      const e = row()
      expect(() => checkRelations([e], mainOpen), `${e.type} on an idle lane`).toThrow(
        `E_RELATION: ${e.type} outside an open turn`,
      )
    }
    // The same row is admitted once its own lane has a turn open.
    seq = 0
    const bothOpen = foldEvents([
      ev('turn/start', { turn: 1, trigger: 'prompt' }),
      opstate(),
      ev('turn/start', { turn: 1, trigger: 'job' }, { lane: 'side' }),
      opstate({ lane: 'side' }),
    ])
    seq = 10
    expect(() =>
      checkRelations([ev('step/start', { turn: 1, step: 1 }, { lane: 'side' })], bothOpen),
    ).not.toThrow()
  })

  it('binds request/sent to the current header and one pending inference effect', () => {
    seq = 0
    const start = ev('turn/start', { turn: 1, trigger: 'prompt' })
    const op = opstate()
    const step = ev('step/start', { turn: 1, step: 1 })
    const header = ev('request/header', { model: 'm' })
    const intent = ev('effect/intent', { effectId: 'inf', kind: 'inference', replay: 'never' })
    const receipt = ev('request/sent', {}, { sourceEventSeqs: [header.seq, intent.seq] })
    expect(() => checkRelations([start, op, step, header, intent, receipt], foldEvents([]))).not.toThrow()

    const duplicate = ev('request/sent', {}, { sourceEventSeqs: [header.seq, intent.seq] })
    expect(() =>
      checkRelations([start, op, step, header, intent, receipt, duplicate], foldEvents([])),
    ).toThrow('E_RELATION: duplicate request/sent for inference effect')

    seq = 0
    expect(() =>
      checkRelations([ev('request/sent', {}, { sourceEventSeqs: [1, 2] })], foldEvents([])),
    ).toThrow('E_RELATION: request/sent outside an open turn')

    seq = 0
    const noHeader = [
      ev('turn/start', { turn: 1, trigger: 'prompt' }),
      opstate(),
      ev('step/start', { turn: 1, step: 1 }),
      ev('effect/intent', { effectId: 'inf', kind: 'inference', replay: 'never' }),
    ]
    noHeader.push(ev('request/sent', {}, { sourceEventSeqs: [noHeader[2]?.seq ?? 0, noHeader[3]?.seq ?? 0] }))
    expect(() => checkRelations(noHeader, foldEvents([]))).toThrow(
      'E_RELATION: request/sent must source the current header then intent',
    )

    seq = 0
    const noIntent = [
      ev('turn/start', { turn: 1, trigger: 'prompt' }),
      opstate(),
      ev('step/start', { turn: 1, step: 1 }),
      ev('request/header', { model: 'm' }),
      ev('format/deviation', { rule: 'native' }),
    ]
    noIntent.push(ev('request/sent', {}, { sourceEventSeqs: [noIntent[3]?.seq ?? 0, noIntent[4]?.seq ?? 0] }))
    expect(() => checkRelations(noIntent, foldEvents([]))).toThrow(
      'E_RELATION: request/sent without pending inference intent',
    )

    for (const outputType of ['assistant/output', 'assistant/message'] as const) {
      seq = 0
      const late = [
        ev('turn/start', { turn: 1, trigger: 'prompt' }),
        opstate(),
        ev('step/start', { turn: 1, step: 1 }),
        ev('request/header', { model: 'm' }),
        ev('effect/intent', { effectId: 'inf', kind: 'inference', replay: 'never' }),
        outputType === 'assistant/output'
          ? ev('assistant/output', {
              state: 'started',
              effectId: 'inf',
              chars: { text: 1, thinking: 0 },
              estimatedTokens: 1,
            })
          : ev('assistant/message', { content: [], stopReason: 'end_turn', requestSeq: 4 }),
      ]
      late.push(ev('request/sent', {}, { sourceEventSeqs: [late[3]?.seq ?? 0, late[4]?.seq ?? 0] }))
      // Output cannot even start before the receipt now; a message that did is caught at the receipt.
      expect(() => checkRelations(late, foldEvents([])), outputType).toThrow(
        outputType === 'assistant/output'
          ? 'E_RELATION: assistant/output started before the receipt or twice'
          : 'E_RELATION: request/sent after model output',
      )
    }
  })

  it('numbers steps from the last one opened, not from the one still open', () => {
    seq = 0
    // After step/end the open-step map is empty, so a check that read it would expect 1 again and
    // reject every second step of a turn.
    const afterFirstStep = foldEvents([
      ev('turn/start', { turn: 1, trigger: 'prompt' }),
      opstate(),
      ev('step/start', { turn: 1, step: 1 }),
      ev('step/end', { turn: 1, step: 1 }),
    ])
    expect(() => checkRelations([ev('step/start', { turn: 1, step: 2 })], afterFirstStep)).not.toThrow()
    expect(() => checkRelations([ev('step/start', { turn: 1, step: 1 })], afterFirstStep)).toThrow(
      'E_RELATION: step 1 ≠ expected 2',
    )
    expect(() => checkRelations([ev('step/start', { turn: 1, step: 3 })], afterFirstStep)).toThrow(
      'E_RELATION: step 3 ≠ expected 2',
    )
    // A second step/start while one is open is a different rejection from a misnumbered one.
    seq = 0
    const stepOpen = foldEvents([
      ev('turn/start', { turn: 1, trigger: 'prompt' }),
      opstate(),
      ev('step/start', { turn: 1, step: 1 }),
    ])
    expect(() => checkRelations([ev('step/start', { turn: 1, step: 2 })], stepOpen)).toThrow(
      'E_RELATION: step already open',
    )
    // A new turn numbers its steps from 1 again.
    seq = 0
    const closed = foldEvents([
      ev('turn/start', { turn: 1, trigger: 'prompt' }),
      opstate(),
      ev('step/start', { turn: 1, step: 1 }),
      ev('step/end', { turn: 1, step: 1 }),
      ev('turn/end', { reason: 'completed', lastAssistantSeq: null }),
      ev('x/core/note', {}, { ignorable: true }),
    ])
    const nextTurn = [
      ev('turn/start', { turn: 2, trigger: 'prompt' }),
      opstate(),
      ev('step/start', { turn: 2, step: 1 }),
    ]
    expect(() => checkRelations(nextTurn, closed)).not.toThrow()
  })

  it('requires a prior tool/call in the same step unless exempt', () => {
    seq = 0
    const open = foldEvents([
      ev('turn/start', { turn: 1, trigger: 'prompt' }),
      opstate(),
      ev('step/start', { turn: 1, step: 1 }),
      ev('tool/call', { toolUseId: 't1', name: 'read', args: {}, ordinal: 0 }),
    ])
    expect(() => checkRelations([result('t1')], open)).not.toThrow()
    expect(() => checkRelations([result('t2')], open)).toThrow(
      'E_RELATION: tool/result t2 without prior tool/call in this step',
    )
    expect(() =>
      checkRelations(
        [result('t2', { code: 'TOOL_NOT_STARTED', isError: true }, { sourceEventSeqs: [4] })],
        open,
      ),
    ).not.toThrow()
    // The closer exemption needs both halves: the code alone, with nothing to point at, is not one.
    expect(() => checkRelations([result('t2', { code: 'TOOL_NOT_STARTED', isError: true })], open)).toThrow(
      'E_RELATION',
    )
    expect(() =>
      checkRelations([result('t2', { code: 'SOMETHING_ELSE' }, { sourceEventSeqs: [4] })], open),
    ).toThrow('E_RELATION')
    // A call from an earlier step of the same turn does not stand in for this step's.
    seq = 0
    const laterStep = foldEvents([
      ev('turn/start', { turn: 1, trigger: 'prompt' }),
      opstate(),
      ev('step/start', { turn: 1, step: 1 }),
      ev('tool/call', { toolUseId: 't1', name: 'read', args: {}, ordinal: 0 }),
      ev('step/end', { turn: 1, step: 1 }),
      ev('step/start', { turn: 1, step: 2 }),
    ])
    expect(() => checkRelations([result('t1')], laterStep)).toThrow('E_RELATION')
  })

  it('allows approval-resume continuation results pointing at the parked tool/call', () => {
    seq = 0
    const parked = foldEvents([
      ev('turn/start', { turn: 1, trigger: 'prompt' }),
      opstate(),
      ev('step/start', { turn: 1, step: 1 }),
      ev('tool/call', { toolUseId: 't1', name: 'shell', args: {}, ordinal: 0 }),
      ev('turn/end', { reason: 'parked', lastAssistantSeq: null }),
      ev('x/core/note', {}, { ignorable: true }),
    ])
    const cont = [
      ev('turn/start', {
        turn: 2,
        trigger: 'approval-resume',
        continues: { turn: 1, step: 1, toolUseId: 't1' },
      }),
      opstate(),
      ev('step/start', { turn: 2, step: 1 }),
      result('t1', {}, { sourceEventSeqs: [4] }),
    ]
    expect(() => checkRelations(cont, parked)).not.toThrow()
    // The exemption is bounded: it needs the resume trigger and a pointer at the parked call.
    seq = 6
    const wrongTrigger = [
      ev('turn/start', { turn: 2, trigger: 'prompt' }),
      opstate(),
      ev('step/start', { turn: 2, step: 1 }),
      result('t1', {}, { sourceEventSeqs: [4] }),
    ]
    expect(() => checkRelations(wrongTrigger, parked)).toThrow('E_RELATION')
    seq = 6
    const wrongPointer = [
      ev('turn/start', {
        turn: 2,
        trigger: 'approval-resume',
        continues: { turn: 1, step: 1, toolUseId: 't1' },
      }),
      opstate(),
      ev('step/start', { turn: 2, step: 1 }),
      result('t1', {}, { sourceEventSeqs: [99] }),
    ]
    expect(() => checkRelations(wrongPointer, parked)).toThrow('E_RELATION')
  })

  it('turn/end with an open step, and open turn without op.state, are rejected', () => {
    seq = 0
    const open = foldEvents([
      ev('turn/start', { turn: 1, trigger: 'prompt' }),
      opstate(),
      ev('step/start', { turn: 1, step: 1 }),
    ])
    expect(() =>
      checkRelations(
        [ev('turn/end', { reason: 'completed', lastAssistantSeq: null })],
        open,
        undefined,
        main,
      ),
    ).toThrow('E_RELATION: turn/end with open step')
    seq = 0
    const start = [ev('turn/start', { turn: 1, trigger: 'prompt' })]
    expect(() => checkRelations(start, foldEvents([]), undefined, new Set())).toThrow(/op\.state/)
    expect(() => checkRelations(start, foldEvents([]), undefined, main)).not.toThrow()
    // The rule runs in both directions: an op.state cell with no open turn is just as wrong.
    expect(() => checkRelations([], foldEvents([]), undefined, main)).toThrow(/op\.state/)
    // A mark is only ever written inside an open turn.
    seq = 0
    expect(() => checkRelations([opstate()], foldEvents([]), undefined, main)).toThrow(
      'E_RELATION: x/core/op-mark outside an open turn',
    )
    // Closing a turn without retiring its op.state is caught at the end of the batch.
    seq = 0
    const stepClosed = foldEvents([
      ev('turn/start', { turn: 1, trigger: 'prompt' }),
      opstate(),
      ev('step/start', { turn: 1, step: 1 }),
      ev('step/end', { turn: 1, step: 1 }),
    ])
    const end = [ev('turn/end', { reason: 'completed', lastAssistantSeq: null })]
    expect(() => checkRelations(end, stepClosed, undefined, main)).toThrow(/op\.state/)
    expect(() => checkRelations(end, stepClosed, undefined, new Set())).not.toThrow()
    // A mark on another lane is judged against that lane's turn.
    seq = 0
    const sideOpen = foldEvents([ev('turn/start', { turn: 1, trigger: 'job' }, { lane: 'side' })])
    expect(() =>
      checkRelations([opstate({ lane: 'side' })], sideOpen, undefined, new Set(['side'])),
    ).not.toThrow()
  })

  it('numbers an unnumbered batch so a rejection names the row that caused it', () => {
    seq = 0
    // The row is not numbered until storage commits it, so the check numbers it from the state it is
    // checking against; without that the rejection points at nothing the caller can locate.
    const open = foldEvents([ev('turn/start', { turn: 1, trigger: 'prompt' }), opstate()])
    const batch = [
      ev('step/start', { turn: 1, step: 1 }),
      ev('step/end', { turn: 1, step: 1 }),
      ev('step/start', { turn: 1, step: 1 }),
    ].map(unnumbered)
    try {
      checkRelations(batch, open)
      expect.unreachable('a misnumbered step must be rejected')
    } catch (err) {
      expect(err).toBeInstanceOf(CoreError)
      expect((err as CoreError).detail).toEqual({ lane: 'main', seq: 5 })
    }
  })

  it('refuses a replace when there is no surface to judge the range against', () => {
    seq = 0
    const summary = (start: number, end: number) =>
      ev(
        'assistant/message',
        { content: [], stopReason: 'end_turn' },
        { surfaceOp: { op: 'replace', start, end }, sourceEventSeqs: [start, end] },
      )
    const open = foldEvents([ev('turn/start', { turn: 1, trigger: 'prompt' }), opstate()])
    expect(() => checkRelations([summary(1, 2)], open)).toThrow(
      'E_SURFACE_RANGE: no surface cache for lane main to validate a replace',
    )
    // With the lane's surface in hand the range is judged on its merits.
    seq = 0
    const cache = new SurfaceCache('main')
    cache.push([
      ev('user/message', { content: [{ type: 'text', text: 'a' }] }),
      ev('assistant/message', { content: [], stopReason: 'end_turn' }),
    ])
    const surfaces = new Map([['main', cache]])
    seq = 10
    expect(() => checkRelations([summary(1, 2)], open, surfaces)).not.toThrow()
    expect(() => checkRelations([summary(1, 9)], open, surfaces)).toThrow(
      'E_SURFACE_RANGE: replace range is not contiguous on the current surface',
    )
    // The range is judged against the row's own lane. Judging it against some other lane's surface
    // would let a compaction on one lane mask by the coordinates of another.
    seq = 20
    const side = new SurfaceCache('side')
    side.push([
      ev('user/message', { content: [{ type: 'text', text: 'b' }] }, { lane: 'side' }),
      ev('assistant/message', { content: [], stopReason: 'end_turn' }, { lane: 'side' }),
    ])
    const both = new Map([
      ['side', side],
      ['main', cache],
    ])
    seq = 30
    const sideOpen = foldEvents([
      ev('turn/start', { turn: 1, trigger: 'job' }, { lane: 'side' }),
      opstate({ lane: 'side' }),
    ])
    const sideSummary = { ...summary(21, 22), lane: 'side' } as Event
    expect(() => checkRelations([sideSummary], sideOpen, both)).not.toThrow()
    expect(() => checkRelations([{ ...sideSummary, lane: 'main' } as Event], open, both)).toThrow(
      'E_SURFACE_RANGE: replace range is not contiguous on the current surface',
    )
  })

  it('judges a replace by call/result pairing on the surface at append time', () => {
    seq = 0
    const open = foldEvents([ev('turn/start', { turn: 1, trigger: 'prompt' }), opstate()])
    const summary = (seqs: number[]) =>
      ev(
        'assistant/message',
        { content: [], stopReason: 'end_turn' },
        {
          surfaceOp: { op: 'replace', start: seqs[0] as number, end: seqs.at(-1) as number },
          sourceEventSeqs: seqs,
        },
      )
    const userRow = (t: string) => ev('user/message', { content: [{ type: 'text', text: t }] })
    const assistantRow = (t: string) =>
      ev('assistant/message', { content: [{ type: 'text', text: t }], stopReason: 'end_turn' })
    // [u, a, r, a]: a range ending on the batch's last result closes the call.
    seq = 0
    const closed = new SurfaceCache('main')
    closed.push([userRow('u'), assistantRow('a'), result('t1'), assistantRow('a2')])
    seq = 10
    expect(() => checkRelations([summary([1, 2, 3])], open, new Map([['main', closed]]))).not.toThrow()
    // Unparsed shape [u, a, refused, runtime_context, executed]: stopping on the runtime_context user
    // strands the executed result, though neither boundary is a result.
    seq = 0
    const unparsed = new SurfaceCache('main')
    unparsed.push([userRow('u'), assistantRow('a'), result('t1'), userRow('note'), result('t2')])
    seq = 10
    expect(() => checkRelations([summary([1, 2, 3, 4])], open, new Map([['main', unparsed]]))).toThrow(
      'E_SURFACE_RANGE: replace range splits a tool call from its result',
    )
  })

  it('checks a batch whose rows have no seq yet, which is how append calls it', () => {
    seq = 0
    // Rows reach the check before storage has numbered them, so the simulation numbers them from the
    // state it is checking against.
    const open = foldEvents([ev('turn/start', { turn: 1, trigger: 'prompt' }), opstate()])
    const wellFormed = [
      ev('step/start', { turn: 1, step: 1 }),
      ev('step/end', { turn: 1, step: 1 }),
      ev('turn/end', { reason: 'completed', lastAssistantSeq: null }),
      ev('x/core/note', {}, { ignorable: true }),
    ].map(unnumbered)
    expect(() => checkRelations(wellFormed, open)).not.toThrow()
    const badOrder = [
      ev('step/start', { turn: 1, step: 1 }),
      ev('turn/end', { reason: 'completed', lastAssistantSeq: null }),
    ].map(unnumbered)
    expect(() => checkRelations(badOrder, open)).toThrow('E_RELATION: turn/end with open step')
  })
})

describe('assistant/output rows', () => {
  const output = (state: string, effectId = 'inf') =>
    ev('assistant/output', { state, effectId, chars: { text: 1, thinking: 0 }, estimatedTokens: 1 })
  /** A turn with one inference that has its receipt, so its output may start. */
  const received = () => {
    seq = 0
    const rows = [
      ev('turn/start', { turn: 1, trigger: 'prompt' }),
      opstate(),
      ev('step/start', { turn: 1, step: 1 }),
      ev('request/header', { model: 'm' }),
      ev('effect/intent', { effectId: 'inf', kind: 'inference', replay: 'never' }),
    ]
    rows.push(ev('request/sent', {}, { sourceEventSeqs: [rows[3]?.seq ?? 0, rows[4]?.seq ?? 0] }))
    return foldEvents(rows)
  }

  it('accepts a start, counts and a cut, in that order', () => {
    const state = received()
    expect(() =>
      checkRelations([output('started'), output('progress'), output('interrupted')], state),
    ).not.toThrow()
  })

  it('refuses a second start, anything after a cut, and output for an effect not running here', () => {
    const state = received()
    expect(() => checkRelations([output('started'), output('started')], state)).toThrow(
      'E_RELATION: assistant/output started before the receipt or twice',
    )
    expect(() =>
      checkRelations([output('started'), output('interrupted'), output('progress')], state),
    ).toThrow('E_RELATION: assistant/output after the stream was recorded as cut')
    expect(() => checkRelations([output('started', 'other')], state)).toThrow(
      'E_RELATION: assistant/output without pending inference on its lane',
    )
    expect(() => checkRelations([output('started')], foldEvents([]))).toThrow(
      'E_RELATION: assistant/output outside an open turn',
    )
  })

  it('accepts a cut before a start that is still waiting to commit', () => {
    // The abort callback admits the cut against committed state while the start is still queued.
    expect(() => checkRelations([output('interrupted')], received())).not.toThrow()
  })
})
