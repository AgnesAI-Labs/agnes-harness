import { describe, expect, it } from 'vitest'
import { routeDecision } from '../src/route.js'
import type { Decision, HistoryEntry, JevLoopConfig, ResolvedTool } from '../src/types.js'

const T: JevLoopConfig['thresholds'] = {
  escalate: 0.5,
  externalWriteMin: 0.6,
  ambiguityGate: 0.4,
  answerProgressFloor: null,
}
const tool = (over: Partial<ResolvedTool>): ResolvedTool => ({
  name: 'ls',
  phases: ['INSPECT', 'VERIFY'],
  writeClass: 'read',
  readOnly: true,
  profiled: true,
  criteria: '',
  targetParam: 'path',
  defaults: { path: '.' },
  multiTargetMax: 1,
  bindingDefaults: null,
  referenceKind: null,
  ...over,
})
const LS = tool({})
const WRITE = tool({
  name: 'write',
  phases: ['ACT'],
  writeClass: 'workspace',
  readOnly: false,
  defaults: null,
})
const SHELL = tool({
  name: 'shell',
  phases: ['INSPECT', 'ACT', 'VERIFY'],
  writeClass: 'workspace',
  readOnly: false,
  defaults: null,
})
const EXT = tool({
  name: 'deploy',
  phases: ['ACT'],
  writeClass: 'external',
  readOnly: false,
  profiled: false,
  defaults: null,
})
const d = (over: Partial<Decision>): Decision => ({
  phase: 'INSPECT',
  op: 'ls',
  target: 'DEFAULT_ARGUMENTS',
  bindingMode: 'defaults',
  args: { path: '.' },
  confidence: 0.9,
  operationPathConfidence: 0.9,
  targetConfidence: 0.9,
  ambiguity: null,
  progress: null,
  phaseTop: [],
  actionTop: [],
  consumed: [],
  ...over,
})
const route = (
  decision: Decision,
  t: ResolvedTool | null,
  over: {
    latest?: HistoryEntry | null
    attempts?: boolean
    thresholds?: Partial<JevLoopConfig['thresholds']>
  } = {},
) =>
  routeDecision({
    decision,
    tool: t,
    latest: over.latest ?? null,
    turnHasAttempts: over.attempts ?? false,
    thresholds: { ...T, ...over.thresholds },
  })
const low = { confidence: 0.4, operationPathConfidence: 0.4 }
const latest = (recoverability: 'recoverable' | 'unsafe'): HistoryEntry => ({
  phase: 'INSPECT',
  operation: 'read',
  target: 'a',
  status: 'failed',
  disposition: recoverability === 'unsafe' ? 'UNKNOWN' : 'NOT_APPLIED',
  summary: '',
  error: {
    code: recoverability === 'unsafe' ? 'EFFECT_UNKNOWN' : 'EXECUTION_FAILED',
    kind: 'execution',
    stage: 'dispatch',
    recoverability,
    message: '',
  },
  intentFp: 'i',
  observationFp: 'o',
  dispatched: true,
})

describe('routeDecision', () => {
  it('goes direct for a confident complete binding', () => expect(route(d({}), LS).kind).toBe('direct'))
  it('asks for parameters when Jev chose LLM_PARAMETERS', () =>
    expect(
      route(
        d({ op: 'read', target: 'LLM_PARAMETERS', bindingMode: 'llm_parameters', args: {} }),
        tool({ name: 'read', defaults: null }),
      ),
    ).toMatchObject({ kind: 'parameters', reason: null }))
  it('answers when ANSWER is chosen confidently', () =>
    expect(
      route(
        d({ phase: 'RESPOND', op: 'ANSWER', target: 'LLM_PARAMETERS', bindingMode: 'llm_parameters' }),
        null,
      ).kind,
    ).toBe('answer'))
  it('arbitrates low confidence on a contested read', () =>
    expect(route(d({ ...low, ambiguity: 0.9 }), LS)).toMatchObject({
      kind: 'arbitration',
      reason: 'low_confidence',
    }))
  it('lets the ambiguity gate relax a clear read, then weakens the binding', () =>
    expect(route(d({ ...low, ambiguity: 0.2 }), LS)).toMatchObject({
      kind: 'parameters',
      reason: 'weak_binding',
      decision: { bindingMode: 'llm_parameters', args: {} },
    }))
  it('never relaxes without the ambiguity signal', () =>
    expect(route(d({ ...low, ambiguity: null }), LS).reason).toBe('low_confidence'))
  it('never relaxes when the gate is off', () =>
    expect(route(d({ ...low, ambiguity: 0.1 }), LS, { thresholds: { ambiguityGate: null } }).reason).toBe(
      'low_confidence',
    ))
  it.each([
    ['ACT write', d({ ...low, phase: 'ACT', op: 'write', ambiguity: 0.1 }), WRITE],
    ['VERIFY shell', d({ ...low, phase: 'VERIFY', op: 'shell', ambiguity: 0.1 }), SHELL],
    ['INSPECT shell', d({ ...low, phase: 'INSPECT', op: 'shell', ambiguity: 0.1 }), SHELL],
    ['RESPOND ANSWER', d({ ...low, phase: 'RESPOND', op: 'ANSWER', ambiguity: 0.1 }), null],
  ])('keeps the full net for %s', (_n, decision, t) =>
    expect(route(decision, t).reason).toBe('low_confidence'),
  )
  it('raises the threshold to 0.6 for external tools only', () => {
    expect(
      route(
        d({
          phase: 'ACT',
          op: 'deploy',
          confidence: 0.55,
          operationPathConfidence: 0.55,
          bindingMode: 'llm_parameters',
          target: 'LLM_PARAMETERS',
          args: {},
        }),
        EXT,
      ).kind,
    ).toBe('arbitration')
    expect(
      route(
        d({
          phase: 'ACT',
          op: 'write',
          confidence: 0.55,
          operationPathConfidence: 0.55,
          bindingMode: 'llm_parameters',
          target: 'LLM_PARAMETERS',
          args: {},
        }),
        WRITE,
      ).kind,
    ).toBe('parameters')
  })
  it('forces arbitration after a recoverable observation, not after a shell non-zero exit', () => {
    expect(route(d({}), LS, { latest: latest('recoverable') })).toMatchObject({
      kind: 'arbitration',
      reason: 'recoverable_observation',
    })
    expect(route(d({}), LS, { latest: latest('unsafe') }).kind).toBe('direct')
  })
  it('catches a premature answer only before any attempt and only when the floor is set', () => {
    const a = d({
      phase: 'RESPOND',
      op: 'ANSWER',
      target: 'LLM_PARAMETERS',
      bindingMode: 'llm_parameters',
      args: {},
      progress: 1,
    })
    expect(route(a, null, { thresholds: { answerProgressFloor: 2 } })).toMatchObject({
      kind: 'arbitration',
      reason: 'premature_answer',
    })
    expect(route(a, null, { thresholds: { answerProgressFloor: 2 }, attempts: true }).kind).toBe('answer')
    expect(route(a, null).kind).toBe('answer')
  })
  it('weakens a binding whose target confidence is low without re-choosing the operation', () => {
    expect(
      route(d({ confidence: 0.3, operationPathConfidence: 0.8, targetConfidence: 0.3 }), LS),
    ).toMatchObject({ kind: 'parameters', reason: 'weak_binding', decision: { op: 'ls' } })
  })
  it('lets the ambiguity gate relax a clear read in VERIFY too', () =>
    expect(route(d({ ...low, phase: 'VERIFY', ambiguity: 0.2 }), LS)).toMatchObject({
      kind: 'parameters',
      reason: 'weak_binding',
    }))
  describe('boundaries', () => {
    const external = (confidence: number) =>
      d({
        phase: 'ACT',
        op: 'deploy',
        confidence,
        operationPathConfidence: confidence,
        bindingMode: 'llm_parameters',
        target: 'LLM_PARAMETERS',
        args: {},
      })
    it('relaxes when ambiguity is exactly at the gate', () =>
      expect(route(d({ ...low, ambiguity: 0.4 }), LS)).toMatchObject({
        kind: 'parameters',
        reason: 'weak_binding',
      }))
    it('arbitrates when ambiguity is just above the gate', () =>
      expect(route(d({ ...low, ambiguity: 0.41 }), LS).reason).toBe('low_confidence'))
    it('goes direct when confidence equals the threshold', () =>
      expect(route(d({ confidence: 0.5, operationPathConfidence: 0.5 }), LS)).toMatchObject({
        kind: 'direct',
        reason: null,
      }))
    it('answers when progress equals the floor', () => {
      const a = d({
        phase: 'RESPOND',
        op: 'ANSWER',
        target: 'LLM_PARAMETERS',
        bindingMode: 'llm_parameters',
        args: {},
        progress: 2,
      })
      expect(route(a, null, { thresholds: { answerProgressFloor: 2 } })).toMatchObject({
        kind: 'answer',
        reason: null,
      })
    })
    it('does not arbitrate an external tool at exactly the external minimum', () =>
      expect(route(external(0.6), EXT)).toMatchObject({ kind: 'parameters', reason: null }))
    it('keeps a higher escalate threshold for external tools instead of overriding it', () => {
      const thresholds = { escalate: 0.7 }
      expect(route(external(0.65), EXT, { thresholds }).kind).toBe('arbitration')
      expect(route(external(0.7), EXT, { thresholds }).kind).toBe('parameters')
    })
  })
})

describe('observed batches', () => {
  const READ = tool({
    name: 'read',
    defaults: null,
    bindingDefaults: { offset: 1, limit: 200 },
    referenceKind: 'file',
    multiTargetMax: 4,
  })
  const member = (path: string) => ({ path, offset: 1, limit: 200 })
  const observedBatch: Decision = {
    phase: 'INSPECT',
    op: 'read',
    target: ['a.md', 'b.md'],
    bindingMode: 'observed',
    args: member('a.md'),
    batch: [member('a.md'), member('b.md')],
    confidence: 0.8,
    operationPathConfidence: 0.9,
    targetConfidence: 0.8,
    ambiguity: null,
    progress: null,
    phaseTop: [['INSPECT', 0.9]],
    actionTop: [['read', 0.9]],
    consumed: [],
  }
  const input = { decision: observedBatch, tool: READ, latest: null, turnHasAttempts: false, thresholds: T }
  it('drops the batch and the observed arguments on a weak binding', () => {
    const r = routeDecision({
      ...input,
      decision: { ...observedBatch, confidence: 0.4, operationPathConfidence: 0.9 },
    })
    expect(r).toMatchObject({
      kind: 'parameters',
      reason: 'weak_binding',
      decision: { bindingMode: 'llm_parameters', target: 'LLM_PARAMETERS', args: {} },
    })
    expect(r.decision.batch).toBeUndefined()
    expect('batch' in r.decision).toBe(false)
  })
  it('sends a confident observed batch straight through', () => {
    expect(routeDecision({ ...input, decision: observedBatch })).toMatchObject({
      kind: 'direct',
      decision: { target: ['a.md', 'b.md'] },
    })
  })
})
