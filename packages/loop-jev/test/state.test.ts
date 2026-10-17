import { describe, expect, it } from 'vitest'
import {
  ADDED_COUNTERS,
  CHECKPOINT_MAX_BYTES,
  codec,
  encodeState,
  initialState,
  parseJevState,
} from '../src/state.js'
import type { Decision, HistoryEntry, ObservationView } from '../src/types.js'

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
    const old = structuredClone(initialState()) as unknown as Loose
    delete old.workspace.views
    for (const key of ADDED_COUNTERS) delete old.counters[key]
    const state = parseJevState(codec.decode({ codecVersion: 1, state: old as never }) as never)
    expect(state.workspace.views).toEqual([])
    for (const key of ADDED_COUNTERS) expect(state.counters[key]).toBe(0)
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
      'a batch that is not a list of objects',
      (s: Loose) => {
        s.cur.decision = { ...decisionOf(), batch: ['x'] }
      },
    ],
  ])('rejects %s', (_name, mutate) => {
    const s = structuredClone(initialState()) as unknown as Loose
    mutate(s)
    expect(() => parseJevState(s as never)).toThrow(/Invalid Jev loop checkpoint/)
  })
})
