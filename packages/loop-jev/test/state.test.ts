import { describe, expect, it } from 'vitest'
import { DIRECTORY_REF_CAP, FILE_REF_CAP, normalizeView, VIEW_CAP } from '../src/observations.js'
import {
  ADDED_COUNTERS,
  CHECKPOINT_MAX_BYTES,
  codec,
  encodeState,
  initialState,
  parseJevState,
} from '../src/state.js'
import type { Decision, HistoryEntry, JsonValue, ObservationView } from '../src/types.js'
import { utf8Bytes } from '../src/util.js'

const big = (i: number): HistoryEntry => ({
  phase: 'INSPECT',
  operation: 'read',
  target: `f${i}`,
  status: 'succeeded',
  disposition: 'SUCCEEDED',
  summary: `read(f${i}) conf=0.90`,
  error: {
    code: 'X',
    kind: 'execution',
    stage: 'dispatch',
    recoverability: 'recoverable',
    message: 'm'.repeat(200),
  },
  intentFp: 'a'.repeat(32),
  observationFp: 'b'.repeat(32),
  dispatched: true,
})

describe('checkpoint codec v1', () => {
  it('round-trips the initial state', () => {
    const cp = encodeState(initialState())
    expect(cp.codecVersion).toBe(1)
    expect(parseJevState(codec.decode(cp))).toEqual(initialState())
  })
  it('accepts every loop end reason, so Core can validate the checkpoint of any ending', () => {
    for (const endReason of ['max_steps', 'budget', 'blocked', 'parked', 'interrupted'] as const) {
      const cp = encodeState({ ...initialState(), stage: 'finish', endReason })
      expect(parseJevState(codec.decode(cp)).endReason).toBe(endReason)
    }
  })
  it('rejects other versions and malformed states', () => {
    expect(() => codec.decode({ codecVersion: 2, state: null })).toThrow('expected 1')
    expect(() => parseJevState({ ...initialState(), stage: 'nope' } as never)).toThrow()
    expect(() => parseJevState({ ...initialState(), v: 2 } as never)).toThrow()
  })
  it('stays within 32 KiB: prior history first, then the previous answer, then the goal', () => {
    const s = initialState()
    s.workspace.history = Array.from({ length: 60 }, (_, i) => big(i))
    s.workspace.turnStart = 40
    s.workspace.previousAnswer = 'p'.repeat(4000)
    s.workspace.goal = '目'.repeat(20000)
    const cp = encodeState(s)
    expect(Buffer.byteLength(JSON.stringify(cp.state))).toBeLessThanOrEqual(CHECKPOINT_MAX_BYTES)
    const out = parseJevState(cp.state)
    expect(out.workspace.history.length).toBeLessThan(60)
    expect(out.workspace.history.at(-1)?.target).toBe('f59')
    expect(out.workspace.goal.length).toBeLessThanOrEqual(4003)
    expect(s.workspace.history).toHaveLength(60)
    expect(out.workspace.turnStart).toBe(out.workspace.history.length - 20)
    expect(out.workspace.previousAnswer).toBe('p'.repeat(1000))
  })
  it('leaves a state under 32 KiB untouched', () => {
    const s = initialState()
    s.workspace.history = Array.from({ length: 5 }, (_, i) => big(i))
    s.workspace.turnStart = 3
    s.workspace.previousAnswer = 'p'.repeat(4000)
    s.workspace.goal = 'g'.repeat(6000)
    expect(parseJevState(encodeState(s).state)).toEqual(s)
  })
  it('strips excerpts but keeps every current-turn entry when still oversize', () => {
    const s = initialState()
    s.workspace.history = Array.from({ length: 40 }, (_, i) => ({
      ...big(i),
      command_excerpt: 'c'.repeat(300),
      output_excerpt: 'o'.repeat(500),
    }))
    const cp = encodeState(s)
    const out = parseJevState(cp.state)
    expect(out.workspace.history).toHaveLength(40)
    out.workspace.history.forEach((entry, i) => {
      const last = i === 39
      expect(entry.command_excerpt).toBe(last ? 'c'.repeat(300) : undefined)
      expect(entry.output_excerpt).toBe(last ? 'o'.repeat(500) : undefined)
      expect({ ...entry, command_excerpt: undefined, output_excerpt: undefined }).toEqual({
        ...big(i),
        command_excerpt: undefined,
        output_excerpt: undefined,
      })
    })
    expect(parseJevState(encodeState(parseJevState(cp.state)).state)).toEqual(out)
  })
  it('keeps an oversize result valid instead of throwing', () => {
    const s = initialState()
    s.workspace.answer = 'a'.repeat(50000)
    const cp = encodeState(s)
    expect(Buffer.byteLength(JSON.stringify(cp.state))).toBeGreaterThan(CHECKPOINT_MAX_BYTES)
    expect(parseJevState(cp.state).workspace.answer).toHaveLength(50000)
  })
  it('rejects unknown keys at the top level and in cur, with unprefixed paths', () => {
    expect(() => parseJevState({ ...initialState(), extra: 1 } as never)).toThrow('extra')
    const s = initialState()
    expect(() => parseJevState({ ...s, cur: { ...s.cur, extra: 1 } } as never)).toThrow('cur.extra')
    expect(() => parseJevState({ ...s, endReason: 'nope' } as never)).toThrow(/at endReason$/)
    expect(() => parseJevState({ ...s, endError: { code: 1 } } as never)).toThrow(/at endError\.code$/)
  })
  it('keeps the counted model attempts of a step, accepts their absence and rejects unknown keys', () => {
    const s = initialState()
    s.stage = 'llm'
    s.cur = { jevAttempts: [], level: 0, llm: { kind: 'answer', attempt: 2, counted: 2 } }
    expect(parseJevState(codec.decode(codec.encode(s as never)))).toEqual(s)
    s.cur.llm = { kind: 'answer', attempt: 2 }
    expect(parseJevState(codec.decode(codec.encode(s as never)))).toEqual(s)
    const odd = structuredClone(s) as never as { cur: { llm: Record<string, unknown> } }
    odd.cur.llm.extra = 1
    expect(() => parseJevState(odd as never)).toThrow('cur.llm')
    odd.cur.llm = { kind: 'answer', attempt: 2, counted: -1 }
    expect(() => parseJevState(odd as never)).toThrow('cur.llm.counted')
  })
  it('round-trips a populated mid-step state and rejects incomplete calls', () => {
    const s = initialState()
    s.stage = 'dispatch'
    s.idTurn = 3
    s.coreTurn = 7
    s.step = 4
    s.cur = {
      jevAttempts: ['jev:3:4:d0'],
      level: 2,
      decision: {
        phase: 'ACT',
        op: 'edit',
        target: 'a.ts',
        bindingMode: 'llm_parameters',
        args: { path: 'a.ts' },
        confidence: 0.8,
        operationPathConfidence: 0.8,
        targetConfidence: null,
        ambiguity: 0.1,
        progress: null,
        phaseTop: [['ACT', 0.9]],
        actionTop: [['edit', 0.8]],
        consumed: [{ role: 'phase', head: 'h', selected: 'ACT', confidence: 0.9, deterministic: false }],
      },
      route: { kind: 'parameters', reason: null },
      llm: { kind: 'parameters', attempt: 1, note: 'n' },
      calls: [{ invocationId: 'jev:3:4:t0', name: 'edit', args: { path: 'a.ts' }, announce: 'true' }],
    }
    s.workspace.history = [big(0)]
    s.endReason = 'error'
    s.endError = { code: 'X', message: 'm' }
    expect(parseJevState(codec.decode(codec.encode(s as never)))).toEqual(s)
    const broken = structuredClone(s) as never as { cur: { calls: Array<Record<string, unknown>> } }
    delete broken.cur.calls[0]?.name
    expect(() => parseJevState(broken as never)).toThrow('cur.calls[0].name')
  })
})

/** A checkpoint as written before observation views, batch decisions and the newer counters existed. */
const OLD_CHECKPOINT: JsonValue = {
  v: 1,
  idTurn: 2,
  coreTurn: 5,
  stage: 'llm',
  step: 3,
  toolNames: ['edit', 'find', 'grep', 'ls', 'read', 'shell', 'tool_describe', 'tool_search', 'write'],
  toolNamesChanges: 0,
  cur: {
    jevAttempts: ['jev:2:3:d0'],
    level: 1,
    decision: {
      phase: 'INSPECT',
      op: 'read',
      target: 'LLM_PARAMETERS',
      bindingMode: 'llm_parameters',
      args: {},
      confidence: 0.62,
      operationPathConfidence: 0.81,
      targetConfidence: 0.62,
      ambiguity: 0.2,
      progress: null,
      phaseTop: [
        ['INSPECT', 0.81],
        ['ACT', 0.12],
      ],
      actionTop: [['read', 0.9]],
      consumed: [
        { role: 'phase', head: 'phase', selected: 'INSPECT', confidence: 0.81, deterministic: false },
        { role: 'action', head: 'action__inspect', selected: 'read', confidence: 0.9, deterministic: false },
        {
          role: 'target',
          head: 'target__inspect__read',
          selected: 'LLM_PARAMETERS',
          confidence: 0.62,
          deterministic: false,
        },
      ],
    },
    route: { kind: 'parameters', reason: null },
    llm: { kind: 'parameters', attempt: 2, note: 'the previous reply named no tool', counted: 1 },
  },
  pendingNotes: [],
  workspace: {
    goal: 'summarize the notes',
    previousAnswer: 'There are two notes.',
    answer: '',
    notes: [{ kind: 'file', target: 'notes.txt', text: '[file: notes.txt]\n1  first note' }],
    history: [
      {
        phase: 'INSPECT',
        operation: 'ls',
        target: '.',
        status: 'succeeded',
        disposition: 'SUCCEEDED',
        summary: 'ls(.) conf=0.90',
        output_excerpt: 'notes.txt',
        intentFp: '0123456789abcdef0123456789abcdef',
        observationFp: 'fedcba9876543210fedcba9876543210',
        dispatched: true,
      },
      {
        phase: 'INSPECT',
        operation: 'read',
        target: 'notes.txt',
        status: 'succeeded',
        disposition: 'SUCCEEDED',
        summary: 'read(notes.txt) conf=n/a [escalated]',
        read_files: ['notes.txt'],
        output_excerpt: '1  first note',
        intentFp: '00112233445566778899aabbccddeeff',
        observationFp: 'ffeeddccbbaa99887766554433221100',
        dispatched: true,
      },
    ],
    turnStart: 1,
  },
  counters: {
    jevCalls: 3,
    jevRetries: 0,
    decisionFailures: { MODEL_UNAVAILABLE: 0, INVALID_PROPOSAL: 0 },
    llm: { parameters: 1, arbitration: 0, answer: 0, retries: 0 },
    directSteps: 1,
    directSuccess: 1,
    arbitrationAgreed: 0,
    arbitrationOverturned: 0,
    droppedCalls: 0,
    answerDeclined: 0,
    noCall: 1,
    emitted: 4,
    droppedEvents: 0,
  },
  internalErrors: 0,
}
/** A state with the shape checks turned off, to build malformed checkpoints. */
type Loose = {
  workspace: { views?: unknown[] }
  cur: { decision?: unknown }
  counters: Record<string, unknown>
}
const view = (): ObservationView => ({
  id: '0123456789abcdef',
  kind: 'ls',
  scope: '.',
  source: { operation: 'ls', call_id: 'jev:1:0:t0' },
  trust: 'untrusted_evidence',
  historical: true,
  evidence: 'a.md',
  references: [{ kind: 'file', value: 'a.md' }],
  truncated: false,
  invocation: { path: '.' },
})
const decisionOf = (): Decision => ({
  phase: 'INSPECT',
  op: 'read',
  target: ['a.md', 'b.md'],
  bindingMode: 'observed',
  args: { path: 'a.md', offset: 1, limit: 200 },
  batch: [
    { path: 'a.md', offset: 1, limit: 200 },
    { path: 'b.md', offset: 1, limit: 200 },
  ],
  confidence: 0.7,
  operationPathConfidence: 0.9,
  targetConfidence: 0.7,
  ambiguity: null,
  progress: null,
  phaseTop: [['INSPECT', 0.9]],
  actionTop: [['read', 0.9]],
  consumed: [
    {
      role: 'target_mode',
      head: 'target_mode__inspect__read',
      selected: 'many',
      confidence: 0.8,
      deterministic: false,
    },
    {
      role: 'target_member',
      head: 'include__inspect__read__0',
      selected: 'include',
      confidence: 0.7,
      deterministic: false,
    },
  ],
})

describe('checkpoints with observations', () => {
  it('reads a checkpoint written before observation views and the new counters existed', () => {
    const decoded = parseJevState(codec.decode({ codecVersion: 1, state: OLD_CHECKPOINT }) as never)
    expect(decoded.workspace.views).toEqual([])
    for (const key of ADDED_COUNTERS) expect(decoded.counters[key]).toBe(0)
    const old = structuredClone(OLD_CHECKPOINT) as unknown as Loose & { workspace: object }
    expect(decoded).toEqual({
      ...old,
      workspace: { ...old.workspace, views: [] },
      counters: { ...old.counters, ...Object.fromEntries(ADDED_COUNTERS.map((key) => [key, 0])) },
    })
    const again = codec.encode(decoded as never)
    expect(again.codecVersion).toBe(1)
    expect(parseJevState(codec.decode(again) as never)).toEqual(decoded)
  })
  // A canary: a realistic worst case that fits with under 1 KiB to spare, so a new per-entry field
  // or a larger view bound fails here first and the shrink order must be revisited.
  it('stays within the checkpoint size with four full views and a 30-step turn', () => {
    const s = initialState()
    s.workspace.goal = '目标'.repeat(2000)
    for (let i = 0; i < 4; i++)
      s.workspace.views.push(
        normalizeView({
          operation: 'read',
          callId: `c${i}`,
          scope: `f${i}.ts`,
          evidence: '证'.repeat(5000),
          references: [{ kind: 'file', value: `f${i}.ts` }],
          truncated: false,
        }),
      )
    for (let i = 0; i < 30; i++)
      s.workspace.history.push({
        phase: 'INSPECT',
        operation: 'read',
        target: `f${i}.ts`,
        status: 'succeeded',
        disposition: 'SUCCEEDED',
        summary: `read(f${i}.ts) conf=0.90`,
        intentFp: 'a'.repeat(32),
        observationFp: 'b'.repeat(32),
        dispatched: true,
        read_files: [`f${i}.ts`],
        output_excerpt: 'o'.repeat(500),
      })
    expect(utf8Bytes(JSON.stringify(encodeState(s).state))).toBeLessThanOrEqual(32768)
  })
  it('halves view evidence once, before cutting the previous answer or the goal', () => {
    const s = initialState()
    s.workspace.goal = 'g'.repeat(12000)
    s.workspace.previousAnswer = 'p'.repeat(4000)
    for (let i = 0; i < 4; i++)
      s.workspace.views.push(
        normalizeView({
          operation: 'read',
          callId: `c${i}`,
          scope: `f${i}.ts`,
          evidence: '证'.repeat(1599),
          references: [],
          truncated: false,
        }),
      )
    expect(utf8Bytes(JSON.stringify(s))).toBeGreaterThan(CHECKPOINT_MAX_BYTES)
    const out = encodeState(s).state as unknown as typeof s
    expect(out.workspace.views.map((v) => [v.evidence.length, v.truncated])).toEqual(
      Array.from({ length: 4 }, () => [800, true]),
    )
    expect(out.workspace.previousAnswer).toHaveLength(4000)
    expect(out.workspace.goal).toHaveLength(12000)
    expect(s.workspace.views.map((v) => [v.evidence.length, v.truncated])).toEqual(
      Array.from({ length: 4 }, () => [1599, false]),
    )
  })
  it('drops prior-turn history before it halves view evidence', () => {
    const s = initialState()
    for (let i = 0; i < 60; i++) s.workspace.history.push(big(i))
    s.workspace.turnStart = 60
    for (let i = 0; i < 4; i++)
      s.workspace.views.push(
        normalizeView({
          operation: 'read',
          callId: `c${i}`,
          scope: `f${i}.ts`,
          evidence: '证'.repeat(1600),
          references: [],
          truncated: false,
        }),
      )
    expect(utf8Bytes(JSON.stringify(s))).toBeGreaterThan(CHECKPOINT_MAX_BYTES)
    const out = encodeState(s).state as unknown as typeof s
    expect(out.workspace.history.length).toBeLessThan(60)
    expect(out.workspace.history.length).toBe(out.workspace.turnStart)
    expect(out.workspace.views.map((v) => [v.evidence.length, v.truncated])).toEqual(
      Array.from({ length: 4 }, () => [1600, false]),
    )
  })
  it('round-trips a view, a batch decision and the new consumed roles', () => {
    const s = initialState()
    s.workspace.views = [view()]
    s.cur.decision = decisionOf()
    const back = parseJevState(codec.decode(encodeState(s)) as never)
    expect(back.workspace.views).toEqual(s.workspace.views)
    expect(back.cur.decision).toEqual(s.cur.decision)
  })
  it.each([
    [
      'a view with an unknown key',
      (s: Loose) => {
        s.workspace.views = [{ ...view(), extra: 1 }]
      },
    ],
    [
      'a view reference of another kind',
      (s: Loose) => {
        s.workspace.views = [{ ...view(), references: [{ kind: 'symlink', value: 'x' }] }]
      },
    ],
    [
      'more views than the window holds',
      (s: Loose) => {
        s.workspace.views = Array.from({ length: VIEW_CAP + 1 }, (_, i) => ({ ...view(), id: `v${i}` }))
      },
    ],
    [
      'a view with more file references than its cap',
      (s: Loose) => {
        const references = Array.from({ length: FILE_REF_CAP + 1 }, (_, i) => ({
          kind: 'file',
          value: `f${i}`,
        }))
        s.workspace.views = [{ ...view(), references }]
      },
    ],
    [
      'a view with more directory references than its cap',
      (s: Loose) => {
        const references = Array.from({ length: DIRECTORY_REF_CAP + 1 }, (_, i) => ({
          kind: 'directory',
          value: `d${i}`,
        }))
        s.workspace.views = [{ ...view(), references }]
      },
    ],
    [
      'a batch that is not a list of objects',
      (s: Loose) => {
        s.cur.decision = { ...decisionOf(), batch: ['x'] }
      },
    ],
    [
      'a batch next to a single target',
      (s: Loose) => {
        s.cur.decision = { ...decisionOf(), target: 'a.md' }
      },
    ],
    [
      'a batch next to a string target as long as the batch',
      (s: Loose) => {
        s.cur.decision = { ...decisionOf(), target: 'ab' }
      },
    ],
    [
      'a batch shorter than a three-item target list',
      (s: Loose) => {
        s.cur.decision = { ...decisionOf(), target: ['a.md', 'b.md', 'c.md'] }
      },
    ],
    [
      'a batch whose length differs from the target list',
      (s: Loose) => {
        s.cur.decision = { ...decisionOf(), batch: [{ path: 'a.md' }] }
      },
    ],
    [
      'a batch of more than four calls',
      (s: Loose) => {
        const keys = ['a', 'b', 'c', 'd', 'e']
        s.cur.decision = { ...decisionOf(), target: keys, batch: keys.map((path) => ({ path })) }
      },
    ],
  ])('rejects %s', (_name, mutate) => {
    const s = structuredClone(initialState()) as unknown as Loose
    mutate(s)
    expect(() => parseJevState(s as never)).toThrow(/Invalid Jev loop checkpoint/)
  })
})
