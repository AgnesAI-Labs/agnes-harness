import { describe, expect, it } from 'vitest'
import { checkRelations } from '../src/log/relations.js'
import { ChunkedMap } from '../src/reduce/chunked-map.js'
import { foldEvents, initialState, reduce } from '../src/reduce/reducer.js'
import { effectTree, type LedgerState } from '../src/reduce/state.js'
import { canonicalJson } from '../src/request/hash.js'
import type { Event } from '../src/types.js'
import { encodeLedgerState } from '../testkit/encode-ledger-state.js'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
let seq = 0
const ev = (type: string, data: unknown, extra: Partial<Event> = {}): Event =>
  ({
    seq: ++seq,
    ts: '2026-09-07T00:00:00Z',
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
const opstate = (step: number) => ({
  meta: {
    turn: 1,
    lane: 'main',
    acceptedAt: 't',
    triggerSeq: 1,
    presetName: 'standard',
    profileHash: null,
    depthLimit: 1,
  },
  control: { status: 'running' },
  step,
  latestAssistantSeq: null,
  taint: false,
  phase: { kind: 'checkpoint', continuation: 'need_assistant', triggerSeq: 1 },
})

describe('reducer', () => {
  it('folds registers, tombstones and lastSeq', () => {
    seq = 0
    const s = foldEvents([
      ev('x/core/note', {}, { ignorable: true }),
      ev('plan.items', { items: [{ id: 'a', text: 'do', status: 'todo' }] }, { register: 'plan.items' }),
      ev('artifact/job', { jobId: 'j1', status: 'queued' }, { register: 'artifact/job' }),
      ev(
        'harness/entry',
        { kind: 'memory', id: 'm1', title: 't', content: 'c', scope: 'local', version: 1, source: 'refine' },
        { register: 'harness/entry' },
      ),
      ev('x/core/note', {}, { ignorable: true }),
    ])
    expect(s.lastSeq).toBe(5)
    // The program counter is not a row: an old ledger that holds one does not fold.
    expect(Object.keys(s.registers)).not.toContain('opState')
    seq = 0
    expect(() => foldEvents([ev('op.state', opstate(1), { register: 'op.state' })])).toThrow(
      'E_UNKNOWN_EVENT',
    )
    expect(s.registers.planItems.get('main')?.value.items[0]?.id).toBe('a')
    expect(s.registers.artifactJobs.get('j1')?.seq).toBe(3)
    // The kind/id pair is joined with the same separator the composite cache key uses.
    expect(s.registers.harnessEntries.get('memory\u0000m1')?.value.version).toBe(1)
  })

  it('erases a harness entry through its keyed tombstone', () => {
    seq = 0
    const entry = (extra: Record<string, unknown>) =>
      ev('harness/entry', { kind: 'memory', id: 'm1', ...extra }, { register: 'harness/entry' })
    const live = foldEvents([
      entry({ title: 't', content: 'c', scope: 'local', version: 1, source: 'refine' }),
    ])
    expect(live.registers.harnessEntries.size).toBe(1)
    const gone = foldEvents([
      entry({ title: 't', content: 'c', scope: 'local', version: 1, source: 'refine' }),
      entry({ tombstone: true }),
    ])
    expect(gone.registers.harnessEntries.size).toBe(0)
  })

  it('tracks open turn / step, effects tree, approvals, taint and credits', () => {
    seq = 0
    let s = initialState()
    s = reduce(s, ev('turn/start', { turn: 1, trigger: 'prompt' }))
    s = reduce(s, ev('step/start', { turn: 1, step: 1 }))
    s = reduce(
      s,
      ev('effect/intent', {
        effectId: 'e1',
        kind: 'tool',
        tool: { toolUseId: 't1', name: 'shell' },
        replay: 'never',
        argsSeq: 2,
      }),
    )
    s = reduce(
      s,
      ev('effect/intent', {
        effectId: 'e2',
        parentEffectId: 'e1',
        kind: 'tool',
        tool: { toolUseId: 't2', name: 'read' },
        replay: 'safe',
      }),
    )
    s = reduce(
      s,
      ev('approval/asked', {
        requestId: 'a1',
        kind: 'tool',
        toolUseId: 't1',
        summary: 'rm',
        risk: 'destructive',
        bindingHash: 'h',
      }),
    )
    s = reduce(
      s,
      ev(
        'tool/result',
        {
          toolUseId: 't9',
          content: [],
          isError: false,
          enforcement: { level: 'full', scope: [] },
          authz: { decisionId: 'n/a' },
        },
        { trust: 'untrusted' },
      ),
    )
    s = reduce(
      s,
      ev('cost/ledger', {
        purpose: 'inference',
        effectId: 'x',
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        credits: 2.5,
        creditSource: 'gateway',
        model: 'm',
      }),
    )
    expect(s.openTurn.get('main')).toMatchObject({ turn: 1, startSeq: 1 })
    expect(s.openStep.get('main')).toMatchObject({ turn: 1, step: 1 })
    expect(s.lastTurn.get('main')).toBe(1)
    expect(s.lastStep.get('main')).toBe(1)
    expect([...s.pendingEffects.keys()]).toEqual(['e1', 'e2'])
    expect(s.pendingEffects.get('e1')?.intentSeq).toBe(3)
    expect(s.pendingApprovals.get('a1')?.toolUseId).toBe('t1')
    expect(s.pendingApprovals.get('a1')?.lane).toBe('main')
    expect(s.taint.get('main')).toBe(true)
    expect(s.creditsUsed).toBe(2.5)
    const contextAnchor = s.lastLedgerTokens
    s = reduce(
      s,
      ev('cost/ledger', {
        purpose: 'approval-guardian',
        effectId: 'guardian-1',
        tokens: { input: 1024, output: 0, cacheRead: 0, cacheWrite: 0 },
        credits: 0.25,
        creditSource: 'gateway',
        model: 'guardian-model',
      }),
    )
    expect(s.creditsUsed).toBe(2.75)
    expect(s.lastLedgerTokens).toEqual(contextAnchor)
    s = reduce(
      s,
      ev('cost/ledger', {
        purpose: 'media',
        effectId: 'media-1',
        tokens: { input: 2048, output: 64, cacheRead: 0, cacheWrite: 0 },
        credits: 0.75,
        creditSource: 'gateway',
        model: 'vision-model',
      }),
    )
    expect(s.creditsUsed).toBe(3.5)
    expect(s.lastLedgerTokens).toEqual(contextAnchor)
    s = reduce(s, ev('effect/settled', { effectId: 'e2', outcome: 'ok' }))
    s = reduce(s, ev('approval/decided', { requestId: 'a1', verdict: 'allowed-once', via: 'sync' }))
    s = reduce(s, ev('step/end', { turn: 1, step: 1 }))
    s = reduce(s, ev('turn/end', { reason: 'completed', lastAssistantSeq: null }))
    expect([...s.pendingEffects.keys()]).toEqual(['e1'])
    expect(s.pendingApprovals.size).toBe(0)
    expect(s.decisions.get('a1')?.verdict).toBe('allowed-once')
    expect(s.openTurn.size).toBe(0)
    expect(s.openStep.size).toBe(0)
    // turn/end clears lastStep so the next turn numbers its steps from 1; lastTurn survives it so
    // the next turn is numbered 2.
    expect(s.lastStep.size).toBe(0)
    expect(s.lastTurn.get('main')).toBe(1)
  })

  it('records tool calls against the step they were issued in, and taints only inside a turn', () => {
    seq = 0
    const untrusted = () =>
      ev(
        'tool/result',
        {
          toolUseId: 't1',
          content: [],
          isError: false,
          enforcement: { level: 'full', scope: [] },
          authz: { decisionId: 'n/a' },
        },
        { trust: 'untrusted' },
      )
    const s = foldEvents([
      ev('turn/start', { turn: 1, trigger: 'prompt' }),
      ev('step/start', { turn: 1, step: 1 }),
      ev('tool/call', { toolUseId: 't1', name: 'read', args: {}, ordinal: 0 }),
    ])
    expect(s.toolCalls.get('t1')).toMatchObject({ seq: 3, name: 'read', turn: 1, step: 1, lane: 'main' })
    // An untrusted row outside any open turn taints nothing: there is no turn for it to taint.
    seq = 0
    expect(foldEvents([untrusted()]).taint.get('main')).toBeUndefined()
    // A new turn starts clean even after the previous one was tainted.
    seq = 0
    const cleared = foldEvents([
      ev('turn/start', { turn: 1, trigger: 'prompt' }),
      untrusted(),
      ev('turn/end', { reason: 'completed', lastAssistantSeq: null }),
      ev('turn/start', { turn: 2, trigger: 'prompt' }),
    ])
    expect(cleared.taint.get('main')).toBe(false)
    // Trust is half the rule, and the half a fixture that always passes `trust: 'untrusted'` never
    // exercises: without it every tool result and every user message inside a turn taints the lane,
    // and taint stops meaning "untrusted content reached this turn".
    seq = 0
    const trusted = foldEvents([
      ev('turn/start', { turn: 1, trigger: 'prompt' }),
      ev(
        'tool/result',
        {
          toolUseId: 't1',
          content: [],
          isError: false,
          enforcement: { level: 'full', scope: [] },
          authz: { decisionId: 'n/a' },
        },
        { trust: 'trusted' },
      ),
      ev('user/message', { content: [{ type: 'text', text: 'hi' }] }, { trust: 'trusted' }),
    ])
    expect(trusted.taint.get('main')).toBe(false)
    // The same batch with one untrusted row in it does taint, so the fixture is not simply inert.
    seq = 0
    const mixed = foldEvents([ev('turn/start', { turn: 1, trigger: 'prompt' }), untrusted()])
    expect(mixed.taint.get('main')).toBe(true)
  })

  it('refuses a register payload that is not an object', () => {
    // The five registers without a data schema are cast to a precise type on the way into the fold.
    // A payload that is not even an object makes that cast a lie that surfaces far from the writer:
    // a read of `.items` throws on resume, and a string `version` compares as a string. Refusing it
    // here turns those into one rejection naming the register, the key and the seq. It reaches only
    // register rows; the lifecycle rows are guarded separately, below.
    for (const register of ['plan.items', 'budget.state', 'artifact/job', 'inbox', 'harness/entry']) {
      for (const data of ['nope', 7, true, []]) {
        seq = 0
        expect(() => foldEvents([ev(register, data, { register })]), `${register} ← ${typeof data}`).toThrow(
          `E_ENVELOPE: ${register} data must be an object`,
        )
      }
    }
    // A well-formed object still folds, and a tombstone still erases; neither is caught by the gate.
    seq = 0
    expect(foldEvents([ev('inbox', { items: [] }, { register: 'inbox' })]).registers.inbox.size).toBe(1)
    seq = 0
    expect(
      foldEvents([
        ev('inbox', { items: [] }, { register: 'inbox' }),
        ev('inbox', null, { register: 'inbox' }),
      ]).registers.inbox.size,
    ).toBe(0)
  })

  it('nests pending effects under the parent they were spawned from', () => {
    seq = 0
    const intent = (effectId: string, parentEffectId?: string) =>
      ev('effect/intent', {
        effectId,
        ...(parentEffectId === undefined ? {} : { parentEffectId }),
        kind: 'tool',
        replay: 'safe',
      })
    const s = foldEvents([intent('a'), intent('b', 'a'), intent('c', 'b'), intent('d')])
    const roots = effectTree(s)
    expect(roots.map((n) => n.effectId)).toEqual(['a', 'd'])
    expect(roots[0]?.children.map((n) => n.effectId)).toEqual(['b'])
    expect(roots[0]?.children[0]?.children.map((n) => n.effectId)).toEqual(['c'])
    expect(roots[1]?.children).toEqual([])
    // A child whose parent has settled becomes a root rather than disappearing from the tree.
    const orphaned = foldEvents([
      intent('a'),
      intent('b', 'a'),
      ev('effect/settled', { effectId: 'a', outcome: 'ok' }),
    ])
    expect(effectTree(orphaned).map((n) => n.effectId)).toEqual(['b'])
    // Roots come back in the order their intents were written.
    seq = 0
    expect(effectTree(foldEvents([intent('z'), intent('y')])).map((n) => n.effectId)).toEqual(['z', 'y'])
  })

  it('records one request/sent receipt on its pending inference effect', () => {
    seq = 0
    const rows = [
      ev('turn/start', { turn: 1, trigger: 'prompt' }),
      ev('step/start', { turn: 1, step: 1 }),
      ev('request/header', { model: 'm' }),
      ev('effect/intent', { effectId: 'inf', kind: 'inference', replay: 'never' }),
    ]
    const receipt = ev('request/sent', {}, { sourceEventSeqs: [rows[2]?.seq ?? 0, rows[3]?.seq ?? 0] })
    const state = foldEvents([...rows, receipt])
    expect(state.openTurn.get('main')?.lastHeaderSeq).toBe(rows[2]?.seq)
    expect(state.pendingEffects.get('inf')).toMatchObject({
      lane: 'main',
      intentSeq: rows[3]?.seq,
      receiptSeq: receipt.seq,
    })
    const duplicate = reduce(
      state,
      ev('request/sent', {}, { sourceEventSeqs: [rows[2]?.seq ?? 0, rows[3]?.seq ?? 0] }),
    )
    expect(duplicate.pendingEffects.get('inf')?.receiptSeq).toBe(receipt.seq)
  })

  it('keeps lanes apart', () => {
    seq = 0
    const s = foldEvents([
      ev('turn/start', { turn: 1, trigger: 'prompt' }),
      ev('turn/start', { turn: 1, trigger: 'job' }, { lane: 'side' }),
      ev('step/start', { turn: 1, step: 1 }, { lane: 'side' }),
    ])
    expect([...s.openTurn.keys()]).toEqual(['main', 'side'])
    expect(s.openStep.has('main')).toBe(false)
    expect(s.openStep.get('side')?.step).toBe(1)
  })

  it('rejects a second turn/start on an open lane when rebuilding', () => {
    seq = 0
    expect(() =>
      foldEvents([
        ev('turn/start', { turn: 1, trigger: 'prompt' }),
        ev('turn/start', { turn: 2, trigger: 'prompt' }),
      ]),
    ).toThrow(/E_RELATION/)
  })

  it('stops folding at upto', () => {
    seq = 0
    const events = [
      ev('turn/start', { turn: 1, trigger: 'prompt' }),
      ev('step/start', { turn: 1, step: 1 }),
      ev('step/end', { turn: 1, step: 1 }),
    ]
    expect(foldEvents(events, 2).lastSeq).toBe(2)
    expect(foldEvents(events, 2).openStep.has('main')).toBe(true)
  })

  it('rejects unknown types without ignorable and accepts x/* and ignorable', () => {
    seq = 0
    expect(() => reduce(initialState(), ev('nope/x', {}))).toThrow(/E_UNKNOWN_EVENT/)
    expect(reduce(initialState(), ev('nope/x', {}, { ignorable: true })).lastSeq).toBe(2)
    expect(reduce(initialState(), ev('x/core/invariant', { rule: 'r' })).lastSeq).toBe(3)
  })

  it('returns a new state, never changes the input, and shares every table the row did not write', () => {
    seq = 0
    const s0 = initialState()
    const s1 = reduce(s0, ev('turn/start', { turn: 1, trigger: 'prompt' }))
    expect(s1).not.toBe(s0)
    expect(s0.openTurn.size).toBe(0)
    const before = canonicalJson(encodeLedgerState(s1))
    const s2 = reduce(s1, ev('step/start', { turn: 1, step: 1 }))
    // The earlier state is exactly what it was: a later fold never reaches back into it, which is
    // what makes `upto` snapshots and the relation check's simulation sound.
    expect(canonicalJson(encodeLedgerState(s1))).toBe(before)
    expect(s1.openStep.size).toBe(0)
    // step/start writes the two step tables and nothing else; every other table is shared.
    const tables = (s: LedgerState): [string, unknown][] => [
      ...Object.entries(s.registers).map(([k, v]) => [`registers.${k}`, v] as [string, unknown]),
      ...Object.entries(s)
        .filter(([, v]) => v instanceof Map || v instanceof Set || v instanceof ChunkedMap)
        .map(([k, v]) => [k, v] as [string, unknown]),
    ]
    const was = tables(s1)
    const now = tables(s2)
    expect(was).toHaveLength(15)
    expect(now.map(([n]) => n)).toEqual(was.map(([n]) => n))
    for (const [i, [name, table]] of was.entries()) {
      if (name === 'openStep' || name === 'lastStep') expect(now[i]?.[1], name).not.toBe(table)
      else expect(now[i]?.[1], `${name} is shared`).toBe(table)
    }
    // The two tables that grow for the whole session are chunked from the first state on.
    expect(s0.toolCalls).toBeInstanceOf(ChunkedMap)
    expect(s0.decisions).toBeInstanceOf(ChunkedMap)
  })

  it('a rejected batch leaves no trace in the state it was simulated against', () => {
    // checkRelations simulates a batch on top of the tracker's live state, so an aliased collection
    // is not merely untidy: a batch that is refused still writes into that live state, and a
    // tool/call from a batch nobody committed then satisfies the same-step gate for a later result.
    seq = 0
    const live = foldEvents([
      ev('turn/start', { turn: 1, trigger: 'prompt' }),
      ev('x/core/op-mark', { phase: 'checkpoint' }, { ignorable: true }),
      ev('step/start', { turn: 1, step: 1 }),
    ])
    const doomed = [
      ev('tool/call', { toolUseId: 'ghost', name: 'read', args: {}, ordinal: 0 }),
      ev('effect/intent', { effectId: 'ghost-e', kind: 'job', replay: 'safe' }),
      ev('turn/end', { reason: 'completed', lastAssistantSeq: null }),
    ]
    expect(() => checkRelations(doomed, live)).toThrow('E_RELATION: turn/end with open step')
    expect(live.toolCalls.has('ghost')).toBe(false)
    expect(live.pendingEffects.has('ghost-e')).toBe(false)
    // And the gate the ghost call would have opened stays shut.
    expect(() =>
      checkRelations(
        [
          ev('tool/result', {
            toolUseId: 'ghost',
            content: [],
            isError: false,
            enforcement: { level: 'full', scope: [] },
            authz: { decisionId: 'n/a' },
          }),
        ],
        live,
      ),
    ).toThrow('E_RELATION: tool/result ghost without prior tool/call in this step')
  })

  it('refuses a lifecycle row that does not name the key it is filed under', () => {
    // These four open or close an entry only their counterpart row can clear. Folded with a missing
    // or non-string id they key the map under `undefined`, and nothing in the session can ever
    // reach that entry again: the effect stays pending and the approval stays outstanding forever.
    const cases: [string, string, Record<string, unknown>][] = [
      ['effect/intent', 'effectId', { kind: 'tool', replay: 'safe' }],
      ['effect/settled', 'effectId', { outcome: 'ok' }],
      ['approval/asked', 'requestId', { kind: 'tool', summary: 's', risk: 'always', bindingHash: 'h' }],
      ['approval/decided', 'requestId', { verdict: 'allowed-once', via: 'sync' }],
    ]
    for (const [type, field, rest] of cases)
      for (const bad of [{}, { [field]: undefined }, { [field]: '' }, { [field]: 7 }, 'nope', null, []]) {
        seq = 0
        const data =
          typeof bad === 'object' && bad !== null && !Array.isArray(bad) ? { ...rest, ...bad } : bad
        expect(() => foldEvents([ev(type, data)]), `${type} <- ${JSON.stringify(bad)}`).toThrow(
          `E_ENVELOPE: ${type} data.${field} must be a non-empty string`,
        )
      }
    // The concrete harm, stated once: no phantom root under an absent key.
    seq = 0
    let phantom: unknown
    try {
      foldEvents([ev('effect/intent', { kind: 'tool', replay: 'safe' })])
    } catch {
      phantom = 'refused'
    }
    expect(phantom).toBe('refused')
    // A well-formed pair still opens and closes.
    seq = 0
    const settled = foldEvents([
      ev('effect/intent', { effectId: 'e1', kind: 'tool', replay: 'safe' }),
      ev('effect/settled', { effectId: 'e1', outcome: 'ok' }),
    ])
    expect(settled.pendingEffects.size).toBe(0)
    seq = 0
    const open = foldEvents([ev('effect/intent', { effectId: 'e1', kind: 'tool', replay: 'safe' })])
    expect([...open.pendingEffects.keys()]).toEqual(['e1'])
    seq = 0
    const approved = foldEvents([
      ev('approval/asked', { requestId: 'r1', kind: 'tool', summary: 's', risk: 'always', bindingHash: 'h' }),
      ev('approval/decided', { requestId: 'r1', verdict: 'allowed-once', via: 'sync' }),
    ])
    expect(approved.pendingApprovals.size).toBe(0)
    expect([...approved.decisions.keys()]).toEqual(['r1'])
  })

  it('tracks a media effect as an auxiliary never-replay effect', () => {
    seq = 0
    const state = foldEvents([
      ev('effect/intent', { effectId: 'media-1', kind: 'media', replay: 'never', slot: 'image' }),
    ])
    expect(state.pendingEffects.get('media-1')).toMatchObject({
      effectId: 'media-1',
      kind: 'media',
      replay: 'never',
      slot: 'image',
    })
  })

  it('starts a fork child with no open step, pending effect, pending approval or consumed decision', () => {
    seq = 0
    const start = { resolvedProfileHash: null, preset: 'standard', agnesVersion: '0.0.1' }
    const ask = (requestId: string) =>
      ev('approval/asked', { requestId, kind: 'tool', summary: 's', risk: 'always', bindingHash: 'h' })
    const parent = foldEvents([
      ev('session/start', { key: 'parent', ...start }),
      ev('turn/start', { turn: 1, trigger: 'prompt' }),
      ev('step/start', { turn: 1, step: 1 }),
      ask('r0'),
      ev('approval/decided', { requestId: 'r0', verdict: 'allowed-once', via: 'callback' }),
      ev('step/end', { turn: 1, step: 1 }),
      ev('turn/end', { reason: 'completed', lastAssistantSeq: null }),
      ev('turn/start', {
        turn: 2,
        trigger: 'approval-resume',
        continues: { requestId: 'r0', turn: 1, step: 1, toolUseId: 't0' },
      }),
      ev('step/start', { turn: 2, step: 1 }),
      ev('effect/intent', {
        effectId: 'e1',
        kind: 'tool',
        tool: { toolUseId: 't1', name: 'shell' },
        replay: 'never',
      }),
      ask('r1'),
    ])
    // The boundary falls inside the parent's open step, with every one of these tables holding an entry.
    expect([...parent.openStep.keys()]).toEqual(['main'])
    expect([...parent.pendingEffects.keys()]).toEqual(['e1'])
    expect([...parent.pendingApprovals.keys()]).toEqual(['r1'])
    expect([...parent.resumedRequests]).toEqual(['r0'])
    const child = reduce(
      parent,
      ev('session/start', { key: 'child', parent: { key: 'parent', boundarySeq: parent.lastSeq }, ...start }),
    )
    expect(child.openTurn.size).toBe(0)
    expect(child.openStep.size).toBe(0)
    expect(child.pendingEffects.size).toBe(0)
    expect(child.pendingApprovals.size).toBe(0)
    expect(child.resumedRequests.size).toBe(0)
    expect(child.decisions.size).toBe(0)
    expect(parent.openStep.size).toBe(1)
  })
})
