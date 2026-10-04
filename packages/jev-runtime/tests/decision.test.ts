import { describe, expect, it } from 'vitest'
import { brandString } from '../src/brand.js'
import type { DecisionSurface, Phase } from '../src/decision.js'
import { compileDecisionTools, compileQuestions, DECISION_GUIDANCE, parseDecision } from '../src/decision.js'
import type {
  Candidate,
  CandidateId,
  DecisionToolProfile,
  EnvironmentEpoch,
  JsonValue,
  RecordId,
  RuntimeConfig,
  ToolDescriptor,
} from '../src/types.js'

const tool: ToolDescriptor = {
  name: 'read_native',
  description: 'Read host data',
  revision: '1',
  effectClass: 'read_only',
  parameters: {
    type: 'object',
    properties: { target: { type: 'string' } },
    required: ['target'],
    additionalProperties: false,
  },
  output: {},
  phases: ['INSPECT', 'VERIFY'],
}
const noArguments: ToolDescriptor = {
  ...tool,
  name: 'job_list',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
}
const candidate: Candidate = {
  id: brandString<CandidateId>('private-candidate-id'),
  tool: tool.name,
  label: 'Observed read target',
  arguments: { target: 'file' },
  sourceRecordIds: [brandString<RecordId>('private-record-id')],
  environmentEpoch: brandString<EnvironmentEpoch>('private-epoch'),
  toolRevision: '1',
  evidence: [
    {
      sourceRecordId: brandString<RecordId>('private-record-id'),
      pointer: '/private/pointer',
      value: 'file',
    },
  ],
  preconditions: { hash: 'private-hash' },
}
const config: RuntimeConfig = {
  maxSteps: 3,
  maxModelAttempts: 4,
  maxNoProgress: 2,
  maxRepeatedFailures: 2,
  maxCandidates: 3,
  maxHistory: 8,
  maxQuestionBytes: 30_000,
  maxOutputBytes: 10_000,
  escalateBelow: 0.6,
  mutationEscalateBelow: 0.7,
  bindingBelow: 0.6,
  equivalentSupportThreshold: 0.8,
  ambiguityGate: null,
  answerProgressFloor: null,
  responseReviewMode: 'diagnostic',
  maxResponseReviewAttempts: 2,
}
const selected = (key: string, names: readonly string[], confidence = 0.9): JsonValue => ({
  type: 'choice',
  choice: key,
  confidence,
  probabilities: Object.fromEntries(names.map((name) => [name, name === key ? 1 : 0])),
})
function answer(
  surface: DecisionSurface,
  key: string,
  extra: Record<string, JsonValue> = {},
  purpose: Phase = key === 'RESPOND' ? 'RESPOND' : 'INSPECT',
): JsonValue {
  const plan = surface.operations.get(purpose)
  if (plan === undefined || !plan.choices.has(key)) throw new Error('Unavailable test operation')
  return {
    answers: {
      purpose: selected(purpose, [...surface.operations.keys()]),
      ...(plan.question === null ? {} : { [plan.question]: selected(key, [...plan.choices.keys()]) }),
      ...extra,
    },
  }
}
function question(
  surface: DecisionSurface,
  key: string,
): { criteria: Record<string, JsonValue>; instructions: string } {
  return surface.questions[key] as { criteria: Record<string, JsonValue>; instructions: string }
}

describe('shared tool catalog and conditional questions', () => {
  it('covers enabled tools through declared purposes and keeps RESPOND constant', () => {
    const mutation = {
      ...noArguments,
      name: 'reset',
      phases: ['ACT'] as const,
      effectClass: 'workspace_mutation' as const,
    }
    const surface = compileQuestions([tool, noArguments, mutation], [candidate], config)
    expect([...surface.operations.keys()]).toEqual(['INSPECT', 'ACT', 'VERIFY', 'RESPOND'])
    expect([...surface.operations.get('INSPECT')!.choices]).toEqual([
      ['read_native', { kind: 'tool', operation: 'read_native' }],
      ['job_list', { kind: 'tool', operation: 'job_list' }],
    ])
    expect(surface.operations.get('ACT')).toEqual({
      question: 'operation_ACT',
      choices: new Map([['reset', { kind: 'tool', operation: 'reset' }]]),
    })
    expect(surface.operations.get('RESPOND')).toEqual({
      question: null,
      choices: new Map([['RESPOND', { kind: 'respond' }]]),
    })
    expect(Object.keys(surface.questions)).toEqual([
      'purpose',
      'operation_INSPECT',
      'operation_ACT',
      'operation_VERIFY',
      'binding_read_native',
      'can_end',
      'ambiguity',
    ])
    expect(
      parseDecision(
        answer(surface, 'read_native', {
          binding_read_native: selected('c1', ['LLM_PARAMETERS', 'c1']),
        }),
        surface,
      ),
    ).toMatchObject({
      purpose: 'INSPECT',
      kind: 'tool',
      operation: tool.name,
      parameterMode: 'parameterized',
      bindingMode: 'selected_candidate',
      candidateId: candidate.id,
      operationConfidence: 0.9,
      bindingConfidence: 0.9,
    })
  })

  it('orders all shared definitions and criteria by the first purpose exposing each tool', () => {
    const actOnly = { ...tool, name: 'act_only', phases: ['ACT'] as const }
    const shared = { ...tool, name: 'shared', phases: ['VERIFY', 'ACT', 'INSPECT'] as const }
    const verifyOnly = { ...tool, name: 'verify_only', phases: ['VERIFY'] as const }
    const tools = [actOnly, verifyOnly, shared, tool]
    const catalog = compileDecisionTools(tools)
    expect(Object.keys(catalog)).toEqual(['shared', 'read_native', 'act_only', 'verify_only'])
    expect(catalog.shared?.purposes).toEqual(['INSPECT', 'ACT', 'VERIFY'])
    const surface = compileQuestions(tools, [], config)
    expect(surface.catalog).toEqual(catalog)
    expect(Object.keys(question(surface, 'operation_ACT').criteria)).toEqual(['shared', 'act_only'])
    expect(Object.keys(question(surface, 'operation_VERIFY').criteria)).toEqual([
      'shared',
      'read_native',
      'verify_only',
    ])
  })

  it('uses only matching profile purposes and rejects an empty effective intersection', () => {
    const profile: DecisionToolProfile = {
      operation: tool.name,
      toolRevision: '1',
      selection: 'Check a known target',
      phases: ['VERIFY'],
      inputs: 'Target path',
      result: 'Target content',
      constraints: [],
    }
    const surface = compileQuestions([tool], [candidate], config, [profile])
    expect([...surface.operations.keys()]).toEqual(['VERIFY', 'RESPOND'])
    expect(surface.questions.operation_INSPECT).toBeUndefined()
    expect(question(surface, 'purpose').criteria.VERIFY).toMatchObject({ operations: ['read_native'] })
    expect(surface.catalog.read_native).toMatchObject({
      description: profile.selection,
      inputs: profile.inputs,
      purposes: ['VERIFY'],
    })
    expect(() => compileQuestions([tool], [], config, [{ ...profile, phases: ['ACT'] }])).toThrow(
      'No available purpose',
    )
    expect(() => compileQuestions([{ ...tool, phases: [] }], [], config)).toThrow('No available purpose')
    const stale = compileQuestions([tool], [], config, [{ ...profile, toolRevision: 'old', phases: ['ACT'] }])
    expect([...stale.operations.keys()]).toEqual(['INSPECT', 'VERIFY', 'RESPOND'])
    expect(JSON.stringify(stale.catalog)).not.toContain(profile.selection)
    const { phases: _phases, ...undeclared } = tool
    expect([...compileQuestions([undeclared], [], config).operations.keys()]).toEqual([
      'INSPECT',
      'ACT',
      'VERIFY',
      'RESPOND',
    ])
  })

  it('separates control choices from colliding host tool names and object prototype keys', () => {
    const names = ['RESPOND', 'ANSWER', 'LLM_PARAMETERS', '__proto__', 'tool::read/文件']
    const tools = names.map((name) => ({ ...tool, name }))
    const candidates = names.map(
      (name, index): Candidate => ({
        ...candidate,
        tool: name,
        id: brandString<CandidateId>(index === 0 ? 'LLM_PARAMETERS' : `candidate-${name}`),
      }),
    )
    const surface = compileQuestions(tools, candidates, { ...config, maxCandidates: names.length })
    for (const name of names) {
      expect(Object.hasOwn(surface.catalog, name)).toBe(true)
      const parsed = parseDecision(
        answer(
          surface,
          name,
          {
            [`binding_${name}`]: selected('c1', ['LLM_PARAMETERS', 'c1']),
          },
          'INSPECT',
        ),
        surface,
      )
      expect(parsed.kind).toBe('tool')
      expect(parsed.operation).toBe(name)
    }
    expect(parseDecision(answer(surface, 'RESPOND'), surface).kind).toBe('respond')
  })

  it('renders lossless labeled binding lines while keeping all private evidence outside model input', () => {
    const surface = compileQuestions([tool, noArguments], [candidate], config)
    expect(question(surface, 'binding_read_native').criteria).toEqual({
      LLM_PARAMETERS:
        'operation: "read_native"\nmode: "author_parameters"\ndescription: "Keep this operation and have the language helper author all arguments when no offered complete call fits."',
      c1: 'operation: "read_native"\ndescription: "Observed read target"\narguments: {"target":"file"}',
    })
    const visible = JSON.stringify({ questions: surface.questions, catalog: surface.catalog })
    for (const hidden of [
      'private-record-id',
      'private-candidate-id',
      'private-hash',
      '/private/pointer',
      'private-epoch',
      'additionalProperties',
    ]) {
      expect(visible).not.toContain(hidden)
    }
    const plan = surface.bindings.get('binding_read_native')
    expect(plan).toMatchObject({ operation: tool.name, mode: 'parameterized' })
    expect(plan).not.toHaveProperty('purpose')
    if (plan?.mode === 'parameterized') expect([...plan.choices]).toEqual([['c1', candidate.id]])
    expect(surface.candidates.get(candidate.id)).toEqual(candidate)
  })

  it('detaches exact calls and catalog definitions from input and presentation mutation', () => {
    const supplied = { ...candidate, arguments: { target: 'original' } }
    const definition = { ...tool, parameters: { type: 'object', properties: { target: { type: 'string' } } } }
    const profile: DecisionToolProfile = {
      operation: tool.name,
      toolRevision: '1',
      selection: 'Read',
      phases: ['INSPECT'],
      inputs: 'Path',
      result: 'Content',
      constraints: ['Admitted target'],
    }
    const surface = compileQuestions([definition], [supplied], config, [profile])
    supplied.arguments.target = 'changed'
    definition.parameters.properties.target.type = 'number'
    expect(question(surface, 'binding_read_native').criteria.c1).toContain('arguments: {"target":"original"}')
    question(surface, 'binding_read_native').criteria.c1 = 'changed display'
    expect(surface.candidates.get(candidate.id)?.arguments.target).toBe('original')
    surface.catalog.read_native?.constraints?.push('Display only')
    expect(profile.constraints).toEqual(['Admitted target'])
    expect(surface.tools.get(tool.name)?.parameters).toEqual({
      type: 'object',
      properties: { target: { type: 'string' } },
    })
  })

  it('omits binding questions for no-argument and fallback-only routes without inventing scores', () => {
    const surface = compileQuestions([noArguments, tool], [], config)
    expect(surface.bindings.get('binding_job_list')).toEqual({ operation: 'job_list', mode: 'no_arguments' })
    expect(surface.bindings.get('binding_read_native')).toEqual({
      operation: tool.name,
      mode: 'parameterized',
      question: null,
      choices: new Map(),
    })
    const direct = parseDecision(answer(surface, 'job_list'), surface)
    const authored = parseDecision(answer(surface, 'read_native'), surface)
    expect(direct).toMatchObject({
      parameterMode: 'no_arguments',
      consumedQuestionIds: ['purpose', 'operation_INSPECT'],
    })
    expect(direct.bindingMode).toBeUndefined()
    expect(authored).toMatchObject({ parameterMode: 'parameterized', bindingMode: 'llm_parameters' })
    for (const result of [direct, authored]) {
      expect(result.bindingConfidence).toBeUndefined()
      expect(result.bindingProbabilities).toBeUndefined()
    }
    expect(Object.keys(surface.questions).some((key) => key.startsWith('binding_'))).toBe(false)
  })

  it('keeps singleton prerequisites in the shared catalog and requires a real operation answer', () => {
    for (const enabled of [noArguments, tool]) {
      const profile: DecisionToolProfile = {
        operation: enabled.name,
        toolRevision: enabled.revision,
        selection: 'Read permitted task evidence',
        phases: ['INSPECT'],
        inputs: 'An observed target or the native empty invocation',
        result: 'Current task evidence',
        constraints: ['The target must be inside the admitted workspace'],
      }
      const surface = compileQuestions([enabled], [], config, [profile])
      expect(Object.keys(surface.questions)).toEqual(['purpose', 'operation_INSPECT', 'can_end', 'ambiguity'])
      expect(surface.catalog[enabled.name]).toMatchObject({
        description: profile.selection,
        inputs: profile.inputs,
        result: profile.result,
        constraints: [...profile.constraints],
        effect: 'read_only',
        parameterMode: enabled === noArguments ? 'no_arguments' : 'parameterized',
      })
      expect(question(surface, 'operation_INSPECT').criteria).toEqual({
        [enabled.name]: { operation: enabled.name },
      })
      for (const value of Object.values(surface.questions)) {
        expect((value as { instructions: string }).instructions).toContain(
          'Apply the shared decision guidance in state.rules.',
        )
      }
      expect(() =>
        parseDecision(answer(surface, enabled.name, { operation_INSPECT: null }), surface),
      ).toThrow()
      expect(parseDecision(answer(surface, enabled.name), surface).operationConfidence).toBe(0.9)
    }
  })

  it('spends candidate quota once per complete invocation and never on true empty invocations', () => {
    const surface = compileQuestions(
      [noArguments],
      [{ ...candidate, tool: noArguments.name, arguments: {} }],
      { ...config, maxCandidates: 0 },
    )
    expect(surface.candidates.size).toBe(0)
    const shared = compileQuestions([tool], [candidate], { ...config, maxCandidates: 1 })
    expect(shared.candidates.size).toBe(1)
    expect(Object.keys(shared.questions).filter((key) => key.startsWith('binding_'))).toHaveLength(1)
  })

  it('keeps optional/default arguments parameterized and in competition with the language helper', () => {
    const optional: ToolDescriptor = {
      ...tool,
      parameters: {
        type: 'object',
        properties: { target: { type: 'string', default: 'file' } },
        additionalProperties: false,
      },
      defaults: {},
    }
    const surface = compileQuestions(
      [optional],
      [{ ...candidate, arguments: {}, sourceRecordIds: [] }],
      config,
    )
    expect(Object.keys(question(surface, 'binding_read_native').criteria)).toEqual(['LLM_PARAMETERS', 'c1'])
    expect(
      parseDecision(
        answer(surface, 'read_native', {
          binding_read_native: selected('LLM_PARAMETERS', ['LLM_PARAMETERS', 'c1']),
        }),
        surface,
      ),
    ).toMatchObject({ bindingMode: 'llm_parameters', parameterMode: 'parameterized' })
  })

  it('gives each question its own assumption and shared-state instructions without another answer dependency', () => {
    const surface = compileQuestions([tool, noArguments], [candidate], config)
    for (const required of [
      'state.task.requests',
      'state.rules',
      'state.operations',
      'do not assume another answer',
    ])
      expect(DECISION_GUIDANCE).toContain(required)
    for (const value of Object.values(surface.questions)) {
      const instructions = (value as { instructions: string }).instructions
      expect(instructions).toContain('Apply the shared decision guidance in state.rules.')
      expect(instructions).not.toContain(DECISION_GUIDANCE)
      expect(instructions).not.toContain('questions.operation')
    }
    for (const purpose of ['INSPECT', 'VERIFY']) {
      expect(question(surface, `operation_${purpose}`).instructions).toContain(
        `Assume the immediate purpose is ${purpose}:`,
      )
      expect(question(surface, `operation_${purpose}`).instructions).toContain(
        "Each criterion's operation names its definition in state.operations.",
      )
    }
    expect(question(surface, 'binding_read_native').instructions).toContain(
      'Assume the next operation is "read_native".',
    )
    expect(question(surface, 'binding_read_native').instructions).not.toContain(
      'Assume the immediate purpose',
    )
  })

  it('bounds emitted UTF-8 questions including one display of a shared candidate pool', () => {
    const candidates = Array.from(
      { length: 34 },
      (_, index): Candidate => ({
        ...candidate,
        id: brandString<CandidateId>(`skill-${index}`),
        arguments: { target: `skill-${index}` },
      }),
    )
    const unicode = { ...tool, description: '读取路径、返回内容' }
    const surface = compileQuestions([unicode], candidates, { ...config, maxCandidates: 34 })
    expect(Object.keys(question(surface, 'binding_read_native').criteria)).toHaveLength(35)
    const bytes = new TextEncoder().encode(JSON.stringify(surface.questions)).length
    expect(() =>
      compileQuestions([unicode], candidates, { ...config, maxCandidates: 34, maxQuestionBytes: bytes }),
    ).not.toThrow()
    expect(() =>
      compileQuestions([unicode], candidates, { ...config, maxCandidates: 34, maxQuestionBytes: bytes - 1 }),
    ).toThrow('Question byte budget')
  })

  it('rejects invalid catalog identity, stale candidates and duplicate canonical invocations', () => {
    expect(() => compileQuestions([tool, tool], [], config)).toThrow('duplicate tool')
    expect(() => compileQuestions([{ ...tool, name: '' }], [], config)).toThrow('tool name')
    for (const invalid of [
      { ...candidate, tool: 'missing' },
      { ...candidate, toolRevision: 'old' },
      { ...candidate, id: brandString<CandidateId>('') },
    ]) {
      expect(() => compileQuestions([tool], [invalid], config)).toThrow('candidate')
    }
    expect(() => compileQuestions([tool], [candidate, candidate], config)).toThrow('candidate')
    const first = { ...candidate, arguments: { path: 'note.txt', window: { offset: 1, limit: 20 } } }
    const second = {
      ...candidate,
      id: brandString<CandidateId>('different-id'),
      arguments: { window: { limit: 20, offset: 1 }, path: 'note.txt' },
    }
    expect(() => compileQuestions([tool], [first, second], config)).toThrow('Duplicate candidate invocation')
    expect(() => compileQuestions([tool], [candidate], { ...config, maxCandidates: 0 })).toThrow(
      'Candidate budget',
    )
  })
})

describe('selected path and optional equivalent-operation support', () => {
  const surface = compileQuestions([tool, noArguments], [candidate], config)
  const validBinding = selected('c1', ['LLM_PARAMETERS', 'c1'])
  const operationKeys = [...surface.operations.get('INSPECT')!.choices.keys()]
  const readAnswer = (operation: JsonValue, binding: JsonValue = validBinding): JsonValue =>
    answer(surface, 'read_native', {
      operation_INSPECT: operation,
      binding_read_native: binding,
    })

  it('retains raw P/O/B and independent path confidence without substituting support', () => {
    const parsed = parseDecision(
      answer(surface, 'read_native', {
        purpose: selected('INSPECT', [...surface.operations.keys()], 0.2),
        operation_INSPECT: selected('read_native', operationKeys, 0.95),
        binding_read_native: validBinding,
      }),
      surface,
    )
    expect(parsed).toMatchObject({
      purposeConfidence: 0.2,
      purposeProbabilities: { INSPECT: 1, VERIFY: 0, RESPOND: 0 },
      operationConfidence: 0.95,
      operationProbabilities: { read_native: 1, job_list: 0 },
      operationPathConfidence: 0.2,
      bindingConfidence: 0.9,
      equivalentSupport: 1,
      consumedQuestionIds: ['purpose', 'operation_INSPECT', 'binding_read_native'],
    })
    const lowBinding = parseDecision(
      readAnswer(selected('read_native', operationKeys, 0.7), selected('c1', ['LLM_PARAMETERS', 'c1'], 0.1)),
      surface,
    )
    expect(lowBinding.operationPathConfidence).toBe(0.7)
    expect(lowBinding.bindingConfidence).toBe(0.1)
    expect(parsed).not.toHaveProperty('confidence')
  })

  it('uses the same frozen binding under every purpose without changing selected operation or arguments', () => {
    const second = {
      ...candidate,
      id: brandString<CandidateId>('verification-target'),
      arguments: { target: 'result' },
    }
    const shared = compileQuestions([tool], [candidate, second], config)
    const binding = { binding_read_native: selected('c2', ['LLM_PARAMETERS', 'c1', 'c2']) }
    for (const purpose of ['INSPECT', 'VERIFY'] as const) {
      const parsed = parseDecision(answer(shared, 'read_native', binding, purpose), shared)
      expect(parsed.candidateId).toBe(second.id)
      expect(parsed.operation).toBe('read_native')
      expect(parsed.consumedQuestionIds).toEqual(['purpose', `operation_${purpose}`, 'binding_read_native'])
    }
  })

  it('sums only matching valid work-head Purpose mass, without confidence weighting or RESPOND mass', () => {
    const shared = compileQuestions(
      [
        { ...tool, phases: ['INSPECT', 'ACT', 'VERIFY'] },
        { ...noArguments, phases: ['INSPECT', 'ACT', 'VERIFY'] },
      ],
      [candidate],
      config,
    )
    const parsed = parseDecision(
      answer(shared, 'read_native', {
        purpose: {
          choice: 'INSPECT',
          confidence: 0.2,
          probabilities: { INSPECT: 0.4, ACT: 0.3, VERIFY: 0.2, RESPOND: 0.1 },
        },
        operation_INSPECT: selected('read_native', operationKeys, 0.7),
        operation_ACT: selected('read_native', operationKeys, 0.01),
        operation_VERIFY: selected('job_list', operationKeys, 0.99),
        binding_read_native: validBinding,
      }),
      shared,
    )
    expect(parsed.equivalentSupport).toBeCloseTo(0.7)
    expect(parsed.operationBranches).toEqual([
      { purpose: 'INSPECT', question: 'operation_INSPECT', operation: 'read_native', confidence: 0.7 },
      { purpose: 'ACT', question: 'operation_ACT', operation: 'read_native', confidence: 0.01 },
      { purpose: 'VERIFY', question: 'operation_VERIFY', operation: 'job_list', confidence: 0.99 },
    ])
    expect(parsed.invalidOperationBranches).toEqual([])
    expect(parsed.consumedQuestionIds).toEqual(['purpose', 'operation_INSPECT', 'binding_read_native'])
    expect(parsed.candidateId).toBe(candidate.id)
  })

  it('keeps RESPOND constant with no operation score, support rescue or binding consumption', () => {
    for (const enabled of [[], [noArguments]]) {
      const constant = compileQuestions(enabled, [], config)
      const response = parseDecision(
        answer(constant, 'RESPOND', {
          purpose: selected('RESPOND', [...constant.operations.keys()], 0.3),
          operation_RESPOND: 'malformed',
        }),
        constant,
      )
      expect(response).toMatchObject({
        kind: 'respond',
        purposeConfidence: 0.3,
        operationConfidence: null,
        operationProbabilities: null,
        equivalentSupport: null,
        operationPathConfidence: 0.3,
        consumedQuestionIds: ['purpose'],
      })
      expect(response.bindingConfidence).toBeUndefined()
    }
  })

  it('does not let invalid unused answers poison the selected path or contribute support', () => {
    const parsed = parseDecision(
      answer(surface, 'read_native', {
        purpose: {
          choice: 'INSPECT',
          confidence: 0.9,
          probabilities: { INSPECT: 0.5, VERIFY: 0.4, RESPOND: 0.1 },
        },
        binding_read_native: validBinding,
        operation_VERIFY: {
          choice: 'read_native',
          confidence: 1,
          probabilities: { read_native: 0.2, job_list: 0.8 },
        },
      }),
      surface,
    )
    expect(parsed.equivalentSupport).toBe(0.5)
    expect(parsed.invalidOperationBranches).toEqual([
      { purpose: 'VERIFY', question: 'operation_VERIFY', error: 'operation_VERIFY: choice is not an argmax' },
    ])
    expect(
      parseDecision(
        answer(surface, 'RESPOND', { binding_read_native: 'malformed', operation_VERIFY: 'bad' }),
        surface,
      ).kind,
    ).toBe('respond')
    expect(
      parseDecision(answer(surface, 'job_list', { binding_read_native: 'malformed' }), surface).parameterMode,
    ).toBe('no_arguments')
    expect(() =>
      parseDecision(readAnswer(selected('read_native', operationKeys), 'malformed'), surface),
    ).toThrow()
  })

  it('requires a valid offered Purpose even when an operation answer is valid', () => {
    const valid = answer(surface, 'job_list') as { answers: Record<string, JsonValue> }
    const { purpose: _purpose, ...withoutPurpose } = valid.answers
    expect(() => parseDecision({ answers: withoutPurpose }, surface)).toThrow()
    for (const purpose of [
      null,
      'bad',
      selected('ACT', [...surface.operations.keys()]),
      selected('INSPECT', ['INSPECT']),
      selected('INSPECT', [...surface.operations.keys()], NaN),
    ]) {
      expect(() => parseDecision({ answers: { ...withoutPurpose, purpose } }, surface)).toThrow()
    }
  })

  it('rejects malformed selected operations, distributions and non-argmax choices', () => {
    const good = selected('read_native', operationKeys) as Record<string, JsonValue>
    const cases: JsonValue[] = [
      null,
      [],
      'bad',
      { ...good, type: 'score' },
      { ...good, choice: 'unavailable' },
      { ...good, confidence: -1 },
      { ...good, confidence: 2 },
      { ...good, confidence: Infinity },
      { ...good, probabilities: [] },
      { ...good, probabilities: {} },
      ...['1', NaN, 0.5, 0.2].map((value) => ({
        ...good,
        probabilities: { read_native: value, job_list: value === 0.2 ? 0.8 : 0 },
      })),
    ]
    for (const operation of cases) expect(() => parseDecision(readAnswer(operation), surface)).toThrow()
    for (const output of [null, [], {}, { answers: [] }])
      expect(() => parseDecision(output, surface)).toThrow()
    expect(() =>
      parseDecision(
        readAnswer(good, { choice: 'c1', confidence: 0.9, probabilities: { c1: 0.2, LLM_PARAMETERS: 0.8 } }),
        surface,
      ),
    ).toThrow('argmax')
  })

  it('keeps malformed diagnostics unavailable and accepts progress only when explicitly requested', () => {
    for (const extra of [
      {},
      { ambiguity: { noul: 9 }, can_end: 'bad' },
      { ambiguity: { noul: NaN }, can_end: { noul: Infinity } },
      { ambiguity: { type: 'score', noul: 0.1 }, can_end: { type: 'choice', noul: 0.5 } },
    ]) {
      const parsed = parseDecision(answer(surface, 'RESPOND', extra), surface)
      expect(parsed.ambiguity).toBeUndefined()
      expect(parsed.canEnd).toBeUndefined()
    }
    const signals = {
      ambiguity: { type: 'noul', noul: 0.1 },
      can_end: { type: 'noul', noul: 0.2 },
      meta_progress: { type: 'score', score: 2.5 },
    }
    const diagnostic = parseDecision(answer(surface, 'RESPOND', signals), surface)
    expect(diagnostic).toMatchObject({ ambiguity: 0.1, canEnd: 0.2 })
    expect(diagnostic.progress).toBeUndefined()
    const review = compileQuestions([tool], [], {
      ...config,
      responseReviewMode: 'review',
      answerProgressFloor: 2,
    })
    expect(Object.keys(review.questions).at(-1)).toBe('meta_progress')
    expect(parseDecision(answer(review, 'RESPOND', signals), review).progress).toBe(2.5)
    expect(
      parseDecision(answer(review, 'RESPOND', { can_end: { noul: 1 } }), review).progress,
    ).toBeUndefined()
  })
})
