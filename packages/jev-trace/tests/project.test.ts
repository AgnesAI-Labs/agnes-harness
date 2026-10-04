import type {
  AttemptId,
  Candidate,
  CandidateId,
  EnvironmentEpoch,
  IntentId,
  JsonValue,
  RecordId,
  RuntimeRecord,
  StepId,
  ToolDescriptor,
  TurnId,
} from '@agnes/jev-runtime'
import { describe, expect, it } from 'vitest'
import type { TraceEntry } from '../src/index.js'
import { projectTrace } from '../src/index.js'

const rid = (value: string) => value as RecordId
const tid = (value: string) => value as TurnId
const sid = (value: string) => value as StepId
const aid = (value: string) => value as AttemptId
const iid = (value: string) => value as IntentId
const cid = (value: string) => value as CandidateId
const epoch = 'epoch-1' as EnvironmentEpoch
const read: ToolDescriptor = {
  name: 'native_read',
  description: 'Read host data',
  parameters: {},
  output: {},
  revision: '1',
  phases: ['INSPECT'],
  effectClass: 'read_only',
}
const change: ToolDescriptor = {
  name: 'native_change',
  description: 'Change host data',
  parameters: {},
  output: {},
  revision: '1',
  phases: ['INSPECT', 'ACT'],
  effectClass: 'external_write',
}
const candidate: Candidate = {
  id: cid('candidate-1'),
  tool: read.name,
  label: 'A known resource',
  arguments: { target: 'known' },
  sourceRecordIds: [rid('observation')],
  environmentEpoch: epoch,
  toolRevision: '1',
}
const questions: Record<string, JsonValue> = {
  phase: {
    type: 'choice',
    criteria: { INSPECT: 'Inspect', ACT: 'Act', VERIFY: 'Verify', RESPOND: 'Respond' },
  },
  action__inspect: { type: 'choice', criteria: { native_read: 'Read', native_change: 'Change' } },
  binding__native_read: {
    type: 'choice',
    criteria: { 'candidate-1': 'Known call', LLM_PARAMETERS: 'Generate arguments' },
  },
}
const historicalReadBinding = questions.binding__native_read ?? questions.binding__inspect__native_read
if (historicalReadBinding === undefined) throw new Error('expected read binding question')
const historicalQuestions: Record<string, JsonValue> = {
  ...Object.fromEntries(Object.entries(questions).filter(([key]) => key !== 'binding__native_read')),
  binding__inspect__native_read: historicalReadBinding,
}
const criteria = (key: string) =>
  Object.keys((historicalQuestions[key] as { criteria: Record<string, JsonValue> }).criteria)
const choice = (selected: string, keys: readonly string[], confidence = 0.9): JsonValue => ({
  type: 'choice',
  choice: selected,
  confidence,
  probabilities: Object.fromEntries(keys.map((key) => [key, key === selected ? 1 : 0])),
})
const answer: JsonValue = {
  answers: {
    phase: choice('INSPECT', criteria('phase')),
    action__inspect: choice('native_read', criteria('action__inspect')),
    binding__inspect__native_read: choice('candidate-1', criteria('binding__inspect__native_read')),
    // A counterfactual head is allowed to be present but never becomes an accepted score.
    action__act: { choice: 'native_change', probabilities: { native_change: 1 } },
  },
}
const base = (id: string, turn = tid('turn-1'), step?: StepId, attempt?: AttemptId) => ({
  version: 1 as const,
  id: rid(id),
  turn,
  ...(step === undefined ? {} : { step }),
  ...(attempt === undefined ? {} : { attempt }),
})
const entry = (seq: number, turn: number, step: number | undefined, record: RuntimeRecord): TraceEntry => ({
  seq,
  time: seq * 10,
  turn,
  ...(step === undefined ? {} : { step }),
  record,
})

function recording(): TraceEntry[] {
  const first = sid('step-1')
  const second = sid('step-2')
  return [
    entry(2, 1, 1, {
      ...base('request-jev', tid('turn-1'), first, aid('attempt-jev')),
      kind: 'model.requested',
      call: {
        purpose: 'decision',
        backend: 'jev',
        endpoint: 'local',
        requestedModel: 'jev-checkpoint',
        codec: 'systemone-json-v1',
        input: { state: {}, questions: historicalQuestions },
        inputCursor: '1',
      },
    }),
    entry(4, 1, 1, {
      ...base('settle-jev', tid('turn-1'), first, aid('attempt-jev')),
      kind: 'model.settled',
      requested: rid('request-jev'),
      settlement: {
        output: answer,
        observedModel: 'jev-checkpoint',
        usage: { input_tokens: 10 },
        latencyMs: 23,
      },
    }),
    entry(5, 1, 1, {
      ...base('original', tid('turn-1'), first, aid('attempt-jev')),
      kind: 'decision.selected',
      requested: rid('request-jev'),
      phase: 'INSPECT',
      operation: 'native_read',
      candidateId: cid('candidate-1'),
      confidence: 0.9,
      escalation: 'recoverable_observation',
    }),
    entry(6, 1, 1, {
      ...base('request-arbitration', tid('turn-1'), first, aid('attempt-arb')),
      kind: 'model.requested',
      call: {
        purpose: 'arbitration',
        backend: 'deepseek',
        endpoint: 'local',
        requestedModel: 'language-model',
        codec: 'dsh-llm-v1',
        input: { state: {} },
        inputCursor: '5',
      },
    }),
    entry(7, 1, 1, {
      ...base('settle-arbitration', tid('turn-1'), first, aid('attempt-arb')),
      kind: 'model.settled',
      requested: rid('request-arbitration'),
      settlement: { output: { kind: 'call', tool: 'native_change', arguments: { target: 'new' } } },
    }),
    entry(8, 1, 1, {
      ...base('reviewed', tid('turn-1'), first, aid('attempt-arb')),
      kind: 'decision.selected',
      requested: rid('request-arbitration'),
      phase: 'ACT',
      operation: 'native_change',
      confidence: 1,
      escalation: 'recoverable_observation',
    }),
    entry(9, 1, 1, {
      ...base('intent-record', tid('turn-1'), first),
      kind: 'action.intended',
      decision: rid('reviewed'),
      intent: {
        id: iid('intent-1'),
        tool: 'native_change',
        toolRevision: '1',
        arguments: { target: 'new' },
        effectClass: 'external_write',
        environmentEpoch: epoch,
      },
    }),
    entry(10, 1, 1, {
      ...base('dispatch-record', tid('turn-1'), first),
      kind: 'action.dispatching',
      intentId: iid('intent-1'),
      epoch,
    }),
    entry(11, 1, 1, {
      ...base('result-record', tid('turn-1'), first),
      kind: 'action.settled',
      intentId: iid('intent-1'),
      effect: 'unknown',
      observations: [],
      outcome: {
        kind: 'error',
        content: [],
        error: { code: 'UNKNOWN', message: 'effect unverified' },
        directive: { conclude: false, additions: [] },
      },
    }),
    entry(12, 1, undefined, {
      ...base('stop-record'),
      kind: 'run.stopped',
      reason: 'blocked',
      detail: 'effect unresolved',
      unresolved: [iid('intent-1')],
    }),
    entry(14, 2, 1, {
      ...base('second-request', tid('turn-2'), second, aid('attempt-2')),
      kind: 'model.requested',
      call: {
        purpose: 'decision',
        backend: 'laya',
        endpoint: 'local',
        requestedModel: 'laya',
        codec: 'systemone-json-v1',
        input: { state: {}, questions },
        inputCursor: '13',
      },
    }),
    entry(18, 1, undefined, {
      ...base('resolution-record'),
      kind: 'action.resolved',
      intentId: iid('intent-1'),
      resolution: 'accepted_uncertainty',
      actor: 'operator',
      explanation: 'Investigated the external system',
      evidence: ['ticket-1'],
    }),
  ]
}

function conditionalRecording(
  purpose: string,
  operation = 'native_read',
  selectedCandidate?: string,
): TraceEntry[] {
  const pool: Record<string, JsonValue> = {
    purpose: {
      type: 'choice',
      criteria: { INSPECT: 'Inspect', ACT: 'Act', VERIFY: 'Verify', RESPOND: 'Respond' },
    },
  }
  for (const scope of ['INSPECT', 'VERIFY']) {
    pool[`operation::${scope}`] = {
      type: 'choice',
      criteria: { 'tool::native_read': 'Read', 'tool::glob': 'Find files' },
    }
    pool[`binding::${scope}::native_read`] = {
      type: 'choice',
      criteria: {
        LLM_PARAMETERS: 'Generate arguments',
        c1: { arguments: { target: 'first page' } },
        c2: { arguments: { target: 'next page' } },
      },
    }
  }
  const answers: Record<string, JsonValue> = {
    purpose: choice(purpose, ['INSPECT', 'ACT', 'VERIFY', 'RESPOND'], 0.7),
    'operation::INSPECT': choice('tool::native_read', ['tool::native_read', 'tool::glob'], 0.9),
    'binding::INSPECT::native_read': choice('c1', ['LLM_PARAMETERS', 'c1', 'c2'], 0.2),
    'operation::VERIFY':
      purpose === 'VERIFY'
        ? choice('tool::native_read', ['tool::native_read', 'tool::glob'], 0.8)
        : 'invalid unused answer',
    'binding::VERIFY::native_read': choice('c2', ['LLM_PARAMETERS', 'c1', 'c2'], 0.6),
  }
  const manifest: JsonValue = {
    kind: 'jev.decision.manifest.v1',
    operations: [
      ...['INSPECT', 'VERIFY'].map((scope) => ({
        purpose: scope,
        question: `operation::${scope}`,
        choices: [
          { key: 'tool::native_read', kind: 'tool', operation: 'native_read' },
          { key: 'tool::glob', kind: 'tool', operation: 'glob' },
        ],
      })),
      {
        purpose: 'ACT',
        question: null,
        choices: [{ key: 'tool::native_change', kind: 'tool', operation: 'native_change' }],
      },
      { purpose: 'RESPOND', question: null, choices: [{ key: 'RESPOND', kind: 'respond' }] },
    ],
    bindings: [
      ...['INSPECT', 'VERIFY'].map((scope) => ({
        key: `binding::${scope}::native_read`,
        purpose: scope,
        operation: 'native_read',
        mode: 'parameterized',
        question: `binding::${scope}::native_read`,
        choices: [
          { key: 'c1', candidate: { id: 'candidate-1' } },
          { key: 'c2', candidate: { id: 'candidate-2' } },
        ],
      })),
      {
        key: 'binding::ACT::native_change',
        purpose: 'ACT',
        operation: 'native_change',
        mode: 'parameterized',
        question: null,
        choices: [],
      },
    ],
  }
  return [
    entry(1, 1, 1, {
      ...base('manifest', tid('turn-1'), sid('step-1')),
      kind: 'resource.observed',
      resource: manifest,
    }),
    entry(2, 1, 1, {
      ...base('request', tid('turn-1'), sid('step-1')),
      kind: 'model.requested',
      call: {
        purpose: 'decision',
        backend: 'jev',
        endpoint: 'local',
        requestedModel: 'checkpoint',
        codec: 'systemone-json-v1',
        input: { questions: pool },
        inputCursor: null,
      },
    }),
    entry(3, 1, 1, {
      ...base('output', tid('turn-1'), sid('step-1')),
      kind: 'model.settled',
      requested: rid('request'),
      settlement: { output: { answers } },
    }),
    entry(4, 1, 1, {
      ...base('selected', tid('turn-1'), sid('step-1')),
      kind: 'decision.selected',
      requested: rid('request'),
      phase: purpose,
      operation,
      confidence: 0.7,
      ...(selectedCandidate === undefined ? {} : { candidateId: cid(selectedCandidate) }),
    }),
  ]
}

function sharedRecording(
  purpose = 'INSPECT',
  operation = 'native_read',
  selectedCandidate?: string,
): TraceEntry[] {
  const pool: Record<string, JsonValue> = {
    purpose: {
      type: 'choice',
      criteria: { INSPECT: 'Inspect', ACT: 'Act', VERIFY: 'Verify', RESPOND: 'Respond' },
    },
    operation_INSPECT: { type: 'choice', criteria: { native_read: 'Read', job_list: 'List jobs' } },
    operation_VERIFY: { type: 'choice', criteria: { native_read: 'Read' } },
    operation_ACT: { type: 'choice', criteria: { native_change: 'Change' } },
    binding_native_read: {
      type: 'choice',
      criteria: {
        c1: 'operation: "native_read"\ndescription: "Read known target"\narguments: {"target":"known"}',
        LLM_PARAMETERS: 'operation: "native_read"\nmode: "author_parameters"',
      },
    },
    can_end: { type: 'noul', criteria: { true: 'Can answer', false: 'More work' } },
    ambiguity: { type: 'noul', criteria: { true: 'Alternatives', false: 'One operation' } },
  }
  const answers: Record<string, JsonValue> = {
    purpose: choice(purpose, ['INSPECT', 'ACT', 'VERIFY', 'RESPOND'], 0.45),
    operation_INSPECT: choice(
      operation === 'job_list' ? operation : 'native_read',
      ['native_read', 'job_list'],
      0.9,
    ),
    operation_VERIFY: choice('native_read', ['native_read'], 0.8),
    operation_ACT: choice('native_change', ['native_change'], 0.7),
    binding_native_read: choice(
      selectedCandidate === undefined ? 'LLM_PARAMETERS' : 'c1',
      ['c1', 'LLM_PARAMETERS'],
      0.65,
    ),
    can_end: { type: 'noul', noul: 0.6 },
    ambiguity: { type: 'noul', noul: 0.2 },
  }
  const manifest: JsonValue = {
    kind: 'jev.decision.manifest.v1',
    designRevision: 5,
    operations: [
      ...['INSPECT', 'ACT', 'VERIFY'].map((scope) => ({
        purpose: scope,
        question: `operation_${scope}`,
        choices: Object.keys(
          (pool[`operation_${scope}`] as { criteria: Record<string, JsonValue> }).criteria,
        ).map((name) => ({ key: name, kind: 'tool', operation: name })),
      })),
      { purpose: 'RESPOND', question: null, choices: [{ key: 'RESPOND', kind: 'respond' }] },
    ],
    bindings: [
      {
        key: 'binding_native_read',
        operation: 'native_read',
        mode: 'parameterized',
        question: 'binding_native_read',
        choices: [{ key: 'c1', candidate: { id: 'candidate-1' } }],
      },
      { key: 'binding_job_list', operation: 'job_list', mode: 'no_arguments' },
      {
        key: 'binding_native_change',
        operation: 'native_change',
        mode: 'parameterized',
        question: null,
        choices: [],
      },
    ],
  }
  const records = conditionalRecording(purpose, operation, selectedCandidate)
  return records.map((value) => {
    const record = value.record
    if (record.kind === 'resource.observed') return { ...value, record: { ...record, resource: manifest } }
    if (record.kind === 'model.requested')
      return { ...value, record: { ...record, call: { ...record.call, input: { questions: pool } } } }
    if (record.kind === 'model.settled')
      return { ...value, record: { ...record, settlement: { output: { answers } } } }
    return value
  })
}

describe('projectTrace', () => {
  it('shows applied support only after its recorded route and never consumes a supporting branch', () => {
    const records = sharedRecording('INSPECT', 'native_read', 'candidate-1')
    const route = (supportApplied: boolean, decisionRecordId = 'selected'): TraceEntry =>
      entry(5, 1, 1, {
        ...base('route', tid('turn-1'), sid('step-1')),
        kind: 'resource.observed',
        resource: {
          kind: 'jev.decision.route.v1',
          requested: 'request',
          decisionRecordId,
          purpose: 'INSPECT',
          operation: 'native_read',
          supportApplied,
          equivalentSupport: 0.85,
          supportingQuestionIds: [
            'operation_INSPECT',
            'operation_VERIFY',
            'operation_ACT',
            'binding_native_read',
          ],
        },
      })
    const source = [...records, route(true)]
    const step = projectTrace(source).turns[0]!.steps[0]!
    const heads = step.requests[0]!.heads
    expect(heads.find((head) => head.key === 'operation_INSPECT')).toMatchObject({ status: 'consumed' })
    expect(heads.find((head) => head.key === 'binding_native_read')).toMatchObject({ status: 'consumed' })
    expect(heads.find((head) => head.key === 'operation_ACT')).toMatchObject({ status: 'unconsumed' })
    const support = heads.find((head) => head.key === 'operation_VERIFY')!
    expect(support).toMatchObject({ status: 'supporting', selected: 'native_read', confidence: 0.8 })
    expect(support.options.every((option) => !option.selected)).toBe(true)
    expect(step.decisions).toHaveLength(1)
    expect(step.actions).toEqual([])
    for (const view of [
      projectTrace(source, 4),
      projectTrace([...records, route(false)]),
      projectTrace([...records, route(true, 'other')]),
    ]) {
      expect(
        view.turns[0]!.steps[0]!.requests[0]!.heads.find((head) => head.key === 'operation_VERIFY')?.status,
      ).toBe('unconsumed')
    }
    const output = records[2]!.record
    if (output.kind !== 'model.settled') throw new Error('Expected model output')
    records[2] = {
      ...records[2]!,
      record: {
        ...output,
        settlement: {
          output: {
            answers: {
              purpose: choice('INSPECT', ['INSPECT', 'ACT', 'VERIFY', 'RESPOND']),
              operation_INSPECT: choice('native_read', ['native_read', 'job_list']),
              operation_VERIFY: 'invalid support',
              binding_native_read: choice('c1', ['c1', 'LLM_PARAMETERS']),
            },
          },
        },
      },
    }
    expect(
      projectTrace([...records, route(true)]).turns[0]!.steps[0]!.requests[0]!.heads.find(
        (head) => head.key === 'operation_VERIFY',
      )?.status,
    ).toBe('unconsumed')
  })

  it('maps shared bindings through the recorded manifest and keeps unselected singleton scores off the route', () => {
    for (const purpose of ['INSPECT', 'VERIFY']) {
      const request = projectTrace(sharedRecording(purpose, 'native_read', 'candidate-1')).turns[0]!.steps[0]!
        .requests[0]!
      expect(request.heads.filter((head) => head.status === 'consumed').map((head) => head.key)).toEqual([
        'purpose',
        `operation_${purpose}`,
        'binding_native_read',
      ])
      expect(request.heads.find((head) => head.key === 'binding_native_read')).toMatchObject({
        selected: 'c1',
        confidence: 0.65,
      })
      expect(request.heads.find((head) => head.key === 'operation_ACT')).toMatchObject({
        status: 'unconsumed',
      })
      expect(request.heads.some((head) => head.key === 'can_end' || head.key === 'ambiguity')).toBe(false)
    }
    const heads = projectTrace(sharedRecording('VERIFY', 'native_read', 'candidate-1')).turns[0]!.steps[0]!
      .requests[0]!.heads
    expect(heads.find((head) => head.key === 'operation_VERIFY')).toMatchObject({
      status: 'consumed',
      confidence: 0.8,
    })
    expect(heads.find((head) => head.key === 'binding_native_read')?.options[0]?.criterion).toContain(
      'arguments: {"target":"known"}',
    )
  })

  it('retains no-argument and empty-pool routes without inventing binding confidence or RESPOND operation confidence', () => {
    for (const [purpose, operation, expected] of [
      ['INSPECT', 'job_list', 'no_arguments'],
      ['ACT', 'native_change', 'LLM_PARAMETERS'],
    ]) {
      const heads = projectTrace(sharedRecording(purpose, operation)).turns[0]!.steps[0]!.requests[0]!.heads
      expect(heads.find((head) => head.key === `binding_${operation}`)).toEqual({
        key: `binding_${operation}`,
        role: 'binding',
        status: 'deterministic',
        selected: expected,
        options: [{ key: expected, criterion: expected, selected: true }],
      })
      expect(heads.find((head) => head.key === `operation_${purpose}`)?.status).toBe('consumed')
    }
    const heads = projectTrace(sharedRecording('RESPOND', 'RESPOND')).turns[0]!.steps[0]!.requests[0]!.heads
    expect(heads.filter((head) => head.status !== 'unconsumed').map((head) => head.key)).toEqual([
      'purpose',
      'operation_RESPOND',
    ])
    expect(heads.find((head) => head.key === 'operation_RESPOND')).not.toHaveProperty('confidence')
  })

  it('consumes purpose and only its conditional operation and binding while keeping raw confidences independent', () => {
    const source = conditionalRecording('INSPECT', 'native_read')
    const before = structuredClone(source)
    const step = projectTrace(source).turns[0]!.steps[0]!
    expect(step.originalDecision?.confidence).toBe(0.7)
    expect(step.requests[0]?.heads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'purpose', status: 'consumed', selected: 'INSPECT', confidence: 0.7 }),
        expect.objectContaining({
          key: 'operation::INSPECT',
          status: 'consumed',
          selected: 'tool::native_read',
          confidence: 0.9,
        }),
        expect.objectContaining({
          key: 'binding::INSPECT::native_read',
          status: 'consumed',
          selected: 'c1',
          confidence: 0.2,
        }),
        expect.objectContaining({ key: 'operation::VERIFY', status: 'unconsumed' }),
        expect.objectContaining({ key: 'binding::VERIFY::native_read', status: 'unconsumed' }),
      ]),
    )
    expect(
      step.requests[0]?.heads
        .filter((head) => head.status === 'unconsumed')
        .every(
          (head) =>
            head.confidence === undefined && head.options.every((option) => option.probability === undefined),
        ),
    ).toBe(true)
    expect(source).toEqual(before)
    const verify = projectTrace(conditionalRecording('VERIFY', 'native_read', 'candidate-2')).turns[0]!
      .steps[0]!.requests[0]!
    expect(verify.heads.find((head) => head.key === 'binding::VERIFY::native_read')).toMatchObject({
      status: 'consumed',
      selected: 'c2',
    })
    expect(verify.heads.find((head) => head.key === 'binding::INSPECT::native_read')).toMatchObject({
      status: 'unconsumed',
    })
  })

  it('displays singleton operations and omitted parameter routes only from their recorded manifest without confidence', () => {
    const source = conditionalRecording('ACT', 'native_change')
    for (const mode of ['parameterized', 'no_arguments']) {
      const records = structuredClone(source)
      const manifest = records[0]!.record
      if (
        manifest.kind !== 'resource.observed' ||
        manifest.resource === null ||
        typeof manifest.resource !== 'object' ||
        Array.isArray(manifest.resource)
      )
        throw new Error('Expected manifest')
      manifest.resource.bindings = [
        {
          key: 'binding::ACT::native_change',
          purpose: 'ACT',
          operation: 'native_change',
          mode,
          ...(mode === 'parameterized' ? { question: null, choices: [] } : {}),
        },
      ]
      const heads = projectTrace(records).turns[0]!.steps[0]!.requests[0]!.heads
      const constants = heads.filter((head) => head.status === 'deterministic')
      expect(constants.map((head) => [head.key, head.selected])).toEqual([
        ['operation::ACT', 'tool::native_change'],
        ['binding::ACT::native_change', mode === 'parameterized' ? 'LLM_PARAMETERS' : 'no_arguments'],
      ])
      expect(
        constants.every(
          (head) =>
            head.confidence === undefined && head.options.every((option) => option.probability === undefined),
        ),
      ).toBe(true)
    }
    expect(
      projectTrace(source.slice(1)).turns[0]!.steps[0]!.requests[0]!.heads.some(
        (head) => head.status === 'deterministic',
      ),
    ).toBe(false)
    expect(
      projectTrace(source, 3).turns[0]!.steps[0]!.requests[0]!.heads.some(
        (head) => head.status === 'deterministic',
      ),
    ).toBe(false)
  })

  it('shows RESPOND as a recorded constant and does not consume another purpose or invent a binding', () => {
    const step = projectTrace(conditionalRecording('RESPOND', 'RESPOND')).turns[0]!.steps[0]!
    expect(
      step.requests[0]?.heads
        .filter((head) => head.status !== 'unconsumed')
        .map((head) => [head.key, head.selected]),
    ).toEqual([
      ['purpose', 'RESPOND'],
      ['operation::RESPOND', 'RESPOND'],
    ])
    expect(step.requests[0]?.heads.find((head) => head.key === 'operation::RESPOND')).toMatchObject({
      role: 'action',
      status: 'deterministic',
    })
    expect(step.actions).toEqual([])
  })

  it('marks a selected binding inconsistent with its same-purpose manifest as invalid', () => {
    const step = projectTrace(conditionalRecording('VERIFY', 'native_read', 'candidate-1')).turns[0]!
      .steps[0]!
    expect(step.requests[0]?.heads.find((head) => head.key === 'binding::VERIFY::native_read')).toMatchObject(
      { status: 'invalid' },
    )
    expect(
      step.requests[0]?.heads.find((head) => head.key === 'binding::INSPECT::native_read'),
    ).toMatchObject({ status: 'unconsumed' })
  })

  it('replays historical global operation and short binding keys without inventing a phase or singleton head', () => {
    const source = recording().slice(0, 3)
    const current: Record<string, JsonValue> = {
      operation: {
        type: 'choice',
        criteria: { RESPOND: 'Respond', 'tool::native_read': 'Read', 'tool::native_change': 'Change' },
      },
      'binding::native_read': {
        type: 'choice',
        criteria: { LLM_PARAMETERS: 'Generate arguments', c1: 'Known call' },
      },
    }
    const request = source[0]!
    const settlement = source[1]!
    const selection = source[2]!
    if (
      request.record.kind !== 'model.requested' ||
      settlement.record.kind !== 'model.settled' ||
      selection.record.kind !== 'decision.selected'
    )
      throw new Error('Missing decision records')
    const keys = (key: string) =>
      Object.keys((current[key] as { criteria: Record<string, JsonValue> }).criteria)
    source[0] = {
      ...request,
      record: {
        ...request.record,
        call: { ...request.record.call, input: { state: {}, questions: current } },
      },
    }
    source[1] = {
      ...settlement,
      record: {
        ...settlement.record,
        settlement: {
          output: {
            answers: {
              operation: choice('tool::native_read', keys('operation')),
              'binding::native_read': choice('c1', keys('binding::native_read')),
            },
          },
        },
      },
    }
    source[2] = { ...selection, record: { ...selection.record, phase: 'UNSPECIFIED', source: 'jev' } }
    const heads = projectTrace(source).turns[0]?.steps[0]?.requests[0]?.heads
    expect(heads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'operation',
          role: 'action',
          status: 'consumed',
          selected: 'tool::native_read',
        }),
        expect.objectContaining({
          key: 'binding::native_read',
          role: 'binding',
          status: 'consumed',
          selected: 'c1',
        }),
      ]),
    )
    expect(heads?.some((head) => head.role === 'phase' || head.status === 'deterministic')).toBe(false)
  })

  it('does not synthesize confidence for arbitration selections', () => {
    const source = recording()
    const step = projectTrace(source).turns[0]?.steps[0]
    const arbitrated = step?.decisions.find((decision) => decision.purpose === 'arbitration')
    expect(arbitrated).toBeDefined()
    expect(arbitrated?.confidence).toBeUndefined()
  })

  it('consumes an operation binding once and leaves another operation binding unused', () => {
    const source = recording().slice(0, 3)
    const request = source[0]!
    const settlement = source[1]!
    if (request.record.kind !== 'model.requested' || settlement.record.kind !== 'model.settled') {
      throw new Error('expected decision request and settlement')
    }
    const { binding__inspect__native_read: readBinding, ...otherQuestions } = historicalQuestions
    if (readBinding === undefined) throw new Error('expected historical read binding')
    const currentQuestions = {
      ...otherQuestions,
      binding__native_read: readBinding,
      binding__native_change: {
        type: 'choice',
        criteria: {
          LLM_PARAMETERS: 'Generate all arguments',
          'candidate-change': 'A different operation',
        },
      },
    }
    source[0] = {
      ...request,
      record: {
        ...request.record,
        call: { ...request.record.call, input: { state: {}, questions: currentQuestions } },
      },
    }
    source[1] = {
      ...settlement,
      record: {
        ...settlement.record,
        settlement: {
          output: {
            answers: {
              phase: choice('INSPECT', criteria('phase')),
              action__inspect: choice('native_read', criteria('action__inspect')),
              binding__native_read: choice('candidate-1', criteria('binding__inspect__native_read')),
              binding__native_change: choice('candidate-change', ['LLM_PARAMETERS', 'candidate-change']),
            },
          },
        },
      },
    }
    const heads = projectTrace(source).turns[0]?.steps[0]?.requests[0]?.heads
    expect(heads?.find((head) => head.key === 'binding__native_read')).toMatchObject({
      status: 'consumed',
      selected: 'candidate-1',
    })
    expect(heads?.find((head) => head.key === 'binding__native_change')).toMatchObject({
      status: 'unconsumed',
    })
    expect(heads?.some((head) => head.key === 'binding__inspect__native_read')).toBe(false)
  })

  it('keeps the submitted pool and distinguishes Jev choice, arbitration, and the action barriers', () => {
    const source = recording()
    const before = JSON.stringify(source)
    const view = projectTrace(source)
    expect(JSON.stringify(source)).toBe(before)
    expect(JSON.parse(JSON.stringify(view))).toEqual(view)
    const first = view.turns[0]
    const step = first?.steps[0]
    expect(first).toMatchObject({ id: 'turn-1', number: 1, lastSeq: 18 })
    expect(step).toMatchObject({
      id: 'step-1',
      originalDecision: { operation: 'native_read', purpose: 'decision' },
      finalDecision: { operation: 'native_change', purpose: 'arbitration' },
    })
    const request = step?.requests[0]
    expect(request).toMatchObject({
      id: 'request-jev',
      attempt: 'attempt-jev',
      observedModel: 'jev-checkpoint',
      usage: { input_tokens: 10 },
      latencyMs: 23,
    })
    expect(request?.heads.find((head) => head.key === 'phase')).toMatchObject({
      status: 'consumed',
      selected: 'INSPECT',
    })
    expect(request?.heads.find((head) => head.key === 'binding__inspect__native_read')).toMatchObject({
      status: 'consumed',
      selected: 'candidate-1',
    })
    expect(
      request?.heads
        .find((head) => head.key === 'action__inspect')
        ?.options.map((option) => [option.key, option.probability]),
    ).toEqual([
      ['native_read', 1],
      ['native_change', 0],
    ])
    expect(step?.requests[1]).toMatchObject({ purpose: 'arbitration', heads: [] })
    expect(first?.actions[0]).toMatchObject({
      intentId: 'intent-1',
      decisionId: 'reviewed',
      status: 'resolved',
      dispatchingSeq: 10,
      settledSeq: 11,
      resolutionSeq: 18,
      outcome: { effect: 'unknown' },
      resolution: { resolution: 'accepted_uncertainty' },
    })
    expect(first?.stops[0]?.unresolved).toEqual(['intent-1'])
    expect(view.turns[1]).toMatchObject({ id: 'turn-2', number: 2, firstSeq: 14 })
  })

  it('projects exact Session prefixes, including pending models and late old-turn resolution', () => {
    const source = recording()
    const pending = projectTrace(source, 2).turns[0]?.steps[0]?.requests[0]
    expect(pending?.status).toBe('pending')
    expect(pending?.heads.every((head) => head.status === 'pending')).toBe(true)
    expect(
      projectTrace(source, 4).turns[0]?.steps[0]?.requests[0]?.heads.every(
        (head) => head.status === 'unconsumed',
      ),
    ).toBe(true)
    expect(projectTrace(source, 5).turns[0]?.steps[0]?.originalDecision?.operation).toBe('native_read')
    expect(projectTrace(source, 8).turns[0]?.steps[0]?.finalDecision?.operation).toBe('native_change')
    expect(projectTrace(source, 9).turns[0]?.actions[0]?.status).toBe('intended')
    expect(projectTrace(source, 10).turns[0]?.actions[0]?.status).toBe('dispatching')
    expect(projectTrace(source, 11).turns[0]?.actions[0]?.status).toBe('unknown')
    expect(projectTrace(source, 14).turns[0]?.actions[0]?.status).toBe('unknown')
    expect(projectTrace(source, 18).turns[0]?.actions[0]?.status).toBe('resolved')
    expect(projectTrace(source, 0)).toEqual({ throughSeq: 0, turns: [] })
    expect(() => projectTrace([...source, source[0]!])).toThrow('distinct nonnegative observation sequences')
  })

  it('shows omitted singleton heads as deterministic and rejects malformed probabilities', () => {
    const source = recording().slice(0, 3)
    const selected = source[2]!
    const alternative = {
      answers: {
        phase: choice('ACT', criteria('phase')),
        action__inspect: choice('native_read', criteria('action__inspect')),
      },
    }
    const settlement = source[1]!
    source[1] = {
      ...settlement,
      record: {
        ...settlement.record,
        kind: 'model.settled',
        requested: rid('request-jev'),
        settlement: { output: alternative },
      },
    }
    source[2] = {
      ...selected,
      record: {
        ...base('original', tid('turn-1'), sid('step-1')),
        kind: 'decision.selected',
        requested: rid('request-jev'),
        phase: 'ACT',
        operation: 'native_change',
        confidence: 0.9,
      },
    }
    const heads = projectTrace(source).turns[0]?.steps[0]?.requests[0]?.heads
    expect(heads?.find((head) => head.key === 'phase')?.status).toBe('consumed')
    expect(heads?.find((head) => head.key === 'action__act')).toMatchObject({
      status: 'deterministic',
      selected: 'native_change',
    })
    expect(heads?.find((head) => head.key === 'binding__act__native_change')).toMatchObject({
      status: 'deterministic',
      selected: 'LLM_PARAMETERS',
    })
    const bad = structuredClone(source)
    const badSettlement = bad[1]!.record
    if (badSettlement.kind !== 'model.settled') throw new Error('expected settlement')
    bad[1] = {
      ...bad[1]!,
      record: {
        ...badSettlement,
        settlement: {
          output: {
            answers: {
              phase: { type: 'choice', choice: 'ACT', confidence: 0.9, probabilities: { ACT: 1.5 } },
            },
          },
        },
      },
    }
    const invalid = projectTrace(bad).turns[0]?.steps[0]?.requests[0]?.heads.find(
      (head) => head.key === 'phase',
    )
    expect(invalid?.status).toBe('invalid')
    expect(invalid?.options.every((option) => option.probability === undefined)).toBe(true)
  })

  it('retains a counterfactual binding head without treating its returned scores as consumed', () => {
    const otherCandidate: Candidate = {
      ...candidate,
      id: cid('candidate-change'),
      tool: change.name,
      arguments: { target: 'counterfactual' },
    }
    const compiled: Record<string, JsonValue> = {
      ...questions,
      binding__native_change: {
        type: 'choice',
        criteria: {
          [otherCandidate.id]: 'Other known call',
          LLM_PARAMETERS: 'Generate arguments',
        },
      },
    }
    const readBinding = compiled.binding__native_read ?? compiled.binding__inspect__native_read
    const changeBinding = compiled.binding__native_change ?? compiled.binding__inspect__native_change
    if (readBinding === undefined || changeBinding === undefined)
      throw new Error('expected binding questions')
    const pool: Record<string, JsonValue> = {
      ...Object.fromEntries(Object.entries(compiled).filter(([key]) => !key.startsWith('binding__'))),
      binding__inspect__native_read: readBinding,
      binding__inspect__native_change: changeBinding,
    }
    const keys = (name: string) =>
      Object.keys((pool[name] as { criteria: Record<string, JsonValue> }).criteria)
    const request = recording()[0]!
    const settlement = recording()[1]!
    const selection = recording()[2]!
    if (request.record.kind !== 'model.requested' || settlement.record.kind !== 'model.settled') {
      throw new Error('expected decision request and settlement')
    }
    const entries: TraceEntry[] = [
      {
        ...request,
        record: {
          ...request.record,
          call: { ...request.record.call, input: { state: {}, questions: pool } },
        },
      },
      {
        ...settlement,
        record: {
          ...settlement.record,
          settlement: {
            output: {
              answers: {
                phase: choice('INSPECT', keys('phase')),
                action__inspect: choice('native_read', keys('action__inspect')),
                binding__inspect__native_read: choice('candidate-1', keys('binding__inspect__native_read')),
                binding__inspect__native_change: choice(
                  'candidate-change',
                  keys('binding__inspect__native_change'),
                ),
              },
            },
          },
        },
      },
      selection,
    ]
    const head = projectTrace(entries).turns[0]?.steps[0]?.requests[0]?.heads.find(
      (item) => item.key === 'binding__inspect__native_change',
    )
    expect(head?.status).toBe('unconsumed')
    expect(head?.options.every((option) => option.probability === undefined && !option.selected)).toBe(true)
  })

  it('accepts zero-based host sequences and does not guess an unknown request codec', () => {
    const original = recording()[0]!
    if (original.record.kind !== 'model.requested') throw new Error('expected request')
    const entry: TraceEntry = {
      ...original,
      seq: 0,
      time: 0,
      record: { ...original.record, call: { ...original.record.call, codec: 'other-json-v2' } },
    }
    expect(projectTrace([entry], 0).turns[0]?.steps[0]?.requests[0]).toMatchObject({
      requestedSeq: 0,
      status: 'pending',
      heads: [],
    })
  })

  it('binds the final operation to the intended decision when a later decision appears in the step', () => {
    const records = recording().slice(0, 9)
    records.push(
      entry(15, 1, 1, {
        ...base('later', tid('turn-1'), sid('step-1')),
        kind: 'decision.selected',
        requested: rid('request-jev'),
        phase: 'INSPECT',
        operation: 'native_read',
        confidence: 0.9,
      }),
    )
    const step = projectTrace(records).turns[0]?.steps[0]
    expect(step?.decisions.at(-1)?.id).toBe('later')
    expect(step?.finalDecision?.id).toBe('reviewed')
    expect(step?.actions[0]?.decisionId).toBe('reviewed')
  })

  it('keeps interrupted requests and dispatched actions distinct when a stop has no settlement', () => {
    const missingActionSettlement = recording().filter((item) => item.seq !== 11)
    expect(projectTrace(missingActionSettlement, 10).turns[0]?.actions[0]?.status).toBe('dispatching')
    expect(projectTrace(missingActionSettlement, 12).turns[0]?.actions[0]?.status).toBe('unknown')
    const failedRequest = recording().slice(0, 2)
    const settlement = failedRequest[1]!
    if (settlement.record.kind !== 'model.settled') throw new Error('expected settlement')
    failedRequest[1] = {
      ...settlement,
      record: {
        ...settlement.record,
        settlement: { error: { code: 'MODEL_FAILURE', message: 'request interrupted', retryable: false } },
      },
    }
    const request = projectTrace(failedRequest).turns[0]?.steps[0]?.requests[0]
    expect(request?.status).toBe('failed')
    expect(request?.heads.every((head) => head.status === 'unconsumed')).toBe(true)
    expect(request?.latencyMs).toBeUndefined()
  })

  it('refuses to merge different portable identities under one host turn or step number', () => {
    const first = recording()[0]!
    const second = recording()[1]!
    expect(() =>
      projectTrace([
        first,
        {
          ...second,
          record: {
            ...second.record,
            turn: tid('other-turn'),
          },
        },
      ]),
    ).toThrow('multiple portable turn IDs')
    expect(() =>
      projectTrace([
        first,
        {
          ...second,
          record: {
            ...second.record,
            step: sid('other-step'),
          },
        },
      ]),
    ).toThrow('multiple portable step IDs')
  })

  it('shows ANSWER as a deterministic operation without inventing a binding or tool action', () => {
    const source = recording().slice(0, 3)
    const settlement = source[1]!
    const selection = source[2]!
    if (settlement.record.kind !== 'model.settled') throw new Error('expected settlement')
    source[1] = {
      ...settlement,
      record: {
        ...settlement.record,
        settlement: { output: { answers: { phase: choice('RESPOND', criteria('phase')) } } },
      },
    }
    source[2] = {
      ...selection,
      record: {
        ...base('answer-decision', tid('turn-1'), sid('step-1')),
        kind: 'decision.selected',
        requested: rid('request-jev'),
        phase: 'RESPOND',
        operation: 'ANSWER',
        confidence: 0.9,
      },
    }
    const step = projectTrace(source).turns[0]?.steps[0]
    const heads = step?.requests[0]?.heads
    expect(heads?.find((head) => head.key === 'action__respond')).toMatchObject({
      status: 'deterministic',
      selected: 'ANSWER',
    })
    expect(heads?.some((head) => head.role === 'binding' && head.status === 'deterministic')).toBe(false)
    expect(heads?.find((head) => head.key === 'action__inspect')?.status).toBe('unconsumed')
    expect(step?.finalDecision?.operation).toBe('ANSWER')
    expect(step?.actions).toEqual([])
  })

  it('tolerates extra choice heads, absent questions, and unbound early step metadata', () => {
    const source = recording().slice(0, 3)
    const request = source[0]!
    if (request.record.kind !== 'model.requested') throw new Error('expected request')
    source[0] = {
      ...request,
      record: {
        ...base('request-jev', tid('turn-1'), undefined, aid('attempt-jev')),
        kind: 'model.requested',
        call: {
          ...request.record.call,
          input: {
            questions: {
              ...questions,
              extension_choice: { type: 'choice', criteria: { perhaps: 'Extra data' } },
            },
            state: {},
          },
        },
      },
    }
    const step = projectTrace(source).turns[0]?.steps[0]
    expect(step?.id).toBe('step-1')
    expect(step?.requests[0]?.heads.find((head) => head.key === 'extension_choice')).toMatchObject({
      role: 'other',
      status: 'unconsumed',
    })
    const empty = [
      { ...request, record: { ...request.record, call: { ...request.record.call, input: { state: {} } } } },
    ]
    expect(projectTrace(empty).turns[0]?.steps[0]?.requests[0]?.heads).toEqual([])
  })

  it('reports a settled applied action and sorts multiple steps without changing the input order', () => {
    const source = recording().filter((item) => item.seq <= 11)
    const settled = source.find((item) => item.seq === 11)!
    if (settled.record.kind !== 'action.settled') throw new Error('expected action settlement')
    const applied: TraceEntry = { ...settled, record: { ...settled.record, effect: 'applied' } }
    const extra = entry(13, 1, 2, {
      ...base('answer-request', tid('turn-1'), sid('step-later'), aid('attempt-later')),
      kind: 'model.requested',
      call: {
        purpose: 'answer',
        backend: 'deepseek',
        endpoint: 'local',
        requestedModel: 'language-model',
        codec: 'dsh-llm-v1',
        input: { state: {} },
        inputCursor: '12',
      },
    })
    const unsorted = [extra, ...source.filter((item) => item.seq !== 11), applied]
    const before = unsorted.map((item) => item.seq)
    const turn = projectTrace(unsorted).turns[0]
    expect(unsorted.map((item) => item.seq)).toEqual(before)
    expect(turn?.steps.map((step) => step.id)).toEqual(['step-1', 'step-later'])
    expect(turn?.actions[0]?.status).toBe('settled')
    expect(turn?.actions[0]?.outcome?.effect).toBe('applied')
    expect(turn?.steps[1]?.requests[0]?.heads).toEqual([])
  })

  it('rejects invalid cursors and observation sequences', () => {
    expect(() => projectTrace([], -1)).toThrow('nonnegative Session sequence')
    expect(() => projectTrace([], 0.5)).toThrow('nonnegative Session sequence')
    expect(() => projectTrace([{ ...recording()[0]!, seq: -1 }])).toThrow('nonnegative observation sequences')
    expect(projectTrace([])).toEqual({ throughSeq: null, turns: [] })
  })

  it('does not decode another decision codec or fabricate deterministic heads from it', () => {
    const source = recording().slice(0, 3)
    const request = source[0]!
    if (request.record.kind !== 'model.requested') throw new Error('expected request')
    source[0] = {
      ...request,
      record: { ...request.record, call: { ...request.record.call, codec: 'future-decision-v2' } },
    }
    const result = projectTrace(source).turns[0]?.steps[0]
    expect(result?.originalDecision?.operation).toBe('native_read')
    expect(result?.requests[0]?.heads).toEqual([])
  })

  it('rejects orphan model and action transitions instead of showing an incomplete path', () => {
    const source = recording()
    for (const [position, reason] of [
      [1, 'model settlement has no observed request'],
      [2, 'selected decision has no decision or arbitration request'],
      [7, 'dispatch has no intended action'],
      [8, 'action settlement has no intended action'],
      [11, 'resolution has no intended action'],
    ] as const) {
      expect(() => projectTrace([source[position]!])).toThrow(reason)
    }
    const wrongRequest = entry(6, 1, 1, {
      ...base('request-arbitration', tid('turn-1'), sid('step-1')),
      kind: 'model.requested',
      call: {
        purpose: 'answer',
        backend: 'deepseek',
        endpoint: 'local',
        requestedModel: 'language-model',
        codec: 'dsh-llm-v1',
        input: {},
        inputCursor: null,
      },
    })
    const wrongDecision = entry(7, 1, 1, {
      ...base('wrong-decision', tid('turn-1'), sid('step-1')),
      kind: 'decision.selected',
      requested: rid('request-arbitration'),
      phase: 'RESPOND',
      operation: 'ANSWER',
      confidence: 1,
    })
    expect(() => projectTrace([wrongRequest, wrongDecision])).toThrow('no decision or arbitration request')
  })

  it('keeps a step display number when no portable step ID was recorded', () => {
    const minimal = entry(0, 1, 1, {
      ...base('bare-request'),
      kind: 'model.requested',
      call: {
        purpose: 'decision',
        backend: 'jev',
        endpoint: 'local',
        requestedModel: null,
        codec: 'systemone-json-v1',
        input: { state: {} },
        inputCursor: null,
      },
    })
    const admission = entry(1, 1, undefined, {
      ...base('admission'),
      kind: 'input.admitted',
      input: { id: 'user-1', source: 'user', content: [] },
    })
    const view = projectTrace([admission, minimal])
    expect(view.turns[0]?.steps[0]).toMatchObject({ number: 1, requests: [{ requestedSeq: 0, heads: [] }] })
    expect(view.turns[0]?.steps[0]?.id).toBeUndefined()
    expect(view.turns[0]?.steps[0]?.requests[0]?.attempt).toBeUndefined()
  })
})
