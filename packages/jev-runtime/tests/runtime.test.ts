import { describe, expect, it } from 'vitest'
import { brandString } from '../src/brand.js'
import type {
  Candidate,
  CandidateId,
  DecisionInput,
  DecisionToolProfile,
  EnvironmentEpoch,
  InputFact,
  JsonValue,
  LanguageInput,
  ModelSettlement,
  PreparedModelCall,
  RecordId,
  RuntimeConfig,
  RuntimeLedger,
  RuntimePorts,
  RuntimeRecord,
  ToolDescriptor,
  ToolOutcome,
  TurnId,
} from '../src/index.js'
import {
  AcceptedAnswers,
  compileQuestions,
  InvalidAuthoredArguments,
  openJevRuntime,
  parseDecision,
  replayRecords,
  StaleCandidate,
} from '../src/index.js'

const turn = brandString<TurnId>('turn-1')
const epoch = brandString<EnvironmentEpoch>('epoch-1')
const tool: ToolDescriptor = {
  name: 'native_tool',
  description: 'Use an enabled host tool',
  parameters: { type: 'object' },
  output: { type: 'object' },
  revision: 'v1',
  effectClass: 'workspace_mutation',
  phases: ['ACT'],
}
const config: RuntimeConfig = {
  maxSteps: 3,
  maxModelAttempts: 6,
  maxNoProgress: 2,
  maxRepeatedFailures: 2,
  maxCandidates: 4,
  maxHistory: 20,
  maxQuestionBytes: 10_000,
  maxOutputBytes: 100_000,
  escalateBelow: 0.6,
  mutationEscalateBelow: 0.6,
  bindingBelow: 0.6,
  equivalentSupportThreshold: 0.8,
  ambiguityGate: null,
  answerProgressFloor: null,
  responseReviewMode: 'diagnostic',
  maxResponseReviewAttempts: 2,
}
const input: InputFact = { id: 'u1', source: 'user', content: [{ kind: 'text', text: 'do it' }] }
const outcome: ToolOutcome = {
  kind: 'success',
  value: { done: true },
  content: [{ kind: 'text', text: 'done' }],
  directive: { conclude: true, additions: [] },
}
const invalidHelper: ModelSettlement = {
  error: {
    code: 'LANGUAGE_INVALID_JSON',
    message: 'Language helper did not return one valid JSON value',
    retryable: true,
  },
  snapshot: { codec: 'dsh-assistant-stream-v1', response: { text: 'DSML call list' } },
}

function choice(selected: string, names: readonly string[], confidence = 0.9): JsonValue {
  return {
    type: 'choice',
    choice: selected,
    confidence,
    probabilities: Object.fromEntries(names.map((name) => [name, name === selected ? 1 : 0])),
  }
}

function bindingValue(value: JsonValue | undefined): Record<string, JsonValue> {
  if (typeof value !== 'string') throw new Error('Expected labeled binding lines')
  return Object.fromEntries(
    value.split('\n').map((line) => {
      const separator = line.indexOf(': ')
      return [line.slice(0, separator), JSON.parse(line.slice(separator + 2)) as JsonValue]
    }),
  )
}

function decision(questions: JsonValue, binding?: string, confidence = 0.9): JsonValue {
  return decisionAnswers(questions as Record<string, JsonValue>, {
    binding,
    purposeConfidence: confidence,
    operationConfidence: confidence,
  })
}

function decisionAnswers(
  questions: Record<string, JsonValue>,
  options: {
    purpose?: 'INSPECT' | 'ACT' | 'VERIFY' | 'RESPOND'
    operation?: string
    purposeConfidence?: number | undefined
    purposeProbabilities?: Record<string, number>
    operationConfidence?: number | undefined
    binding?: string | undefined
    bindingConfidence?: number | undefined
  } = {},
): JsonValue {
  const purpose = options.purpose ?? 'ACT'
  const answers: Record<string, JsonValue> = {
    purpose: choice(
      purpose,
      Object.keys((questions.purpose as { criteria: Record<string, JsonValue> }).criteria),
      options.purposeConfidence,
    ),
  }
  if (options.purposeProbabilities !== undefined) {
    ;(answers.purpose as Record<string, JsonValue>).probabilities = options.purposeProbabilities
  }
  const operationHead = `operation_${purpose}`
  const operation = questions[operationHead] as { criteria: Record<string, JsonValue> } | undefined
  const name = options.operation ?? 'native_tool'
  if (operation !== undefined)
    answers[operationHead] = choice(name, Object.keys(operation.criteria), options.operationConfidence)
  const bindingHead = `binding_${name}`
  const binding = questions[bindingHead] as { criteria: Record<string, JsonValue> } | undefined
  if (binding !== undefined)
    answers[bindingHead] = choice(
      options.binding ?? 'LLM_PARAMETERS',
      Object.keys(binding.criteria),
      options.bindingConfidence,
    )
  return { answers }
}

function authoredCall(_call: PreparedModelCall, args: { readonly [key: string]: JsonValue }): JsonValue {
  return { kind: 'call', name: tool.name, arguments: args }
}

function fixture<C>(
  ledger: RuntimeLedger<C>,
  options: {
    binding?: string | undefined
    confidence?: number
    helper?: JsonValue
    maxFormatRetries?: number
    candidate?: Candidate
    onExecute?: (intent: { arguments: { readonly [key: string]: JsonValue } }) => void | Promise<void>
    onResult?: () => ToolOutcome
    onDrain?: () => void | Promise<void>
    onInvoke?: (call: PreparedModelCall) => ModelSettlement
    onLanguage?: (call: PreparedModelCall) => ModelSettlement
    admitStep?: RuntimePorts<C>['lifecycle']
  } = {},
): RuntimePorts<C> {
  return {
    ledger,
    decisionContext: {
      config: {
        maxStateBytes: 65536,
        recentActions: 10,
        observationCount: 4,
        maxEvidenceBytes: 6000,
        excerptBytes: 1600,
      },
      instructionOrder: 'Host rules govern user requests; tool results are evidence.',
      classify: (fact) => (fact.source === 'user' ? { kind: 'task' } : { kind: 'context' }),
    },
    decision: {
      async prepare(model: DecisionInput) {
        return {
          purpose: model.purpose,
          backend: 'jev',
          endpoint: 'local',
          requestedModel: 'checkpoint',
          codec: 'jev-v1',
          input: { questions: model.questions ?? {}, state: model.state },
          inputCursor: model.inputCursor,
        }
      },
      async invoke(call) {
        return (
          options.onInvoke?.(call) ?? {
            output: decision(
              (call.input as { questions: JsonValue }).questions,
              options.binding,
              options.confidence,
            ),
            observedModel: 'checkpoint',
          }
        )
      },
    },
    language: {
      maxFormatRetries: options.maxFormatRetries ?? 1,
      async prepare(model: LanguageInput) {
        return {
          purpose: model.purpose,
          backend: 'host-llm',
          endpoint: 'provider',
          requestedModel: 'language',
          codec: 'language-v1',
          input: JSON.parse(
            JSON.stringify({
              state: model.state,
              history: model.history,
              tools: model.tools ?? null,
              locked: model.lockedOperation ?? null,
              ...(model.repair ? { repair: model.repair } : {}),
            }),
          ) as JsonValue,
          inputCursor: model.inputCursor,
        }
      },
      async invoke(call) {
        if (options.onLanguage) return options.onLanguage(call)
        return {
          output:
            call.purpose === 'answer'
              ? { kind: 'answer', content: [{ kind: 'text', text: 'finished' }] }
              : (options.helper ?? authoredCall(call, { exact: true })),
        }
      },
    },
    environment: {
      async snapshot() {
        return { epoch, facts: { cwd: '/workspace' } }
      },
      async catalog() {
        return [tool]
      },
      async validate(_tool, args) {
        if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new Error('invalid args')
        return args
      },
      async execute(intent) {
        await options.onExecute?.(intent)
        return options.onResult?.() ?? outcome
      },
      async drain() {
        await options.onDrain?.()
      },
    },
    artifacts: {
      async put(bytes) {
        return { id: 'artifact', digest: 'digest', size: bytes.length, mediaType: 'application/octet-stream' }
      },
      async read(ref) {
        return new Uint8Array(ref.size)
      },
      async retain() {},
      async release() {},
    },
    semantics: {
      candidates() {
        return options.candidate ? [options.candidate] : []
      },
      observations() {
        return []
      },
      effectDisposition() {
        return undefined
      },
    },
    ...(options.admitStep ? { lifecycle: options.admitStep } : {}),
  }
}

function ledgerA() {
  const entries: { offset: number; payload: RuntimeRecord }[] = []
  const ledger: RuntimeLedger<number> = {
    async read() {
      return entries.map((entry) => ({ cursor: entry.offset, record: entry.payload }))
    },
    async commit(record) {
      const offset = entries.length + 1
      entries.push({ offset, payload: record })
      return offset
    },
    cursorText(cursor) {
      return `seq:${cursor}`
    },
  }
  return { entries, ledger }
}

function ledgerB() {
  const entries: { envelope: { item: RuntimeRecord }; position: { shard: string; offset: number } }[] = []
  const ledger: RuntimeLedger<{ shard: string; offset: number }> = {
    async read() {
      return entries.map((entry) => ({ cursor: entry.position, record: entry.envelope.item }))
    },
    async commit(record) {
      const position = { shard: 's1', offset: entries.length + 1 }
      entries.push({ envelope: { item: record }, position })
      return position
    },
    cursorText(cursor) {
      return `${cursor.shard}:${cursor.offset}`
    },
  }
  return { entries, ledger }
}

function gateAnswer(
  call: PreparedModelCall,
  options: {
    respond?: boolean
    purposeConfidence?: number | undefined
    purposeProbabilities?: Record<string, number>
    operationConfidence?: number | undefined
    bindingConfidence?: number | undefined
    ambiguity?: number
    progress?: number
  } = {},
): ModelSettlement {
  const questions = (call.input as { questions: Record<string, JsonValue> }).questions
  const result = decisionAnswers(questions, {
    purpose: options.respond ? 'RESPOND' : 'ACT',
    ...(options.purposeProbabilities === undefined
      ? {}
      : { purposeProbabilities: options.purposeProbabilities }),
    purposeConfidence: options.purposeConfidence ?? options.operationConfidence,
    operationConfidence: options.operationConfidence,
    binding: 'c1',
    bindingConfidence: options.bindingConfidence,
  }) as { answers: Record<string, JsonValue> }
  if (options.ambiguity !== undefined) result.answers.ambiguity = { type: 'noul', noul: options.ambiguity }
  if (options.progress !== undefined)
    result.answers.meta_progress = { type: 'score', score: options.progress }
  return { output: result }
}

function resources(records: readonly RuntimeRecord[], kind: string): readonly Record<string, JsonValue>[] {
  return records.flatMap((record) =>
    record.kind === 'resource.observed' &&
    record.resource !== null &&
    typeof record.resource === 'object' &&
    !Array.isArray(record.resource) &&
    record.resource.kind === kind
      ? [record.resource]
      : [],
  )
}

describe('operation gates and parameter routes', () => {
  const noArguments: ToolDescriptor = {
    ...tool,
    effectClass: 'read_only',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  }

  it('dispatches a true no-argument tool after admission without a binding or language request', async () => {
    const { ledger } = ledgerA()
    let validations = 0
    let executions = 0
    const base = fixture(ledger, {
      onInvoke(call) {
        expect(
          (call.input as { questions: Record<string, JsonValue> }).questions['binding_native_tool'],
        ).toBeUndefined()
        return gateAnswer(call)
      },
      onLanguage() {
        throw new Error('No-argument invocation asked for authored parameters')
      },
      onExecute(intent) {
        executions++
        expect(intent.arguments).toEqual({})
      },
    })
    const runtime = await openJevRuntime(
      {
        ...base,
        environment: {
          ...base.environment,
          async catalog() {
            return [noArguments]
          },
          async validate(descriptor, args, preconditions) {
            validations++
            return base.environment.validate(descriptor, args, preconditions)
          },
        },
        semantics: {
          ...base.semantics!,
          candidates() {
            throw new Error('No-argument tool consumed candidate generation')
          },
        },
      },
      config,
    )
    expect((await runtime.run(turn, [input])).status).toBe('completed')
    expect(executions).toBe(1)
    expect(validations).toBe(2)
    const records = (await ledger.read()).map((entry) => entry.record)
    expect(
      records.filter((record) => record.kind === 'model.requested').map((record) => record.call.purpose),
    ).toEqual(['decision'])
    expect(resources(records, 'jev.candidate.route.v1')).toMatchObject([
      {
        route: 'direct',
        reason: 'no_arguments',
        bindingConfidence: null,
        candidateId: null,
        parameterMode: 'no_arguments',
      },
    ])
    expect(resources(records, 'jev.decision.route.v1')).toMatchObject([
      {
        purpose: 'ACT',
        purposeConfidence: 0.9,
        operationConfidence: 0.9,
        operationPathConfidence: 0.9,
        bindingConfidence: null,
      },
    ])
    expect(records.filter((record) => record.kind === 'action.dispatching')).toHaveLength(1)
  })

  it('rejects an absent Purpose without accepting a plausible operation answer', async () => {
    const { ledger } = ledgerA()
    const runtime = await openJevRuntime(
      fixture(ledger, {
        onInvoke() {
          return { output: { answers: { operation_ACT: choice('native_tool', ['native_tool']) } } }
        },
        onLanguage() {
          throw new Error('Invalid-decision budget should stop before arbitration')
        },
        onExecute() {
          throw new Error('Missing Purpose authorized a dispatch')
        },
      }),
      { ...config, maxRepeatedFailures: 1 },
    )
    expect((await runtime.run(turn, [input])).status).toBe('budget')
    const records = (await ledger.read()).map((entry) => entry.record)
    expect(resources(records, 'jev.runtime.feedback.v1')).toMatchObject([
      { code: 'INVALID_DECISION', languageVisible: false },
    ])
    expect(
      records.some((record) => record.kind === 'decision.selected' || record.kind === 'action.dispatching'),
    ).toBe(false)
  })

  it('arbitrates low Purpose confidence when equivalent support is also insufficient', async () => {
    const { ledger } = ledgerA()
    const purposes: string[] = []
    const base = fixture(ledger, {
      onInvoke(call) {
        return gateAnswer(call, {
          purposeConfidence: 0.2,
          operationConfidence: 0.99,
          purposeProbabilities: { ACT: 0.55, RESPOND: 0.45 },
        })
      },
      onLanguage(call) {
        purposes.push(call.purpose)
        return { output: authoredCall(call, {}) }
      },
    })
    const runtime = await openJevRuntime(
      {
        ...base,
        environment: {
          ...base.environment,
          async catalog() {
            return [tool, { ...tool, name: 'alternate_tool' }]
          },
        },
      },
      config,
    )
    expect((await runtime.run(turn, [input])).status).toBe('completed')
    expect(purposes).toEqual(['arbitration'])
    const records = (await ledger.read()).map((entry) => entry.record)
    expect(resources(records, 'jev.decision.route.v1')).toMatchObject([
      { purposeConfidence: 0.2, operationConfidence: 0.99, operationPathConfidence: 0.2 },
    ])
    expect(records.filter((record) => record.kind === 'decision.selected')).toMatchObject([
      { source: 'jev', phase: 'ACT', confidence: 0.2 },
      { source: 'llm_arbitration', phase: 'UNSPECIFIED' },
    ])
  })

  it.each([0.9, 0.2])(
    'uses equivalent support without changing the selected tool or binding threshold %s',
    async (bindingConfidence) => {
      const { ledger } = ledgerA()
      const candidate: Candidate = {
        id: brandString<CandidateId>('supported'),
        tool: tool.name,
        label: 'Exact call',
        arguments: { from: 'candidate' },
        sourceRecordIds: [],
        environmentEpoch: epoch,
        toolRevision: tool.revision,
      }
      const helperPurposes: string[] = []
      const decisionStates: Record<string, JsonValue>[] = []
      const base = fixture(ledger, {
        candidate,
        onInvoke(call) {
          const body = call.input as {
            questions: Record<string, JsonValue>
            state: Record<string, JsonValue>
          }
          decisionStates.push(body.state)
          const output = decisionAnswers(body.questions, {
            purpose: 'ACT',
            purposeConfidence: 0.2,
            purposeProbabilities: { INSPECT: 0.3, ACT: 0.4, VERIFY: 0.2, RESPOND: 0.1 },
            operationConfidence: 0.9,
            binding: 'c1',
            bindingConfidence,
          }) as { answers: Record<string, JsonValue> }
          for (const purpose of ['INSPECT', 'VERIFY'])
            output.answers[`operation_${purpose}`] = choice(tool.name, [tool.name], 0.01)
          return { output }
        },
        onLanguage(call) {
          helperPurposes.push(call.purpose)
          expect((call.input as { locked: string }).locked).toBe(tool.name)
          return { output: authoredCall(call, { from: 'helper' }) }
        },
        onExecute(intent) {
          expect(intent.arguments).toEqual({ from: bindingConfidence < 0.6 ? 'helper' : 'candidate' })
        },
      })
      const runtime = await openJevRuntime(
        {
          ...base,
          environment: {
            ...base.environment,
            async catalog() {
              return [{ ...tool, phases: ['INSPECT', 'ACT', 'VERIFY'] }]
            },
          },
        },
        { ...config, maxQuestionBytes: 30_000 },
      )
      const result = await runtime.run(turn, [input])
      expect(Object.keys(decisionStates[0]!)).toEqual([
        'rules',
        'environment',
        'history',
        'pending',
        'task',
        'operations',
      ])
      expect(decisionStates[0]?.task).toEqual({ requests: ['do it'] })
      expect(result.status, result.reason).toBe('completed')
      expect(helperPurposes).toEqual(bindingConfidence < 0.6 ? ['parameters'] : [])
      const records = (await ledger.read()).map((entry) => entry.record)
      expect(resources(records, 'jev.decision.route.v1')).toMatchObject([
        {
          purpose: 'ACT',
          operation: tool.name,
          purposeConfidence: 0.2,
          operationConfidence: 0.9,
          operationPathConfidence: 0.2,
          supportApplied: true,
          bindingConfidence,
          consumedQuestionIds: ['purpose', 'operation_ACT', 'binding_native_tool'],
          reasons: [],
        },
      ])
      expect(resources(records, 'jev.decision.route.v1')[0]?.equivalentSupport).toBeCloseTo(0.9)
      expect(resources(records, 'jev.candidate.route.v1')).toMatchObject([
        { route: bindingConfidence < 0.6 ? 'parameters' : 'direct' },
      ])
    },
  )

  it('keeps low-P RESPOND in arbitration even with high completion diagnostics', async () => {
    const { ledger } = ledgerA()
    const purposes: string[] = []
    const runtime = await openJevRuntime(
      fixture(ledger, {
        onInvoke(call) {
          const questions = (call.input as { questions: Record<string, JsonValue> }).questions
          const output = decisionAnswers(questions, { purpose: 'RESPOND', purposeConfidence: 0.2 }) as {
            answers: Record<string, JsonValue>
          }
          output.answers.can_end = { noul: 1 }
          output.answers.operation_ACT = choice(tool.name, [tool.name])
          return { output }
        },
        onLanguage(call) {
          purposes.push(call.purpose)
          return {
            output:
              call.purpose === 'arbitration'
                ? { kind: 'answer' }
                : { kind: 'answer', content: [{ kind: 'text', text: 'finished' }] },
          }
        },
        onExecute() {
          throw new Error('RESPOND executed a tool')
        },
      }),
      config,
    )
    expect((await runtime.run(turn, [input])).status).toBe('completed')
    expect(purposes).toEqual(['arbitration', 'answer'])
    expect(
      resources(
        (await ledger.read()).map((entry) => entry.record),
        'jev.decision.route.v1',
      ),
    ).toMatchObject([{ equivalentSupport: null, supportApplied: false, reasons: ['low_confidence'] }])
  })

  it.each(['unavailable', 'disabled'])(
    'rejects arbitration calls for unavailable tools: %s',
    async (name) => {
      const { ledger } = ledgerA()
      const runtime = await openJevRuntime(
        fixture(ledger, {
          confidence: 0.2,
          onLanguage() {
            return { output: { kind: 'call', name, arguments: {} } }
          },
          onExecute() {
            throw new Error('Unavailable tool dispatched')
          },
        }),
        { ...config, maxRepeatedFailures: 1 },
      )
      expect((await runtime.run(turn, [input])).status).toBe('budget')
      const records = (await ledger.read()).map((entry) => entry.record)
      expect(resources(records, 'jev.runtime.feedback.v1')).toMatchObject([{ code: 'INVALID_ARBITRATION' }])
      expect(records.some((record) => record.kind === 'action.intended')).toBe(false)
    },
  )

  it('lets the LLM select another enabled tool and returns the next step to Jev', async () => {
    const { ledger } = ledgerA()
    const read: ToolDescriptor = { ...tool, name: 'read', effectClass: 'read_only', phases: ['INSPECT'] }
    let decisions = 0
    const base = fixture(ledger, {
      onInvoke(call) {
        const questions = (call.input as { questions: Record<string, JsonValue> }).questions
        return {
          output: decisionAnswers(
            questions,
            ++decisions === 1 ? { operationConfidence: 0.2 } : { purpose: 'RESPOND' },
          ),
        }
      },
      onLanguage(call) {
        if (call.purpose === 'answer')
          return { output: { kind: 'answer', content: [{ kind: 'text', text: 'Read complete.' }] } }
        expect(call.purpose).toBe('arbitration')
        expect(call.input).toMatchObject({ locked: null })
        const state = (call.input as { state: Record<string, JsonValue> }).state
        for (const field of ['escalation', 'reasons', 'purposeOperations', 'responseReview'])
          expect(state).not.toHaveProperty(field)
        return { output: { kind: 'call', name: read.name, arguments: { path: 'note.txt' } } }
      },
      onExecute(intent) {
        expect(intent.arguments).toEqual({ path: 'note.txt' })
      },
      onResult() {
        return { ...outcome, directive: { conclude: false, additions: [] } }
      },
    })
    const runtime = await openJevRuntime(
      {
        ...base,
        environment: {
          ...base.environment,
          async catalog() {
            return [tool, read]
          },
        },
      },
      config,
    )
    expect((await runtime.run(turn, [input])).status).toBe('completed')
    const records = (await ledger.read()).map((entry) => entry.record)
    expect(
      records.filter((record) => record.kind === 'model.requested').map((record) => record.call.purpose),
    ).toEqual(['decision', 'arbitration', 'decision', 'answer'])
    expect(
      records.filter((record) => record.kind === 'decision.selected' && record.source === 'llm_arbitration'),
    ).toMatchObject([{ phase: 'UNSPECIFIED', operation: read.name }])
    expect(records.filter((record) => record.kind === 'action.dispatching')).toHaveLength(1)
  })

  it('resumes a v4 prefix with a settled legacy arbitration proposal without executing that proposal', async () => {
    const { entries, ledger } = ledgerA()
    const initial = await openJevRuntime(fixture(ledger, { confidence: 0.2 }), config)
    expect((await initial.run(turn, [input])).status).toBe('completed')
    await initial.close()
    const request = entries.find(
      (entry) => entry.payload.kind === 'model.requested' && entry.payload.call.purpose === 'arbitration',
    )
    if (request === undefined) throw new Error('Missing arbitration request')
    const index = entries.findIndex(
      (entry) => entry.payload.kind === 'model.settled' && entry.payload.requested === request.payload.id,
    )
    const settled = entries[index]?.payload
    if (settled?.kind !== 'model.settled') throw new Error('Missing arbitration settlement')
    entries[index]!.payload = {
      ...settled,
      settlement: {
        output: {
          kind: 'call',
          name: tool.name,
          arguments: { legacy: true },
          stepPurpose: 'ACT',
        },
      },
    }
    entries.splice(index + 1)
    const legacy = structuredClone(entries)
    let executions = 0
    const resumed = await openJevRuntime(
      fixture(ledger, {
        confidence: 0.2,
        onLanguage() {
          return { output: { kind: 'call', name: tool.name, arguments: { current: true } } }
        },
        onExecute(intent) {
          executions++
          expect(intent.arguments).toEqual({ current: true })
        },
      }),
      config,
    )
    expect((await resumed.run(turn, [])).status).toBe('completed')
    expect(executions).toBe(1)
    expect(entries.slice(0, legacy.length)).toEqual(legacy)
    expect(
      entries.flatMap((entry) => (entry.payload.kind === 'run.opened' ? [entry.payload.runtimeVersion] : [])),
    ).toEqual(['4'])
  })

  it('consumes the shared tool binding across purposes while ignoring an invalid unused operation', async () => {
    const { ledger } = ledgerA()
    const read: ToolDescriptor = {
      ...tool,
      name: 'read',
      effectClass: 'read_only',
      phases: ['INSPECT', 'VERIFY'],
    }
    const calls: JsonValue[] = []
    const candidates: Candidate[] = ['inspect.txt', 'verify.txt'].map((path, index) => ({
      id: brandString<CandidateId>(`read-${index}`),
      tool: read.name,
      toolRevision: read.revision,
      environmentEpoch: epoch,
      sourceRecordIds: [],
      label: `Read ${path}`,
      arguments: { path },
    }))
    let decisions = 0
    const base = fixture(ledger, {
      onInvoke(call) {
        const questions = (call.input as { questions: Record<string, JsonValue> }).questions
        const purpose = ++decisions === 1 ? 'INSPECT' : 'VERIFY'
        expect(questions['operation_INSPECT']).toBeDefined()
        expect(questions['operation_VERIFY']).toBeDefined()
        expect(questions['binding_read']).toBeDefined()
        expect(Object.keys(questions).filter((key) => key.startsWith('binding_'))).toEqual(['binding_read'])
        const output = decisionAnswers(questions, {
          purpose,
          operation: read.name,
          binding: decisions === 1 ? 'c1' : 'c2',
        }) as { answers: Record<string, JsonValue> }
        output.answers[`operation_${purpose === 'INSPECT' ? 'VERIFY' : 'INSPECT'}`] = {
          type: 'choice',
          choice: 'invalid-unselected',
        }
        return { output }
      },
      onLanguage() {
        throw new Error('An unselected branch caused escalation')
      },
      onExecute(intent) {
        calls.push(intent.arguments)
      },
      onResult() {
        return { ...outcome, directive: { conclude: calls.length === 2, additions: [] } }
      },
    })
    const runtime = await openJevRuntime(
      {
        ...base,
        environment: {
          ...base.environment,
          async catalog() {
            return [read]
          },
        },
        semantics: {
          ...base.semantics!,
          candidates() {
            return candidates
          },
        },
      },
      config,
    )
    expect((await runtime.run(turn, [input])).status).toBe('completed')
    expect(calls).toEqual([{ path: 'inspect.txt' }, { path: 'verify.txt' }])
    expect(
      (await ledger.read()).flatMap((entry) =>
        entry.record.kind === 'decision.selected' ? [entry.record.phase] : [],
      ),
    ).toEqual(['INSPECT', 'VERIFY'])
  })

  it('keeps an optional default invocation in competition with full parameter generation', async () => {
    const { ledger } = ledgerA()
    const optional: ToolDescriptor = {
      ...tool,
      defaults: {},
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', default: 10 } },
        additionalProperties: false,
      },
    }
    const base = fixture(ledger, {
      onInvoke(call) {
        const questions = (call.input as { questions: Record<string, JsonValue> }).questions
        expect(
          Object.keys((questions['binding_native_tool'] as { criteria: Record<string, JsonValue> }).criteria),
        ).toEqual(['LLM_PARAMETERS', 'c1'])
        return { output: decision(questions, 'LLM_PARAMETERS') }
      },
      onLanguage(call) {
        expect(call.purpose).toBe('parameters')
        expect((call.input as { locked: string }).locked).toBe(tool.name)
        return { output: authoredCall(call, { limit: 5 }) }
      },
      onExecute(intent) {
        expect(intent.arguments).toEqual({ limit: 5 })
      },
    })
    const runtime = await openJevRuntime(
      {
        ...base,
        environment: {
          ...base.environment,
          async catalog() {
            return [optional]
          },
        },
      },
      config,
    )
    const result = await runtime.run(turn, [input])
    expect(result.status, result.reason).toBe('completed')
  })

  it.each([0.9, 0.2])(
    'arbitrates low read-only O despite low ambiguity and binding confidence %s',
    async (bindingConfidence) => {
      const { ledger } = ledgerA()
      const candidate: Candidate = {
        id: brandString<CandidateId>('bound'),
        tool: tool.name,
        label: 'Complete call',
        arguments: { from: 'candidate' },
        sourceRecordIds: [],
        environmentEpoch: epoch,
        toolRevision: tool.revision,
      }
      const purposes: string[] = []
      const base = fixture(ledger, {
        candidate,
        onInvoke(call) {
          return gateAnswer(call, { operationConfidence: 0.2, bindingConfidence, ambiguity: 0.1 })
        },
        onLanguage(call) {
          purposes.push(call.purpose)
          expect((call.input as { locked: string | null }).locked).toBeNull()
          return { output: authoredCall(call, { from: 'helper' }) }
        },
        onExecute(intent) {
          expect(intent.arguments).toEqual({ from: 'helper' })
        },
      })
      const runtime = await openJevRuntime(
        {
          ...base,
          environment: {
            ...base.environment,
            async catalog() {
              return [{ ...tool, effectClass: 'read_only' }]
            },
          },
        },
        config,
      )
      const result = await runtime.run(turn, [input])
      expect(result.status, result.reason).toBe('completed')
      expect(purposes).toEqual(['arbitration'])
      expect(
        resources(
          (await ledger.read()).map((entry) => entry.record),
          'jev.candidate.route.v1',
        ),
      ).toMatchObject([{ route: 'arbitration', reason: 'low_confidence', bindingConfidence }])
    },
  )

  it('arbitrates a low-confidence mutation even with no arguments and low ambiguity', async () => {
    const { ledger } = ledgerA()
    const purposes: string[] = []
    const base = fixture(ledger, {
      onInvoke(call) {
        return gateAnswer(call, { operationConfidence: 0.2, ambiguity: 0.1 })
      },
      onLanguage(call) {
        purposes.push(call.purpose)
        return { output: authoredCall(call, {}) }
      },
      onExecute(intent) {
        expect(intent.arguments).toEqual({})
      },
    })
    const runtime = await openJevRuntime(
      {
        ...base,
        environment: {
          ...base.environment,
          async catalog() {
            return [{ ...noArguments, effectClass: 'workspace_mutation' }]
          },
        },
      },
      config,
    )
    expect((await runtime.run(turn, [input])).status).toBe('completed')
    expect(purposes).toEqual(['arbitration'])
    const selected = (await ledger.read())
      .map((entry) => entry.record)
      .filter((record) => record.kind === 'decision.selected')
    expect(selected).toMatchObject([
      { source: 'jev', confidence: 0.2, escalation: 'low_confidence' },
      { source: 'llm_arbitration', operation: tool.name },
    ])
    expect(selected[1]).not.toHaveProperty('confidence')
  })

  it('prioritizes recoverable failure over a later supported no-argument selection', async () => {
    const { ledger } = ledgerA()
    let calls = 0
    const purposes: string[] = []
    const base = fixture(ledger, {
      onInvoke(call) {
        return gateAnswer(call, { purposeConfidence: 0.2, operationConfidence: 0.99, ambiguity: 0 })
      },
      onLanguage(call) {
        purposes.push(call.purpose)
        return { output: authoredCall(call, {}) }
      },
      onResult() {
        return ++calls === 1
          ? {
              kind: 'error',
              content: [],
              error: { code: 'TEMPORARY', message: 'Retry available' },
              directive: { conclude: false, additions: [] },
            }
          : outcome
      },
    })
    const runtime = await openJevRuntime(
      {
        ...base,
        environment: {
          ...base.environment,
          async catalog() {
            return [noArguments]
          },
        },
      },
      config,
    )
    expect((await runtime.run(turn, [input])).status).toBe('completed')
    expect(purposes).toEqual(['arbitration'])
    expect(
      resources(
        (await ledger.read()).map((entry) => entry.record),
        'jev.candidate.route.v1',
      ),
    ).toMatchObject([{ route: 'direct' }, { route: 'arbitration', reason: 'recoverable_observation' }])
    expect(
      resources(
        (await ledger.read()).map((entry) => entry.record),
        'jev.decision.route.v1',
      ),
    ).toMatchObject([
      { supportApplied: true },
      { supportApplied: false, reasons: ['recoverable_observation'] },
    ])
  })

  it.each(['stale', 'policy'] as const)(
    'handles a %s failure between candidate offering and intent creation',
    async (failure) => {
      const { ledger, entries } = ledgerA()
      const candidate: Candidate = {
        id: brandString<CandidateId>('racing-candidate'),
        tool: tool.name,
        label: 'Exact recorded call',
        arguments: { from: 'candidate' },
        sourceRecordIds: [],
        environmentEpoch: epoch,
        toolRevision: tool.revision,
      }
      let decisions = 0
      let rejected = false
      let offerValidated = false
      const purposes: string[] = []
      const base = fixture(ledger, {
        candidate,
        onInvoke(call) {
          expect(offerValidated).toBe(true)
          if (++decisions === 2) {
            const records = entries.map((entry) => entry.payload)
            expect(
              records.some(
                (record) => record.kind === 'action.intended' || record.kind === 'action.dispatching',
              ),
            ).toBe(false)
            expect(resources(records, 'jev.runtime.feedback.v1')).toMatchObject([
              { code: 'CANDIDATE_STALE', stage: 'preflight' },
            ])
          }
          return gateAnswer(call, { operationConfidence: 0.99, bindingConfidence: 0.99 })
        },
        onLanguage(call) {
          purposes.push(call.purpose)
          return { output: authoredCall(call, { from: 'arbitration' }) }
        },
        onExecute(intent) {
          expect(intent.arguments).toEqual({ from: 'arbitration' })
        },
      })
      const runtime = await openJevRuntime(
        {
          ...base,
          environment: {
            ...base.environment,
            async validate(descriptor, args, preconditions) {
              if (decisions === 0) offerValidated = true
              if (decisions === 1 && !rejected) {
                rejected = true
                throw failure === 'stale'
                  ? new StaleCandidate('Recorded resource changed')
                  : new Error('Policy denied invocation')
              }
              return base.environment.validate(descriptor, args, preconditions)
            },
          },
        },
        config,
      )
      const result = await runtime.run(turn, [input])
      const records = (await ledger.read()).map((entry) => entry.record)
      if (failure === 'stale') {
        expect(result.status, result.reason).toBe('completed')
        expect(decisions).toBe(2)
        expect(purposes).toEqual(['arbitration'])
        expect(records.filter((record) => record.kind === 'action.dispatching')).toHaveLength(1)
        expect(resources(records, 'jev.candidate.route.v1')).toMatchObject([
          { route: 'direct' },
          { route: 'arbitration', reason: 'recoverable_observation' },
        ])
      } else {
        expect(result.status).toBe('failed')
        expect(result.reason).toContain('Policy denied invocation')
        expect(decisions).toBe(1)
        expect(purposes).toEqual([])
        expect(resources(records, 'jev.runtime.feedback.v1')).toEqual([])
        expect(
          records.some((record) => record.kind === 'action.intended' || record.kind === 'action.dispatching'),
        ).toBe(false)
      }
    },
  )
})

describe('durable response review', () => {
  const review: RuntimeConfig = {
    ...config,
    responseReviewMode: 'review',
    answerProgressFloor: 0.8,
    maxSteps: 5,
    maxModelAttempts: 12,
    maxNoProgress: 4,
    maxRepeatedFailures: 4,
  }

  it('admits the arbitration answer after review and reuses it without another language call', async () => {
    const { ledger } = ledgerA()
    const purposes: string[] = []
    const runtime = await openJevRuntime(
      fixture(ledger, {
        onInvoke(call) {
          return gateAnswer(call, { respond: true, progress: 0 })
        },
        onLanguage(call) {
          purposes.push(call.purpose)
          return {
            output: {
              kind: 'answer',
              content: [{ kind: 'text', text: 'The evidence establishes the limitation.' }],
            },
          }
        },
        onExecute() {
          throw new Error('A response must not dispatch a tool')
        },
      }),
      review,
    )
    expect((await runtime.run(turn, [input])).status).toBe('completed')
    expect(purposes).toEqual(['arbitration'])
    const records = (await ledger.read()).map((entry) => entry.record)
    const projection = new AcceptedAnswers()
    const selections: RuntimeRecord[] = []
    for (const record of records) if (projection.apply(record) !== undefined) selections.push(record)
    expect(selections).toHaveLength(1)
    expect(selections[0]).toMatchObject({
      kind: 'decision.selected',
      source: 'llm_arbitration',
      operation: 'RESPOND',
    })
    const acceptedReview = records.findIndex(
      (record) =>
        record.kind === 'resource.observed' &&
        (record.resource as { verdict?: string }).verdict === 'allow_response',
    )
    expect(acceptedReview).toBeGreaterThan(-1)
    expect(records.indexOf(selections[0]!)).toBeGreaterThan(acceptedReview)
    await runtime.close()
  })

  it.each([
    { kind: 'answer', content: [] },
    { kind: 'answer', content: [{ kind: 'text', text: '  \n' }] },
    { kind: 'answer', content: [{ kind: 'text', text: 7 }] },
    { kind: 'answer', content: [{ kind: 'text', text: 'text' }], unexpected: true },
  ])('does not admit malformed arbitration content: %j', async (output) => {
    const { ledger } = ledgerA()
    const runtime = await openJevRuntime(
      fixture(ledger, {
        onInvoke(call) {
          return gateAnswer(call, { respond: true, progress: 0 })
        },
        onLanguage() {
          return { output }
        },
      }),
      { ...review, maxSteps: 1 },
    )
    expect((await runtime.run(turn, [input])).status).toBe('budget')
    const records = (await ledger.read()).map((entry) => entry.record)
    expect(resources(records, 'jev.response-review.v1')).toMatchObject([{ stage: 'requested' }])
    expect(resources(records, 'jev.response-review.v1')).toHaveLength(1)
    expect(
      records.some((record) => record.kind === 'decision.selected' && record.source === 'llm_arbitration'),
    ).toBe(false)
    expect(resources(records, 'jev.runtime.feedback.v1')).toMatchObject([{ code: 'INVALID_ARBITRATION' }])
    await runtime.close()
  })

  it('completes a reopened admitted answer without another decision or language request', async () => {
    const source = ledgerA()
    const runtime = await openJevRuntime(
      fixture(source.ledger, {
        onInvoke(call) {
          return gateAnswer(call, { respond: true, progress: 0 })
        },
        onLanguage() {
          return { output: { kind: 'answer', content: [{ kind: 'text', text: 'One accepted answer.' }] } }
        },
      }),
      review,
    )
    expect((await runtime.run(turn, [input])).status).toBe('completed')
    await runtime.close()
    const records = (await source.ledger.read()).map((entry) => entry.record)
    const selection = records.findIndex(
      (record) => record.kind === 'decision.selected' && record.source === 'llm_arbitration',
    )
    expect(selection).toBeGreaterThan(-1)
    const restored = ledgerA()
    for (const record of records.slice(0, selection + 1)) await restored.ledger.commit(record)
    const resumed = await openJevRuntime(
      fixture(restored.ledger, {
        onInvoke() {
          throw new Error('An admitted answer must not request another decision')
        },
        onLanguage() {
          throw new Error('An admitted answer must not be generated again')
        },
      }),
      review,
    )
    expect((await resumed.run(turn, [])).status).toBe('completed')
    const after = (await restored.ledger.read()).map((entry) => entry.record)
    expect(after.filter((record) => record.kind === 'model.requested')).toHaveLength(2)
    expect(after.at(-1)).toMatchObject({ kind: 'run.stopped', reason: 'completed' })
    await resumed.close()
  })

  it.each([
    { kind: 'answer', content: [] },
    { kind: 'answer', content: [{ kind: 'text', text: ' \n' }] },
    { kind: 'answer', content: [{ kind: 'unsupported' }] },
  ])('resumes after invalid answer feedback without declaring completion: %j', async (output) => {
    const source = ledgerA()
    let languageCalls = 0
    const runtime = await openJevRuntime(
      fixture(source.ledger, {
        onInvoke(call) {
          return gateAnswer(call, { respond: true })
        },
        onLanguage() {
          return {
            output:
              ++languageCalls === 1
                ? output
                : { kind: 'answer', content: [{ kind: 'text', text: 'Valid answer.' }] },
          }
        },
      }),
      config,
    )
    expect((await runtime.run(turn, [input])).status).toBe('completed')
    await runtime.close()
    const records = (await source.ledger.read()).map((entry) => entry.record)
    const invalid = records.findIndex(
      (record) =>
        record.kind === 'resource.observed' &&
        (record.resource as { code?: string }).code === 'INVALID_ANSWER',
    )
    expect(invalid).toBeGreaterThan(-1)
    const restored = ledgerA()
    for (const record of records.slice(0, invalid + 1)) await restored.ledger.commit(record)
    let decisions = 0
    let answers = 0
    const resumed = await openJevRuntime(
      fixture(restored.ledger, {
        onInvoke(call) {
          decisions++
          return gateAnswer(call, { respond: true })
        },
        onLanguage() {
          answers++
          return { output: { kind: 'answer', content: [{ kind: 'text', text: 'Valid answer.' }] } }
        },
      }),
      config,
    )
    expect((await resumed.run(turn, [])).status).toBe('completed')
    expect({ decisions, answers }).toEqual({ decisions: 1, answers: 1 })
    await resumed.close()
  })

  it.each([
    { kind: 'answer', content: [] },
    { kind: 'answer', content: [{ kind: 'text', text: '\n' }] },
    { kind: 'answer', content: [{ kind: 'unsupported' }] },
  ])('does not complete a retained arbitration selection with invalid content: %j', async (output) => {
    const source = ledgerA()
    const runtime = await openJevRuntime(
      fixture(source.ledger, {
        onInvoke(call) {
          return gateAnswer(call, { respond: true, progress: 0 })
        },
        onLanguage() {
          return { output: { kind: 'answer', content: [{ kind: 'text', text: 'Original answer.' }] } }
        },
      }),
      review,
    )
    expect((await runtime.run(turn, [input])).status).toBe('completed')
    await runtime.close()
    const records = (await source.ledger.read()).map((entry) => entry.record)
    const selection = records.findIndex(
      (record) => record.kind === 'decision.selected' && record.source === 'llm_arbitration',
    )
    const selected = records[selection]
    expect(selected?.kind).toBe('decision.selected')
    if (selected?.kind !== 'decision.selected') throw new Error('Missing arbitration selection')
    const restored = ledgerA()
    for (const record of records.slice(0, selection + 1))
      await restored.ledger.commit(
        record.kind === 'model.settled' && record.requested === selected.requested
          ? { ...record, settlement: { ...record.settlement, output } }
          : record,
      )
    let decisions = 0
    let answers = 0
    const resumed = await openJevRuntime(
      fixture(restored.ledger, {
        onInvoke(call) {
          decisions++
          return gateAnswer(call, { respond: true, progress: 3 })
        },
        onLanguage() {
          answers++
          return { output: { kind: 'answer', content: [{ kind: 'text', text: 'Valid answer.' }] } }
        },
      }),
      review,
    )
    expect((await resumed.run(turn, [])).status).toBe('completed')
    expect({ decisions, answers }).toEqual({ decisions: 1, answers: 1 })
    await resumed.close()
  })

  it.each([undefined, 0])('keeps progress %s diagnostic in the standard mode', async (progress) => {
    const { ledger } = ledgerA()
    const purposes: string[] = []
    const runtime = await openJevRuntime(
      fixture(ledger, {
        onInvoke(call) {
          return gateAnswer(call, { respond: true, ...(progress === undefined ? {} : { progress }) })
        },
        onLanguage(call) {
          purposes.push(call.purpose)
          return { output: { kind: 'answer', content: [{ kind: 'text', text: 'Known limitation' }] } }
        },
      }),
      config,
    )
    expect((await runtime.run(turn, [input])).status).toBe('completed')
    expect(purposes).toEqual(['answer'])
  })

  it.each([undefined, 0])(
    'accepts a grounded response at progress %s without forcing a tool call',
    async (progress) => {
      const { ledger } = ledgerA()
      const purposes: string[] = []
      const runtime = await openJevRuntime(
        fixture(ledger, {
          onInvoke(call) {
            return gateAnswer(call, { respond: true, ...(progress === undefined ? {} : { progress }) })
          },
          onLanguage(call) {
            purposes.push(call.purpose)
            return {
              output:
                call.purpose === 'arbitration'
                  ? { kind: 'answer' }
                  : {
                      kind: 'answer',
                      content: [{ kind: 'text', text: 'Cannot finish with available evidence' }],
                    },
            }
          },
          onExecute() {
            throw new Error('Review forced an unnecessary tool call')
          },
        }),
        review,
      )
      expect((await runtime.run(turn, [input])).status).toBe('completed')
      expect(purposes).toEqual(['arbitration', 'answer'])
      expect(
        resources(
          (await ledger.read()).map((entry) => entry.record),
          'jev.response-review.v1',
        ),
      ).toMatchObject([{ stage: 'requested' }, { stage: 'accepted', verdict: 'allow_response' }])
    },
  )

  it('executes a complete review-selected call without old binding confidence or premature answer text', async () => {
    const { ledger } = ledgerA()
    const purposes: string[] = []
    const runtime = await openJevRuntime(
      fixture(ledger, {
        onInvoke(call) {
          return gateAnswer(call, { respond: true, progress: 0 })
        },
        onLanguage(call) {
          purposes.push(call.purpose)
          return { output: authoredCall(call, { reviewed: true }) }
        },
        onExecute(intent) {
          expect(intent.arguments).toEqual({ reviewed: true })
        },
      }),
      review,
    )
    expect((await runtime.run(turn, [input])).status).toBe('completed')
    expect(purposes).toEqual(['arbitration'])
    expect(
      resources(
        (await ledger.read()).map((entry) => entry.record),
        'jev.response-review.v1',
      ),
    ).toMatchObject([{ stage: 'requested' }, { stage: 'accepted', verdict: 'continue_call' }])
  })

  it('stops after a review-selected repeat returns no new evidence and Jev selects RESPOND again', async () => {
    const { ledger } = ledgerA()
    let decisions = 0
    let calls = 0
    const purposes: string[] = []
    const base = fixture(ledger, {
      onInvoke(call) {
        return gateAnswer(call, { respond: ++decisions > 1, progress: 0 })
      },
      onLanguage(call) {
        purposes.push(call.purpose)
        return { output: authoredCall(call, {}) }
      },
      onResult() {
        calls++
        return { ...outcome, directive: { conclude: false, additions: [] } }
      },
    })
    const runtime = await openJevRuntime(
      {
        ...base,
        environment: {
          ...base.environment,
          async catalog() {
            return [
              {
                ...tool,
                effectClass: 'read_only',
                parameters: { type: 'object', additionalProperties: false },
              },
            ]
          },
        },
        decisionContext: {
          ...base.decisionContext,
          describeObservation(observation) {
            const data = observation.data as Record<string, JsonValue>
            return { data: data.value!, coverage: { complete: true } }
          },
        },
        semantics: {
          ...base.semantics!,
          observations(_tool, _outcome, intent) {
            return [
              {
                kind: 'host-result',
                source: tool.name,
                data: {
                  value: { done: true },
                  producer: { intentId: intent.id, environmentEpoch: intent.environmentEpoch },
                },
                coverage: { complete: true, environmentEpoch: intent.environmentEpoch },
              },
            ]
          },
        },
      },
      review,
    )
    const result = await runtime.run(turn, [input])
    expect(result.status, result.reason).toBe('budget')
    expect(result.reason).toContain('without new substantive evidence')
    expect(calls).toBe(2)
    expect(decisions).toBe(3)
    expect(purposes).toEqual(['arbitration'])
  })

  it('retains invalid review attempt limits across reopen without accepting an invalid call', async () => {
    const { ledger } = ledgerA()
    let arbitrations = 0
    const base = fixture(ledger, {
      onInvoke(call) {
        return gateAnswer(call, { respond: true })
      },
      onLanguage(call) {
        expect(call.purpose).toBe('arbitration')
        arbitrations++
        return { output: authoredCall(call, { invalid: true }) }
      },
      onExecute() {
        throw new Error('Invalid review call dispatched')
      },
    })
    const ports: RuntimePorts<number> = {
      ...base,
      environment: {
        ...base.environment,
        async validate() {
          throw new InvalidAuthoredArguments('Unsupported parameters')
        },
      },
    }
    const first = await openJevRuntime(
      {
        ...ports,
        lifecycle: {
          async admitStep(_turn, _step, inputs) {
            return { kind: 'enter', inputs }
          },
          async stepSettled() {
            throw new Error('Host interrupted after one attempt')
          },
        },
      },
      review,
    )
    expect((await first.run(turn, [input])).status).toBe('failed')
    await first.close()
    const resumed = await openJevRuntime(ports, review)
    const result = await resumed.run(turn, [])
    expect(result.status, result.reason).toBe('budget')
    expect(arbitrations).toBe(2)
    const receipts = resources(
      (await ledger.read()).map((entry) => entry.record),
      'jev.response-review.v1',
    )
    expect(receipts).toHaveLength(2)
    expect(receipts.every((receipt) => receipt.stage === 'requested')).toBe(true)
    expect(new Set(receipts.map((receipt) => receipt.checkpoint)).size).toBe(1)
  })

  it('recovers accepted response review without asking for another verdict after an answer failure', async () => {
    const { ledger } = ledgerA()
    let answers = 0
    const purposes: string[] = []
    const base = fixture(ledger, {
      onInvoke(call) {
        return gateAnswer(call, { respond: true })
      },
      onLanguage(call) {
        purposes.push(call.purpose)
        if (call.purpose === 'arbitration') return { output: { kind: 'answer' } }
        return ++answers === 1
          ? { error: { code: 'TRANSIENT', message: 'Provider unavailable', retryable: true } }
          : { output: { kind: 'answer', content: [{ kind: 'text', text: 'Grounded limitation' }] } }
      },
    })
    const first = await openJevRuntime(base, review)
    expect((await first.run(turn, [input])).status).toBe('failed')
    await first.close()
    const resumed = await openJevRuntime(base, review)
    expect((await resumed.run(turn, [])).status).toBe('completed')
    expect(purposes).toEqual(['arbitration', 'answer', 'answer'])
    expect(
      resources(
        (await ledger.read()).map((entry) => entry.record),
        'jev.response-review.v1',
      ),
    ).toHaveLength(2)
  })

  it('charges malformed review model responses to the checkpoint attempt budget before format retry', async () => {
    const { ledger } = ledgerA()
    let calls = 0
    const runtime = await openJevRuntime(
      fixture(ledger, {
        maxFormatRetries: 2,
        onInvoke(call) {
          return gateAnswer(call, { respond: true })
        },
        onLanguage(call) {
          expect(call.purpose).toBe('arbitration')
          calls++
          return invalidHelper
        },
        onExecute() {
          throw new Error('Invalid review response dispatched')
        },
      }),
      { ...review, maxResponseReviewAttempts: 1 },
    )
    const result = await runtime.run(turn, [input])
    expect(calls).toBe(1)
    expect(result.status).toBe('budget')
    expect(
      resources(
        (await ledger.read()).map((entry) => entry.record),
        'jev.response-review.v1',
      ),
    ).toMatchObject([{ stage: 'requested' }])
  })

  it.each(['arbitration', 'review'] as const)(
    'applies host admission to a complete %s-authored call',
    async (route) => {
      const { ledger } = ledgerA()
      const base = fixture(ledger, {
        onInvoke(call) {
          return gateAnswer(call, route === 'review' ? { respond: true } : { operationConfidence: 0.2 })
        },
        onLanguage(call) {
          expect(call.purpose).toBe('arbitration')
          return { output: authoredCall(call, { exact: true }) }
        },
        onExecute() {
          throw new Error('Host-denied call dispatched')
        },
      })
      const runtime = await openJevRuntime(
        {
          ...base,
          environment: {
            ...base.environment,
            async validate() {
              throw new Error('Host permission denied')
            },
          },
        },
        route === 'review' ? review : config,
      )
      const result = await runtime.run(turn, [input])
      expect(result.status).toBe('failed')
      expect(result.reason).toContain('Host permission denied')
      const records = (await ledger.read()).map((entry) => entry.record)
      expect(
        records.some((record) => record.kind === 'action.intended' || record.kind === 'action.dispatching'),
      ).toBe(false)
      expect(
        resources(records, 'jev.response-review.v1').some((receipt) => receipt.stage === 'accepted'),
      ).toBe(false)
    },
  )
})

describe('independent model contexts', () => {
  it.each([0.9, 0.2])(
    'keeps full language inputs across decision budgets and reopen at confidence %s',
    async (confidence) => {
      const execute = async (
        excerptBytes: number,
      ): Promise<{ language: LanguageInput[]; decisions: JsonValue[] }> => {
        const { ledger } = ledgerA()
        const language: LanguageInput[] = []
        const decisions: JsonValue[] = []
        let number = 0
        const original = fixture(ledger, {
          onInvoke(call) {
            const body = call.input as { questions: Record<string, JsonValue>; state: JsonValue }
            decisions.push(body.state)
            if (number++ % 2 === 0) return { output: decision(body.questions, undefined, confidence) }
            return { output: decisionAnswers(body.questions, { purpose: 'RESPOND' }) }
          },
        })
        const ports: RuntimePorts<number> = {
          ...original,
          decisionContext: {
            ...original.decisionContext,
            config: {
              ...original.decisionContext.config,
              excerptBytes,
              observationCount: 1,
            },
          },
          environment: {
            ...original.environment,
            async execute() {
              return {
                ...outcome,
                value: { fullEvidence: 'complete evidence '.repeat(500) },
                directive: { conclude: false, additions: [] },
              }
            },
          },
          language: {
            ...original.language,
            async prepare(model, signal) {
              language.push(structuredClone(model))
              return original.language.prepare(model, signal)
            },
          },
        }
        const first = await openJevRuntime(ports, config)
        expect((await first.run(turn, [input])).status).toBe('completed')
        await first.close()
        const resumed = await openJevRuntime(ports, config)
        expect(
          (
            await resumed.run(brandString<TurnId>('next-turn'), [
              {
                id: 'followup',
                source: 'user',
                content: [{ kind: 'text', text: 'Use the earlier evidence' }],
              },
            ])
          ).status,
        ).toBe('completed')
        await resumed.close()
        return { language, decisions }
      }
      const compact = await execute(64)
      const expanded = await execute(1600)
      const modelContext = (calls: readonly LanguageInput[]) =>
        calls.map(({ records: _records, ...context }) => context)
      expect(modelContext(compact.language)).toEqual(modelContext(expanded.language))
      expect(compact.decisions).not.toEqual(expanded.decisions)
      expect(compact.language.map((call) => call.purpose)).toEqual([
        confidence < 0.6 ? 'arbitration' : 'parameters',
        'answer',
        confidence < 0.6 ? 'arbitration' : 'parameters',
        'answer',
      ])
      expect(JSON.stringify(compact.language[1]?.state)).toContain('complete evidence '.repeat(500))
      expect(compact.language[2]?.history.some((fact) => fact.source === 'assistant')).toBe(true)
      expect(JSON.stringify(compact.decisions[1])).not.toContain('complete evidence '.repeat(500))
    },
  )
})

describe('decision compiler', () => {
  it('validates the selected candidate distribution and preserves separate confidence', () => {
    const candidate: Candidate = {
      id: brandString<CandidateId>('c1'),
      tool: tool.name,
      label: 'exact call',
      arguments: { exact: true },
      sourceRecordIds: [],
      environmentEpoch: epoch,
      toolRevision: tool.revision,
    }
    const surface = compileQuestions([tool], [candidate], config)
    const selected = parseDecision(decision(surface.questions, 'c1', 0.5), surface)
    expect(selected.candidateId).toBe('c1')
    expect(selected.operationConfidence).toBe(0.5)
    expect(selected.purposeConfidence).toBe(0.5)
    expect(selected.operationPathConfidence).toBe(0.5)
    expect(() =>
      parseDecision(
        {
          answers: {
            purpose: choice('ACT', ['ACT', 'RESPOND']),
            operation_ACT: choice('native_tool', ['native_tool']),
            binding_native_tool: {
              type: 'choice',
              choice: 'c1',
              confidence: 1,
              probabilities: { c1: 0.2, LLM_PARAMETERS: 0.8 },
            },
          },
        },
        surface,
      ),
    ).toThrow()
  })
})

function durableBarrierCase<C>(label: string, create: () => { ledger: RuntimeLedger<C> }): void {
  describe(`${label} ledger`, () => {
    it('runs Jev then a complete language-authored call through durable barriers', async () => {
      const { ledger } = create()
      let calls = 0
      const runtime = await openJevRuntime(
        fixture(ledger, {
          onExecute: () => {
            calls++
          },
        }),
        config,
      )
      const result = await runtime.run(turn, [input])
      expect(result.status).toBe('completed')
      expect(calls).toBe(1)
      const records = (await ledger.read()).map((entry) => entry.record)
      expect(records.map((record) => record.kind)).toContain('action.dispatching')
      expect(
        records.find((record) => record.kind === 'model.requested' && record.call.purpose === 'decision'),
      ).toBeDefined()
      const action = records.find((record) => record.kind === 'action.settled')
      expect(action?.kind === 'action.settled' && action.effect).toBe('acknowledged')
      expect(replayRecords(await ledger.read()).unresolved).toEqual([])
    })
  })
}

durableBarrierCase('numeric cursor', ledgerA)
durableBarrierCase('compound cursor', ledgerB)

describe('recovery', () => {
  it('keeps approval waiting before the dispatch barrier and safely recovers a crash there', async () => {
    const { ledger } = ledgerA()
    let entered!: () => void
    const waiting = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: () => void
    const approval = new Promise<void>((resolve) => {
      release = resolve
    })
    const base = fixture(ledger, {
      onExecute() {
        throw new Error('Unapproved tool executed')
      },
    })
    const first = await openJevRuntime(
      {
        ...base,
        environment: {
          ...base.environment,
          async prepare() {
            entered()
            await approval
            return { kind: 'ready' }
          },
        },
      },
      config,
    )
    const run = first.run(turn, [input])
    await waiting
    const prefix = await ledger.read()
    expect(prefix.some((entry) => entry.record.kind === 'action.intended')).toBe(true)
    expect(prefix.some((entry) => entry.record.kind === 'action.dispatching')).toBe(false)
    // Reopen an independent copy of the crash prefix; the old owner cannot append into this log.
    const recovered = ledgerA()
    for (const entry of prefix) await recovered.ledger.commit(entry.record)
    const reopened = await openJevRuntime(fixture(recovered.ledger), config)
    expect(replayRecords(await recovered.ledger.read()).unresolved).toEqual([])
    expect(
      (await recovered.ledger.read()).filter((entry) => entry.record.kind === 'action.settled'),
    ).toMatchObject([{ record: { effect: 'not_applied' } }])
    await reopened.close()
    first.cancel()
    release()
    await run
    await first.close()
  })

  it('rechecks the environment after asynchronous preparation before creating a dispatch barrier', async () => {
    const { ledger } = ledgerA()
    let changed = false
    const base = fixture(ledger, {
      onExecute() {
        throw new Error('Stale invocation executed')
      },
    })
    const runtime = await openJevRuntime(
      {
        ...base,
        environment: {
          ...base.environment,
          async snapshot() {
            return { epoch: changed ? brandString<EnvironmentEpoch>('epoch-2') : epoch, facts: {} }
          },
          async prepare() {
            changed = true
            return { kind: 'ready' }
          },
        },
      },
      { ...config, maxSteps: 1 },
    )
    await runtime.run(turn, [input])
    const records = (await ledger.read()).map((entry) => entry.record)
    expect(records.some((record) => record.kind === 'action.dispatching')).toBe(false)
    expect(records.filter((record) => record.kind === 'action.settled')).toMatchObject([
      { effect: 'not_applied', outcome: { error: { code: 'NOT_DISPATCHED' } } },
    ])
  })

  it('settles refused preparation without dispatch and cannot promote its effect through semantics', async () => {
    const { ledger } = ledgerA()
    const base = fixture(ledger, {
      onExecute() {
        throw new Error('Refused tool executed')
      },
    })
    const runtime = await openJevRuntime(
      {
        ...base,
        environment: {
          ...base.environment,
          async prepare() {
            return {
              kind: 'settled',
              outcome: {
                ...outcome,
                kind: 'error',
                effect: 'applied',
                error: { code: 'AUTHZ_DENIED', message: 'Denied' },
              },
            }
          },
        },
        semantics: {
          ...base.semantics!,
          effectDisposition() {
            return 'applied'
          },
        },
      },
      { ...config, maxSteps: 1 },
    )
    await runtime.run(turn, [input])
    const records = (await ledger.read()).map((entry) => entry.record)
    expect(records.some((record) => record.kind === 'action.dispatching')).toBe(false)
    expect(records.filter((record) => record.kind === 'action.settled')).toMatchObject([
      { effect: 'not_applied', outcome: { effect: 'not_applied', error: { code: 'AUTHZ_DENIED' } } },
    ])
  })

  it('turns an uncertain dispatch into UNKNOWN without replaying the tool', async () => {
    const { ledger, entries } = ledgerA()
    let calls = 0
    let failSettlement = true
    const failing: RuntimeLedger<number> = {
      ...ledger,
      async commit(record) {
        if (record.kind === 'action.settled' && failSettlement) {
          failSettlement = false
          throw new Error('lost write ownership')
        }
        return ledger.commit(record)
      },
    }
    const runtime = await openJevRuntime(
      fixture(failing, {
        onExecute: () => {
          calls++
        },
      }),
      config,
    )
    await expect(runtime.run(turn, [input])).rejects.toThrow('lost write ownership')
    expect(calls).toBe(1)
    const reopened = await openJevRuntime(
      fixture(ledger, {
        onExecute: () => {
          calls++
        },
      }),
      config,
    )
    const blocked = await reopened.run(turn, [])
    expect(blocked.status).toBe('blocked')
    expect(blocked.unresolved).toHaveLength(1)
    expect(calls).toBe(1)
    await expect(
      reopened.resolveUnknown(blocked.unresolved[0]!, 'accepted_uncertainty', 'operator', 'Checked host', []),
    ).rejects.toThrow('Invalid UNKNOWN resolution')
    await reopened.resolveUnknown(
      blocked.unresolved[0]!,
      'accepted_uncertainty',
      'operator',
      'Checked host',
      ['receipt'],
    )
    await expect(
      reopened.resolveUnknown(blocked.unresolved[0]!, 'accepted_uncertainty', 'operator', 'Checked host', [
        'receipt',
      ]),
    ).rejects.toThrow('Invalid UNKNOWN resolution')
    expect(
      replayRecords(entries.map((entry) => ({ cursor: entry.offset, record: entry.payload }))).unresolved,
    ).toEqual([])
  })

  it('trusts the durable settlement after its acknowledgement was lost', async () => {
    const { ledger } = ledgerA()
    let calls = 0
    let loseAcknowledgement = true
    const uncertainWriter: RuntimeLedger<number> = {
      ...ledger,
      async commit(record) {
        const cursor = await ledger.commit(record)
        if (record.kind === 'action.settled' && loseAcknowledgement) {
          loseAcknowledgement = false
          throw new Error('settlement acknowledgement lost')
        }
        return cursor
      },
    }
    const first = await openJevRuntime(
      fixture(uncertainWriter, {
        onExecute() {
          calls++
        },
      }),
      config,
    )
    await expect(first.run(turn, [input])).rejects.toThrow('settlement acknowledgement lost')
    expect(calls).toBe(1)
    const reopened = await openJevRuntime(
      fixture(ledger, {
        onExecute() {
          throw new Error('durable action replayed')
        },
        admitStep: {
          async admitStep() {
            return { kind: 'complete' }
          },
          async stepSettled() {},
        },
      }),
      config,
    )
    expect((await reopened.run(turn, [])).status).toBe('completed')
    expect(replayRecords(await ledger.read()).unresolved).toEqual([])
    expect((await ledger.read()).filter((entry) => entry.record.kind === 'action.settled')).toHaveLength(1)
  })

  it('rejects missing replay artifacts before accepting a new turn', async () => {
    const { ledger } = ledgerA()
    const record: RuntimeRecord = {
      version: 1,
      id: brandString<RecordId>('r1'),
      turn,
      kind: 'input.admitted',
      input: {
        id: 'one',
        source: 'user',
        content: [
          { kind: 'artifact', artifact: { id: 'missing', digest: 'x', size: 8, mediaType: 'text/plain' } },
        ],
      },
    }
    await ledger.commit(record)
    const ports = fixture(ledger)
    await expect(
      openJevRuntime(
        {
          ...ports,
          artifacts: {
            ...ports.artifacts,
            async retain() {
              throw new Error('missing artifact')
            },
          },
        },
        config,
      ),
    ).rejects.toThrow('missing artifact')
  })
})

describe('routing and admission', () => {
  it.each(['complete', 'failure', 'unknown', 'cancel', 'conclude', 'addition', 'refused'] as const)(
    'executes ordered arbitration batches with independent durable actions: %s',
    async (mode) => {
      const { ledger } = ledgerA()
      const executed: number[] = []
      const helper: JsonValue = {
        kind: 'calls',
        calls: [0, 1, 2].map((index) => ({ kind: 'call', name: tool.name, arguments: { index } })),
      }
      let runtime: Awaited<ReturnType<typeof openJevRuntime<number>>>
      const ports = fixture(ledger, {
        confidence: 0.2,
        helper,
        onExecute(intent) {
          executed.push(Number(intent.arguments.index))
          if (mode === 'cancel') runtime.cancel()
        },
        onResult: () => ({
          ...outcome,
          kind: mode === 'failure' ? 'error' : 'success',
          effect: mode === 'unknown' ? 'unknown' : 'acknowledged',
          value: { index: executed.at(-1)! },
          directive: {
            conclude: mode === 'conclude' || (mode === 'complete' && executed.length === 3),
            additions: mode === 'addition' ? [{ ...input, id: 'steering' }] : [],
          },
        }),
      })
      if (mode === 'refused')
        ports.environment.prepare = async () => ({
          kind: 'settled',
          outcome: {
            ...outcome,
            kind: 'error',
            effect: 'not_applied',
            directive: { conclude: false, additions: [] },
          },
        })
      runtime = await openJevRuntime(ports, { ...config, maxSteps: 1 })
      const result = await runtime.run(turn, [input])
      expect(executed).toEqual(mode === 'complete' ? [0, 1, 2] : mode === 'refused' ? [] : [0])
      expect(result.status).toBe(
        mode === 'complete' || mode === 'conclude'
          ? 'completed'
          : mode === 'unknown'
            ? 'blocked'
            : mode === 'cancel'
              ? 'cancelled'
              : 'budget',
      )
      const records = (await ledger.read()).map((entry) => entry.record)
      expect(records.filter((r) => r.kind === 'model.requested').map((r) => r.call.purpose)).toEqual([
        'decision',
        'arbitration',
      ])
      const selected = records.filter(
        (r): r is Extract<RuntimeRecord, { kind: 'decision.selected' }> =>
          r.kind === 'decision.selected' && r.source === 'llm_arbitration',
      )
      expect(selected.map((r) => r.callIndex)).toEqual(mode === 'complete' ? [0, 1, 2] : [0])
      const intents = records.filter((r) => r.kind === 'action.intended')
      expect(new Set(intents.map((r) => r.intent.id)).size).toBe(intents.length)
      expect(new Set(intents.map((r) => r.step)).size).toBe(1)
      expect(records.filter((r) => r.kind.startsWith('action.')).map((r) => r.kind)).toEqual(
        mode === 'refused'
          ? ['action.intended', 'action.settled']
          : executed.flatMap(() => ['action.intended', 'action.dispatching', 'action.settled']),
      )
      expect(replayRecords(await ledger.read()).unresolved).toHaveLength(mode === 'unknown' ? 1 : 0)
      if (mode === 'addition')
        expect(records.filter((r) => r.kind === 'input.admitted' && r.input.id === 'steering')).toHaveLength(
          1,
        )
    },
  )

  it.each(['schema', 'unavailable', 'empty', 'too-many', 'parameters'] as const)(
    'rejects an invalid complete batch before dispatch: %s',
    async (mode) => {
      const { ledger } = ledgerA()
      const calls = [0, 1].map((index) => ({
        kind: 'call',
        name: index === 1 && mode === 'unavailable' ? 'missing' : tool.name,
        arguments: { index },
      }))
      const helper: JsonValue = {
        kind: 'calls',
        calls: mode === 'empty' ? [] : mode === 'too-many' ? Array(33).fill(calls[0]) : calls,
      }
      let dispatched = false
      const ports = fixture(ledger, {
        confidence: mode === 'parameters' ? 0.9 : 0.2,
        helper,
        onExecute() {
          dispatched = true
        },
      })
      ports.environment.validate = async (_tool, args) => {
        if (args === null || typeof args !== 'object' || Array.isArray(args))
          throw new InvalidAuthoredArguments('object required')
        if (mode === 'schema' && args.index === 1) throw new InvalidAuthoredArguments('bad second arguments')
        return args
      }
      const runtime = await openJevRuntime(ports, { ...config, maxSteps: 1 })
      await runtime.run(turn, [input])
      expect(dispatched).toBe(false)
      expect((await ledger.read()).some((e) => e.record.kind === 'action.intended')).toBe(false)
    },
  )

  it.each(['intended', 'dispatching', 'settled', 'concluded', 'concluded-addition'] as const)(
    'reopens interrupted batches without replaying the recorded prefix or automatically executing the tail: %s',
    async (phase) => {
      const { ledger } = ledgerA()
      let fail = true
      const crashing: RuntimeLedger<number> = {
        ...ledger,
        async commit(record) {
          const cursor = await ledger.commit(record)
          if (fail && record.kind === `action.${phase.startsWith('concluded') ? 'settled' : phase}`) {
            fail = false
            throw new Error('crash after commit')
          }
          return cursor
        },
      }
      const calls: number[] = []
      const first = await openJevRuntime(
        fixture(crashing, {
          confidence: 0.2,
          helper: {
            kind: 'calls',
            calls: [0, 1].map((index) => ({ kind: 'call', name: tool.name, arguments: { index } })),
          },
          onExecute(intent) {
            calls.push(Number(intent.arguments.index))
          },
          onResult: () => ({
            ...outcome,
            directive: {
              conclude: phase.startsWith('concluded'),
              additions: phase === 'concluded-addition' ? [{ ...input, id: 'concluding-addition' }] : [],
            },
          }),
        }),
        config,
      )
      await expect(first.run(turn, [input])).rejects.toThrow('crash after commit')
      const resumed = await openJevRuntime(
        fixture(ledger, {
          onExecute() {
            throw new Error('old batch replayed')
          },
          admitStep: {
            async admitStep() {
              return { kind: 'complete' }
            },
            async stepSettled() {},
          },
        }),
        config,
      )
      const result = await resumed.run(turn, [])
      expect(result.status).toBe(phase === 'dispatching' ? 'blocked' : 'completed')
      expect(calls).toEqual(phase === 'intended' || phase === 'dispatching' ? [] : [0])
      const records = (await ledger.read()).map((e) => e.record)
      expect(records.filter((r) => r.kind === 'action.intended')).toHaveLength(1)
      expect(records.filter((r) => r.kind === 'model.requested')).toHaveLength(2)
      if (phase.startsWith('concluded')) expect(result.reason).toContain('already admitted')
    },
  )

  it.each([
    ['parameters', 0.9],
    ['arbitration', 0.2],
  ] as const)('records a separate %s format repair before one tool dispatch', async (purpose, confidence) => {
    const { ledger } = ledgerA()
    const calls: JsonValue[] = []
    let helperCalls = 0
    const rejected: ModelSettlement =
      purpose === 'arbitration'
        ? {
            ...invalidHelper,
            error: {
              code: 'LANGUAGE_TOOL_CALL',
              message: 'Helper returned a native tool call',
              retryable: true,
            },
          }
        : invalidHelper
    const seen: LanguageInput[] = []
    const base = fixture(ledger, {
      confidence,
      onLanguage(call) {
        if (call.purpose === 'answer') return { output: { kind: 'answer', content: [] } }
        return helperCalls++ === 0 ? rejected : { output: authoredCall(call, { repaired: true }) }
      },
      onExecute(intent) {
        calls.push(intent.arguments)
      },
    })
    const runtime = await openJevRuntime(
      {
        ...base,
        language: {
          ...base.language,
          async prepare(model, signal) {
            seen.push(model)
            return base.language.prepare(model, signal)
          },
        },
      },
      config,
    )
    expect((await runtime.run(turn, [input])).status).toBe('completed')
    expect(calls).toEqual([{ repaired: true }])
    const records = (await ledger.read()).map((entry) => entry.record)
    const requests = records.filter((record) => record.kind === 'model.requested')
    expect(requests.map((record) => record.call.purpose)).toEqual(['decision', purpose, purpose])
    const first = requests[1]!
    const repaired = requests[2]!
    if (first.kind !== 'model.requested' || repaired.kind !== 'model.requested')
      throw new Error('missing helper requests')
    const firstInput = first.call.input as { [key: string]: JsonValue }
    const secondInput = repaired.call.input as { [key: string]: JsonValue }
    expect(firstInput.repair).toBeUndefined()
    expect(secondInput.repair).toEqual({
      requested: first.id,
      error: {
        code: rejected.error?.code,
        message: rejected.error?.message,
      },
    })
    const { repair: _repair, ...unchanged } = secondInput
    expect(unchanged).toEqual(firstInput)
    expect(first.attempt).not.toBe(repaired.attempt)
    expect(
      records.find((record) => record.kind === 'model.settled' && record.requested === first.id),
    ).toMatchObject({ settlement: rejected })
    const firstInputFacts = seen[0]!
    const repairedInputFacts = seen[1]!
    expect(firstInputFacts.records.some((record) => record.id === first.id)).toBe(false)
    expect(repairedInputFacts.records).toContainEqual(first)
    expect(repairedInputFacts.records).toContainEqual(
      records.find((record) => record.kind === 'model.settled' && record.requested === first.id),
    )
    expect(repairedInputFacts.inputCursor).toBe(repaired.call.inputCursor)
    expect(repairedInputFacts.state).toEqual(firstInputFacts.state)
    expect(repairedInputFacts.history).toEqual(firstInputFacts.history)
    expect(repairedInputFacts.tools).toEqual(firstInputFacts.tools)
    expect(repairedInputFacts.lockedOperation).toBe(firstInputFacts.lockedOperation)
    if (purpose === 'parameters') {
      expect(firstInput.locked).toBe(tool.name)
      expect(secondInput.locked).toBe(tool.name)
    } else {
      expect(
        records.find((record) => record.kind === 'decision.selected' && record.requested === repaired.id),
      ).toBeDefined()
    }
    expect(records.filter((record) => record.kind === 'action.dispatching')).toHaveLength(1)
  })

  it.each([0, 1])('stops after %i allowed format retries without an intent', async (maxFormatRetries) => {
    const { ledger } = ledgerA()
    let calls = 0
    const runtime = await openJevRuntime(
      fixture(ledger, {
        maxFormatRetries,
        onLanguage() {
          calls++
          return invalidHelper
        },
        onExecute() {
          throw new Error('invalid helper authorized execution')
        },
      }),
      config,
    )
    const result = await runtime.run(turn, [input])
    expect(result.status).toBe('failed')
    expect(result.reason).toContain('Language parameters failed (LANGUAGE_INVALID_JSON)')
    expect(result.reason).toContain('did not return one valid JSON value')
    expect(calls).toBe(maxFormatRetries + 1)
    const records = (await ledger.read()).map((entry) => entry.record)
    expect(records.filter((record) => record.kind === 'model.requested')).toHaveLength(maxFormatRetries + 2)
    expect(records.some((record) => record.kind === 'action.intended')).toBe(false)
  })

  it.each([
    { code: 'LANGUAGE_INVALID_JSON', retryable: false },
    { code: 'MODEL_FAILURE', retryable: true },
  ])('does not retry $code when its error is not eligible', async ({ code, retryable }) => {
    const { ledger } = ledgerA()
    let calls = 0
    const runtime = await openJevRuntime(
      fixture(ledger, {
        onLanguage() {
          calls++
          return { error: { code, message: 'provider rejected helper', retryable } }
        },
      }),
      config,
    )
    const result = await runtime.run(turn, [input])
    expect(result.status).toBe('failed')
    expect(result.reason).toContain(`Language parameters failed (${code}): provider rejected helper`)
    expect(calls).toBe(1)
    expect((await ledger.read()).filter((entry) => entry.record.kind === 'model.requested')).toHaveLength(2)
  })

  it('keeps the total model-attempt budget across a format repair', async () => {
    const { ledger } = ledgerA()
    let calls = 0
    const runtime = await openJevRuntime(
      fixture(ledger, {
        onLanguage() {
          calls++
          return invalidHelper
        },
      }),
      { ...config, maxModelAttempts: 2 },
    )
    expect((await runtime.run(turn, [input])).status).toBe('budget')
    expect(calls).toBe(1)
    expect((await ledger.read()).filter((entry) => entry.record.kind === 'model.requested')).toHaveLength(2)
    expect((await ledger.read()).some((entry) => entry.record.kind === 'action.intended')).toBe(false)
  })

  it('does not repair an answer error', async () => {
    const { ledger } = ledgerA()
    const runtime = await openJevRuntime(
      fixture(ledger, {
        onInvoke(call) {
          const questions = (call.input as { questions: Record<string, JsonValue> }).questions
          return { output: decisionAnswers(questions, { purpose: 'RESPOND' }) }
        },
        onLanguage() {
          return {
            error: {
              code: 'LANGUAGE_TOOL_CALL',
              message: 'Answer carried a native tool call',
              retryable: true,
            },
          }
        },
      }),
      config,
    )
    const result = await runtime.run(turn, [input])
    expect(result.status).toBe('failed')
    expect(result.reason).toContain(
      'Language answer failed (LANGUAGE_TOOL_CALL): Answer carried a native tool call',
    )
    expect((await ledger.read()).filter((entry) => entry.record.kind === 'model.requested')).toHaveLength(2)
  })

  it('does not request a format repair after cancellation during its preparation', async () => {
    const { ledger } = ledgerA()
    const original = fixture(ledger, {
      onLanguage() {
        return invalidHelper
      },
    })
    let entered!: () => void
    let release!: () => void
    const preparing = new Promise<void>((resolve) => {
      entered = resolve
    })
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const runtime = await openJevRuntime(
      {
        ...original,
        language: {
          ...original.language,
          async prepare(model, signal) {
            if (model.repair) {
              entered()
              await released
            }
            return original.language.prepare(model, signal)
          },
        },
      },
      config,
    )
    const running = runtime.run(turn, [input])
    await preparing
    runtime.cancel()
    release()
    expect((await running).status).toBe('cancelled')
    expect((await ledger.read()).filter((entry) => entry.record.kind === 'model.requested')).toHaveLength(2)
    expect((await ledger.read()).some((entry) => entry.record.kind === 'action.intended')).toBe(false)
  })

  it('does not prepare a repair after its failed settlement commit', async () => {
    const { ledger } = ledgerA()
    let helperCalls = 0
    const rejecting: RuntimeLedger<number> = {
      ...ledger,
      async commit(record) {
        if (record.kind === 'model.settled' && record.settlement.error?.code === 'LANGUAGE_INVALID_JSON') {
          throw new Error('format settlement commit failed')
        }
        return ledger.commit(record)
      },
    }
    const runtime = await openJevRuntime(
      fixture(rejecting, {
        onLanguage() {
          helperCalls++
          return invalidHelper
        },
      }),
      config,
    )
    await expect(runtime.run(turn, [input])).rejects.toThrow('format settlement commit failed')
    expect(helperCalls).toBe(1)
    expect((await ledger.read()).filter((entry) => entry.record.kind === 'model.requested')).toHaveLength(2)
    expect((await ledger.read()).some((entry) => entry.record.kind === 'action.intended')).toBe(false)
  })

  it('executes a current complete candidate without a language helper', async () => {
    const { ledger } = ledgerA()
    const candidate: Candidate = {
      id: brandString<CandidateId>('c1'),
      tool: tool.name,
      label: 'observed exact call',
      arguments: { exact: true },
      sourceRecordIds: [],
      environmentEpoch: epoch,
      toolRevision: tool.revision,
    }
    const calls: JsonValue[] = []
    const runtime = await openJevRuntime(
      fixture(ledger, {
        candidate,
        binding: 'c1',
        onExecute(intent) {
          calls.push(intent.arguments)
        },
        onLanguage() {
          throw new Error('language helper was not needed')
        },
      }),
      config,
    )
    expect((await runtime.run(turn, [input])).status).toBe('completed')
    expect(calls).toEqual([{ exact: true }])
    expect((await ledger.read()).filter((entry) => entry.record.kind === 'model.requested')).toHaveLength(1)
  })

  it('locks a weak candidate binding and accepts only full language-authored arguments', async () => {
    const { ledger } = ledgerA()
    const candidate: Candidate = {
      id: brandString<CandidateId>('c1'),
      tool: tool.name,
      label: 'observed call',
      arguments: { inherited: 'must not leak' },
      sourceRecordIds: [],
      environmentEpoch: epoch,
      toolRevision: tool.revision,
    }
    const calls: JsonValue[] = []
    const runtime = await openJevRuntime(
      fixture(ledger, {
        candidate,
        binding: 'LLM_PARAMETERS',
        helper: { kind: 'call', name: tool.name, arguments: { fresh: true } },
        onExecute(intent) {
          calls.push(intent.arguments)
        },
      }),
      config,
    )
    expect((await runtime.run(turn, [input])).status).toBe('completed')
    expect(calls).toEqual([{ fresh: true }])
    const language = (await ledger.read()).find(
      (entry) => entry.record.kind === 'model.requested' && entry.record.call.purpose === 'parameters',
    )
    expect(language).toBeDefined()
  })

  it('drops a candidate with missing source evidence before Jev can bind it', async () => {
    const { ledger } = ledgerA()
    const candidate: Candidate = {
      id: brandString<CandidateId>('stale'),
      tool: tool.name,
      label: 'old call',
      arguments: { stale: true },
      sourceRecordIds: [brandString<RecordId>('missing-record')],
      environmentEpoch: epoch,
      toolRevision: tool.revision,
    }
    const calls: JsonValue[] = []
    const runtime = await openJevRuntime(
      fixture(ledger, {
        candidate,
        binding: 'stale',
        helper: { kind: 'call', name: tool.name, arguments: { fresh: true } },
        onExecute(intent) {
          calls.push(intent.arguments)
        },
      }),
      config,
    )
    expect((await runtime.run(turn, [input])).status).toBe('completed')
    expect(calls).toEqual([{ fresh: true }])
    const chosen = (await ledger.read()).find((entry) => entry.record.kind === 'decision.selected')?.record
    expect(chosen?.kind === 'decision.selected' && chosen.candidateId).toBeUndefined()
  })

  it('rejects an operation change from the parameter helper before intent', async () => {
    const { ledger } = ledgerA()
    const runtime = await openJevRuntime(
      fixture(ledger, {
        helper: { kind: 'call', name: 'other_tool', arguments: {} },
      }),
      config,
    )
    expect((await runtime.run(turn, [input])).status).toBe('budget')
    expect((await ledger.read()).some((entry) => entry.record.kind === 'action.intended')).toBe(false)
    expect(
      (await ledger.read()).filter(
        (entry) =>
          entry.record.kind === 'resource.observed' &&
          typeof entry.record.resource === 'object' &&
          entry.record.resource !== null &&
          !Array.isArray(entry.record.resource) &&
          entry.record.resource.code === 'INVALID_PARAMETERS',
      ),
    ).toHaveLength(1)
  })

  it('uses separate arbitration and answer requests after low operation confidence', async () => {
    const { ledger } = ledgerA()
    const runtime = await openJevRuntime(
      fixture(ledger, {
        confidence: 0.2,
        helper: { kind: 'answer' },
        onExecute() {
          throw new Error('unexpected tool')
        },
      }),
      config,
    )
    expect((await runtime.run(turn, [input])).status).toBe('completed')
    const requests = (await ledger.read()).filter((entry) => entry.record.kind === 'model.requested')
    expect(
      requests.map((entry) => entry.record.kind === 'model.requested' && entry.record.call.purpose),
    ).toEqual(['decision', 'arbitration', 'answer'])
    expect((await ledger.read()).some((entry) => entry.record.kind === 'action.dispatching')).toBe(false)
  })

  it('stops when Jev is unavailable instead of entering a language-only loop', async () => {
    const { ledger } = ledgerA()
    const runtime = await openJevRuntime(
      fixture(ledger, {
        onInvoke() {
          return { error: { code: 'UNAVAILABLE', message: 'no backend', retryable: true } }
        },
        onLanguage() {
          throw new Error('language fallback is forbidden')
        },
      }),
      config,
    )
    expect((await runtime.run(turn, [input])).status).toBe('failed')
    expect((await ledger.read()).filter((entry) => entry.record.kind === 'model.requested')).toHaveLength(1)
  })

  it('does not request a model after host step rejection', async () => {
    const { ledger } = ledgerA()
    const runtime = await openJevRuntime(
      fixture(ledger, {
        admitStep: {
          async admitStep() {
            return { kind: 'reject' }
          },
          async stepSettled() {},
        },
      }),
      config,
    )
    expect((await runtime.run(turn, [input])).status).toBe('blocked')
    expect((await ledger.read()).some((entry) => entry.record.kind === 'model.requested')).toBe(false)
  })

  it('completes an empty host turn without requesting a model or calling beforeStop', async () => {
    const { ledger } = ledgerA()
    let settled = 0
    const runtime = await openJevRuntime(
      fixture(ledger, {
        onInvoke() {
          throw new Error('decision model must not run')
        },
        onLanguage() {
          throw new Error('language model must not run')
        },
        admitStep: {
          async admitStep(_turn, _step, initial) {
            expect(initial).toEqual([])
            return { kind: 'complete' }
          },
          async stepSettled() {
            settled++
          },
          async beforeStop() {
            throw new Error('beforeStop must not run')
          },
        },
      }),
      config,
    )
    expect((await runtime.run(turn, [])).status).toBe('completed')
    expect(settled).toBe(1)
    expect((await ledger.read()).map((entry) => entry.record.kind)).toEqual(['run.opened', 'run.stopped'])
  })

  it('stops at a model attempt budget before invoking a helper', async () => {
    const { ledger } = ledgerA()
    const runtime = await openJevRuntime(fixture(ledger), { ...config, maxModelAttempts: 1 })
    expect((await runtime.run(turn, [input])).status).toBe('budget')
    expect((await ledger.read()).filter((entry) => entry.record.kind === 'model.requested')).toHaveLength(1)
  })

  it('lets the host admit another step after a concluding tool', async () => {
    const { ledger } = ledgerA()
    let stops = 0
    let calls = 0
    const runtime = await openJevRuntime(
      fixture(ledger, {
        onExecute() {
          calls++
        },
        admitStep: {
          async admitStep(_turn, _step, initial) {
            return {
              kind: 'enter',
              inputs:
                stops === 0
                  ? initial
                  : [{ id: 'follow-up', source: 'host', content: [{ kind: 'text', text: 'new work' }] }],
            }
          },
          async stepSettled() {},
          async beforeStop() {
            return ++stops === 1
          },
        },
      }),
      config,
    )
    expect((await runtime.run(turn, [input])).status).toBe('completed')
    expect(calls).toBe(2)
    expect((await ledger.read()).filter((entry) => entry.record.kind === 'input.admitted')).toHaveLength(2)
  })

  it('stops explicitly when admitted history exceeds its bound', async () => {
    const { ledger } = ledgerA()
    let stops = 0
    const runtime = await openJevRuntime(
      fixture(ledger, {
        admitStep: {
          async admitStep(_turn, _step, initial) {
            return {
              kind: 'enter',
              inputs: stops === 0 ? initial : [{ id: 'next', source: 'host', content: [] }],
            }
          },
          async stepSettled() {},
          async beforeStop() {
            return ++stops === 1
          },
        },
      }),
      { ...config, maxHistory: 1 },
    )
    expect((await runtime.run(turn, [input])).status).toBe('budget')
    expect((await ledger.read()).filter((entry) => entry.record.kind === 'model.requested')).toHaveLength(2)
  })

  it('stops before a model request when newly admitted resources exceed the history bound', async () => {
    const { ledger } = ledgerA()
    const runtime = await openJevRuntime(
      fixture(ledger, {
        admitStep: {
          async admitStep(_turn, _step, inputs) {
            return { kind: 'enter', inputs, resources: [{ a: 1 }, { b: 2 }] }
          },
          async stepSettled() {},
        },
      }),
      { ...config, maxHistory: 1 },
    )
    expect((await runtime.run(turn, [input])).status).toBe('budget')
    expect((await ledger.read()).some((entry) => entry.record.kind === 'model.requested')).toBe(false)
  })

  it('awaits a dispatched call and drain after cancellation without replaying it', async () => {
    const { ledger } = ledgerA()
    let started!: () => void
    let finish!: () => void
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const released = new Promise<void>((resolve) => {
      finish = resolve
    })
    let drains = 0
    let calls = 0
    const runtime = await openJevRuntime(
      fixture(ledger, {
        async onExecute() {
          calls++
          started()
          await released
        },
        onDrain() {
          drains++
        },
      }),
      config,
    )
    const running = runtime.run(turn, [input])
    await entered
    runtime.cancel()
    let closed = false
    const closing = runtime.close().then(() => {
      closed = true
    })
    await Promise.resolve()
    expect(closed).toBe(false)
    finish()
    expect((await running).status).toBe('cancelled')
    await closing
    expect(calls).toBe(1)
    expect(drains).toBe(1)
    expect((await ledger.read()).filter((entry) => entry.record.kind === 'action.settled')).toHaveLength(1)
  })

  it('settles a stale intended action as not applied before dispatch', async () => {
    const { ledger } = ledgerA()
    const original = fixture(ledger)
    let snapshots = 0
    const runtime = await openJevRuntime(
      {
        ...original,
        environment: {
          ...original.environment,
          async snapshot() {
            snapshots++
            return { epoch: snapshots === 3 ? brandString<EnvironmentEpoch>('changed') : epoch, facts: {} }
          },
          async execute() {
            throw new Error('stale action dispatched')
          },
        },
      },
      { ...config, maxNoProgress: 1 },
    )
    const runResult = await runtime.run(turn, [input])
    expect(runResult.status, runResult.reason).toBe('budget')
    const records = (await ledger.read()).map((entry) => entry.record)
    expect(records.some((record) => record.kind === 'action.dispatching')).toBe(false)
    expect(
      records.find((record) => record.kind === 'action.settled' && record.effect === 'not_applied'),
    ).toBeDefined()
  })

  it('poisons the driver when drain fails after dispatch and reopens as UNKNOWN', async () => {
    const { ledger } = ledgerA()
    const runtime = await openJevRuntime(
      fixture(ledger, {
        onDrain() {
          throw new Error('drain lost ownership')
        },
      }),
      config,
    )
    await expect(runtime.run(turn, [input])).rejects.toThrow('drain lost ownership')
    expect((await ledger.read()).some((entry) => entry.record.kind === 'action.dispatching')).toBe(true)
    expect((await ledger.read()).some((entry) => entry.record.kind === 'action.settled')).toBe(false)
    const reopened = await openJevRuntime(fixture(ledger), config)
    expect((await reopened.run(turn, [])).status).toBe('blocked')
  })

  it('cancels asynchronous model preparation before a request is committed', async () => {
    const { ledger } = ledgerA()
    const original = fixture(ledger)
    let entered!: () => void
    let release!: () => void
    const preparing = new Promise<void>((resolve) => {
      entered = resolve
    })
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    let signalSeen: AbortSignal | undefined
    const runtime = await openJevRuntime(
      {
        ...original,
        decision: {
          ...original.decision,
          async prepare(input, signal) {
            signalSeen = signal
            entered()
            await released
            return original.decision.prepare(input, signal)
          },
        },
      },
      config,
    )
    const running = runtime.run(turn, [input])
    await preparing
    runtime.cancel()
    expect(signalSeen?.aborted).toBe(true)
    release()
    expect((await running).status).toBe('cancelled')
    expect((await ledger.read()).some((entry) => entry.record.kind === 'model.requested')).toBe(false)
  })

  it('reconstructs a prior real answer and its host snapshot for the next turn', async () => {
    const { ledger } = ledgerA()
    const original = fixture(ledger, {
      onInvoke(call) {
        const questions = (call.input as { questions: Record<string, JsonValue> }).questions
        return { output: decisionAnswers(questions, { purpose: 'RESPOND' }) }
      },
      onLanguage() {
        return {
          output: { kind: 'answer', content: [{ kind: 'text', text: 'first answer' }] },
          snapshot: { codec: 'dsh-assistant-stream-v1', response: { chunks: ['first answer'] } },
        }
      },
    })
    const seen: InputFact[][] = []
    const runtime = await openJevRuntime(
      {
        ...original,
        language: {
          ...original.language,
          async prepare(model, signal) {
            seen.push([...model.history])
            return original.language.prepare(model, signal)
          },
        },
      },
      config,
    )
    expect((await runtime.run(turn, [input])).status).toBe('completed')
    expect(
      (await runtime.run(brandString<TurnId>('turn-2'), [{ id: 'u2', source: 'user', content: [] }])).status,
    ).toBe('completed')
    expect(seen[1]?.find((fact) => fact.source === 'assistant')).toMatchObject({
      content: [{ kind: 'text', text: 'first answer' }],
      snapshot: { codec: 'dsh-assistant-stream-v1', value: { chunks: ['first answer'] } },
    })
  })

  it('does not replay a completed turn and refuses changed resumed budgets', async () => {
    const done = ledgerA()
    let calls = 0
    const runtime = await openJevRuntime(
      fixture(done.ledger, {
        onExecute() {
          calls++
        },
      }),
      config,
    )
    expect((await runtime.run(turn, [input])).status).toBe('completed')
    expect((await runtime.run(turn, [input])).status).toBe('completed')
    expect(calls).toBe(1)

    const pending = ledgerA()
    const opened: RuntimeRecord = {
      version: 1,
      id: brandString<RecordId>('opened'),
      turn,
      kind: 'run.opened',
      config,
      runtimeVersion: '1',
    }
    await pending.ledger.commit(opened)
    const changed = await openJevRuntime(fixture(pending.ledger), { ...config, maxSteps: 4 })
    await expect(changed.run(turn, [])).rejects.toThrow('different runtime configuration')
  })

  it('refuses unfinished routing version 3 before invoking a model or tool', async () => {
    const { ledger } = ledgerA()
    await ledger.commit({
      version: 1,
      id: brandString<RecordId>('opened-v3'),
      turn,
      kind: 'run.opened',
      config,
      runtimeVersion: '3',
    })
    const runtime = await openJevRuntime(
      fixture(ledger, {
        onInvoke() {
          throw new Error('Old routing version invoked the model')
        },
        onExecute() {
          throw new Error('Old routing version dispatched a tool')
        },
      }),
      config,
    )
    await expect(runtime.run(turn, [])).rejects.toThrow('different runtime configuration')
    expect(await ledger.read()).toHaveLength(1)
  })

  it.each([-0.1, 1.1, Infinity, NaN])(
    'rejects invalid equivalent support threshold %s before opening',
    async (equivalentSupportThreshold) => {
      const { ledger } = ledgerA()
      await expect(
        openJevRuntime(fixture(ledger), { ...config, equivalentSupportThreshold }),
      ).rejects.toThrow('Invalid equivalentSupportThreshold')
      expect(await ledger.read()).toEqual([])
    },
  )

  it('rejects the retired ambiguity relaxation setting instead of ignoring it', async () => {
    const { ledger } = ledgerA()
    await expect(openJevRuntime(fixture(ledger), { ...config, ambiguityGate: 0.1 })).rejects.toThrow(
      'ambiguityGate must be null',
    )
    expect(await ledger.read()).toEqual([])
  })

  it('refuses an unserializable action result before settlement and requires reopen', async () => {
    const { ledger } = ledgerA()
    const original = fixture(ledger)
    const runtime = await openJevRuntime(
      {
        ...original,
        environment: {
          ...original.environment,
          async execute() {
            return { ...outcome, value: { invalid: Number.NaN } }
          },
        },
      },
      config,
    )
    await expect(runtime.run(turn, [input])).rejects.toThrow('Invalid action.settled')
    expect((await ledger.read()).some((entry) => entry.record.kind === 'action.dispatching')).toBe(true)
    expect((await ledger.read()).some((entry) => entry.record.kind === 'action.settled')).toBe(false)
    expect(() => runtime.run(brandString<TurnId>('new'), [])).toThrow('reopen')
  })

  it('keeps the step budget across a reopened turn', async () => {
    const { ledger } = ledgerA()
    const original = fixture(ledger)
    const ports = {
      ...original,
      environment: {
        ...original.environment,
        async execute() {
          return { ...outcome, directive: { conclude: false, additions: [] } }
        },
      },
    }
    const limited = { ...config, maxSteps: 1 }
    const first = await openJevRuntime(ports, limited)
    expect((await first.run(turn, [input])).status).toBe('budget')
    const requests = (await ledger.read()).filter((entry) => entry.record.kind === 'model.requested').length
    const reopened = await openJevRuntime(ports, limited)
    expect((await reopened.run(turn, [])).status).toBe('budget')
    expect((await ledger.read()).filter((entry) => entry.record.kind === 'model.requested')).toHaveLength(
      requests,
    )
  })

  it('arbitrates a malformed Jev choice without authorizing its proposed action', async () => {
    const { ledger } = ledgerA()
    const runtime = await openJevRuntime(
      fixture(ledger, {
        onInvoke() {
          return {
            output: {
              answers: {
                purpose: {
                  type: 'choice',
                  choice: 'ACT',
                  confidence: 1,
                  probabilities: { ACT: 0.1, RESPOND: 0.9 },
                },
              },
            },
          }
        },
        helper: { kind: 'answer' },
        onExecute() {
          throw new Error('invalid Jev action executed')
        },
      }),
      config,
    )
    expect((await runtime.run(turn, [input])).status).toBe('completed')
    const records = (await ledger.read()).map((entry) => entry.record)
    expect(records.filter((record) => record.kind === 'decision.selected')).toHaveLength(1)
    expect(records.some((record) => record.kind === 'action.intended')).toBe(false)
  })

  it('marks a thrown host execution UNKNOWN after draining', async () => {
    const { ledger } = ledgerA()
    let drained = false
    const runtime = await openJevRuntime(
      fixture(ledger, {
        onExecute() {
          throw new Error('partial mutation possible')
        },
        onDrain() {
          drained = true
        },
      }),
      config,
    )
    const result = await runtime.run(turn, [input])
    expect(result.status).toBe('blocked')
    expect(drained).toBe(true)
    expect(
      (await ledger.read()).find(
        (entry) => entry.record.kind === 'action.settled' && entry.record.effect === 'unknown',
      ),
    ).toBeDefined()
  })

  it('retains a generic result when optional observation enrichment fails', async () => {
    const { ledger } = ledgerA()
    const original = fixture(ledger)
    const runtime = await openJevRuntime(
      {
        ...original,
        semantics: {
          candidates() {
            return []
          },
          observations() {
            throw new Error('bad enrichment')
          },
          effectDisposition() {
            return undefined
          },
        },
      },
      config,
    )
    expect((await runtime.run(turn, [input])).status).toBe('completed')
    const action = (await ledger.read()).find((entry) => entry.record.kind === 'action.settled')?.record
    expect(action?.kind === 'action.settled' && action.observations.map((item) => item.kind)).toEqual([
      'tool.result',
      'enrichment.error',
    ])
  })

  it('requires artifact retention before recording a dispatched result', async () => {
    const { ledger } = ledgerA()
    const original = fixture(ledger)
    const runtime = await openJevRuntime(
      {
        ...original,
        environment: {
          ...original.environment,
          async execute() {
            return {
              ...outcome,
              content: [
                {
                  kind: 'artifact' as const,
                  artifact: { id: 'a', digest: 'd', size: 3, mediaType: 'text/plain' },
                },
              ],
            }
          },
        },
        artifacts: {
          ...original.artifacts,
          async retain() {
            throw new Error('artifact unavailable')
          },
        },
      },
      config,
    )
    await expect(runtime.run(turn, [input])).rejects.toThrow('artifact unavailable')
    expect((await ledger.read()).some((entry) => entry.record.kind === 'action.dispatching')).toBe(true)
    expect((await ledger.read()).some((entry) => entry.record.kind === 'action.settled')).toBe(false)
  })
})

describe('recorded recovery and progress', () => {
  function respond(call: PreparedModelCall): ModelSettlement {
    const questions = (call.input as { questions: Record<string, JsonValue> }).questions
    return { output: decisionAnswers(questions, { purpose: 'RESPOND' }) }
  }

  it('records a parameter refusal and lets the next Jev request reconsider without an intent', async () => {
    const { ledger } = ledgerA()
    let decisions = 0
    const decisionStates: JsonValue[] = []
    const runtime = await openJevRuntime(
      fixture(ledger, {
        onInvoke(call) {
          const body = call.input as { questions: JsonValue; state: JsonValue }
          decisionStates.push(body.state)
          return decisions++ === 0 ? { output: decision(body.questions) } : respond(call)
        },
        onLanguage(call) {
          return {
            output:
              call.purpose === 'parameters'
                ? { kind: 'cannot_bind', reason: 'Need a different operation' }
                : call.purpose === 'arbitration'
                  ? { kind: 'answer' }
                  : {
                      kind: 'answer',
                      content: [{ kind: 'text', text: 'Cannot use the selected operation' }],
                    },
          }
        },
        onExecute() {
          throw new Error('declined parameters authorized execution')
        },
      }),
      config,
    )
    expect((await runtime.run(turn, [input])).status).toBe('completed')
    expect(decisions).toBe(2)
    expect(JSON.stringify(decisionStates[1])).toContain('BINDING_DECLINED')
    const records = (await ledger.read()).map((entry) => entry.record)
    const refusal = records.find(
      (record) =>
        record.kind === 'resource.observed' &&
        typeof record.resource === 'object' &&
        record.resource !== null &&
        !Array.isArray(record.resource) &&
        record.resource.code === 'BINDING_DECLINED',
    )
    const parameterRequest = records.find(
      (record) => record.kind === 'model.requested' && record.call.purpose === 'parameters',
    )
    expect(refusal).toMatchObject({
      resource: {
        sourceRecordId: parameterRequest?.id,
        operation: tool.name,
        message: 'Need a different operation',
      },
    })
    expect(records.some((record) => record.kind === 'action.intended')).toBe(false)
  })

  it('recovers a schema-invalid authored call but keeps an untyped host denial terminal', async () => {
    const { ledger } = ledgerA()
    let decisions = 0
    const base = fixture(ledger, {
      onInvoke(call) {
        return decisions++ === 0
          ? { output: decision((call.input as { questions: JsonValue }).questions) }
          : respond(call)
      },
      onLanguage(call) {
        return {
          output:
            call.purpose === 'arbitration'
              ? { kind: 'answer' }
              : call.purpose === 'answer'
                ? { kind: 'answer', content: [{ kind: 'text', text: 'Cannot call this tool' }] }
                : authoredCall(call, { invalid: true }),
        }
      },
    })
    const ports: RuntimePorts<number> = {
      ...base,
      environment: {
        ...base.environment,
        async validate(definition, args, preconditions) {
          if (typeof args === 'object' && args !== null && !Array.isArray(args) && args.invalid === true) {
            throw new InvalidAuthoredArguments('Required field missing')
          }
          return base.environment.validate(definition, args, preconditions)
        },
      },
    }
    const runtime = await openJevRuntime(ports, config)
    expect((await runtime.run(turn, [input])).status).toBe('completed')
    const records = (await ledger.read()).map((entry) => entry.record)
    expect(
      records.some(
        (record) =>
          record.kind === 'resource.observed' &&
          typeof record.resource === 'object' &&
          record.resource !== null &&
          !Array.isArray(record.resource) &&
          record.resource.code === 'INVALID_PARAMETERS',
      ),
    ).toBe(true)
    expect(records.some((record) => record.kind === 'action.intended')).toBe(false)

    const other = ledgerA()
    const denied = fixture(other.ledger)
    const terminal = await openJevRuntime(
      {
        ...denied,
        environment: {
          ...denied.environment,
          async validate() {
            throw new Error('permission denied')
          },
        },
      },
      config,
    )
    expect((await terminal.run(turn, [input])).status).toBe('failed')
    expect(
      (await other.ledger.read()).some(
        (entry) =>
          entry.record.kind === 'resource.observed' &&
          typeof entry.record.resource === 'object' &&
          entry.record.resource !== null &&
          !Array.isArray(entry.record.resource) &&
          entry.record.resource.kind === 'jev.runtime.feedback.v1',
      ),
    ).toBe(false)
  })

  it('bounds sustained invalid Jev selections before LLM arbitration can own every step', async () => {
    const { ledger } = ledgerA()
    let decisions = 0
    let arbitrations = 0
    let executions = 0
    const runtime = await openJevRuntime(
      fixture(ledger, {
        onInvoke() {
          decisions++
          return { output: { answers: { purpose: { type: 'choice', choice: 'ACT' } } } }
        },
        onLanguage(call) {
          if (call.purpose === 'arbitration') arbitrations++
          return { output: authoredCall(call, { exact: true }) }
        },
        onExecute() {
          executions++
        },
        onResult() {
          return { ...outcome, directive: { conclude: false, additions: [] } }
        },
      }),
      { ...config, maxSteps: 5, maxModelAttempts: 10 },
    )
    const result = await runtime.run(turn, [input])
    expect(result.status).toBe('budget')
    expect(result.reason).toContain('invalid decisions')
    expect(decisions).toBe(2)
    expect(arbitrations).toBe(1)
    expect(executions).toBe(1)
    expect((await ledger.read()).filter((entry) => entry.record.kind === 'action.dispatching')).toHaveLength(
      1,
    )
  })

  it.each(['direct', 'parameters'] as const)(
    'refuses a third identical dispatch through the %s route',
    async (route) => {
      const { ledger } = ledgerA()
      let executions = 0
      const runtime = await openJevRuntime(
        fixture(ledger, {
          ...(route === 'direct'
            ? {
                binding: 'c1',
                candidate: {
                  id: brandString<CandidateId>('repeat'),
                  tool: tool.name,
                  label: 'Same complete call',
                  arguments: { exact: true },
                  sourceRecordIds: [],
                  environmentEpoch: epoch,
                  toolRevision: tool.revision,
                },
              }
            : {}),
          onExecute() {
            executions++
          },
          onResult() {
            return { ...outcome, directive: { conclude: false, additions: [] } }
          },
        }),
        { ...config, maxSteps: 5, maxModelAttempts: 10, maxRepeatedFailures: 3 },
      )
      expect((await runtime.run(turn, [input])).status).toBe('budget')
      expect(executions).toBe(2)
      const records = (await ledger.read()).map((entry) => entry.record)
      expect(records.filter((record) => record.kind === 'action.dispatching')).toHaveLength(2)
      expect(
        records.some(
          (record) =>
            record.kind === 'resource.observed' &&
            typeof record.resource === 'object' &&
            record.resource !== null &&
            !Array.isArray(record.resource) &&
            record.resource.code === 'DUPLICATE_NO_PROGRESS',
        ),
      ).toBe(true)
    },
  )

  it.each(['direct', 'parameters'] as const)(
    'allows a later %s reread after genuinely new successful evidence',
    async (route) => {
      const { ledger } = ledgerA()
      const calls: JsonValue[] = []
      const base = fixture(ledger, {
        onInvoke(call) {
          const questions = (call.input as { questions: JsonValue }).questions
          return { output: decision(questions, calls.length === 2 ? 'c2' : 'c1') }
        },
        onLanguage(call) {
          expect(call.purpose).toBe('parameters')
          return { output: authoredCall(call, { path: calls.length === 2 ? 'b' : 'a' }) }
        },
        onExecute(intent) {
          calls.push(intent.arguments)
        },
        onResult() {
          return { ...outcome, directive: { conclude: calls.length === 4, additions: [] } }
        },
      })
      const ports: RuntimePorts<number> = {
        ...base,
        semantics: {
          ...base.semantics!,
          candidates() {
            return route === 'parameters'
              ? []
              : ['a', 'b'].map(
                  (path): Candidate => ({
                    id: brandString<CandidateId>(path),
                    tool: tool.name,
                    label: `Read ${path}`,
                    arguments: { path },
                    sourceRecordIds: [],
                    environmentEpoch: epoch,
                    toolRevision: tool.revision,
                  }),
                )
          },
        },
      }
      const runtime = await openJevRuntime(ports, { ...config, maxSteps: 4, maxModelAttempts: 8 })
      const result = await runtime.run(turn, [input])
      expect(result.status, result.reason).toBe('completed')
      expect(calls).toEqual([{ path: 'a' }, { path: 'a' }, { path: 'b' }, { path: 'a' }])
      expect(
        resources(
          (await ledger.read()).map((entry) => entry.record),
          'jev.runtime.feedback.v1',
        ),
      ).toEqual([])
    },
  )

  it.each(['direct', 'parameters'] as const)(
    'shares repeat protection when alternating from %s to the other argument route',
    async (first) => {
      const { ledger } = ledgerA()
      const preconditions = { codec: 'test-locator-v1', path: 'a' }
      let decisions = 0
      let executions = 0
      let helpers = 0
      const runtime = await openJevRuntime(
        fixture(ledger, {
          candidate: {
            id: brandString<CandidateId>('same-read'),
            tool: tool.name,
            label: 'Read a',
            arguments: { path: 'a' },
            preconditions,
            sourceRecordIds: [],
            environmentEpoch: epoch,
            toolRevision: tool.revision,
          },
          onInvoke(call) {
            const direct = ++decisions % 2 === (first === 'direct' ? 1 : 0)
            return {
              output: decision(
                (call.input as { questions: JsonValue }).questions,
                direct ? 'c1' : 'LLM_PARAMETERS',
              ),
            }
          },
          onLanguage(call) {
            expect(call.purpose).toBe('parameters')
            helpers++
            return { output: authoredCall(call, { path: 'a' }) }
          },
          onExecute(intent) {
            executions++
            expect(intent.arguments).toEqual({ path: 'a' })
          },
          onResult() {
            return { ...outcome, directive: { conclude: false, additions: [] } }
          },
        }),
        { ...config, maxSteps: 4, maxModelAttempts: 8 },
      )
      expect((await runtime.run(turn, [input])).status).toBe('budget')
      expect(executions).toBe(2)
      expect(decisions).toBe(3)
      expect(helpers).toBe(first === 'direct' ? 1 : 2)
      const records = (await ledger.read()).map((entry) => entry.record)
      expect(
        records.flatMap((record) => (record.kind === 'action.intended' ? [record.intent.preconditions] : [])),
      ).toEqual(first === 'direct' ? [preconditions, undefined] : [undefined, preconditions])
      expect(resources(records, 'jev.runtime.feedback.v1')).toMatchObject([{ code: 'DUPLICATE_NO_PROGRESS' }])
    },
  )

  it('treats different queries with empty matches as distinct observed work', async () => {
    const { ledger } = ledgerA()
    let decisions = 0
    let parameters = 0
    const calls: JsonValue[] = []
    const runtime = await openJevRuntime(
      fixture(ledger, {
        onInvoke(call) {
          return ++decisions === 3
            ? respond(call)
            : { output: decision((call.input as { questions: JsonValue }).questions) }
        },
        onLanguage(call) {
          return call.purpose === 'parameters'
            ? { output: authoredCall(call, { pattern: parameters++ === 0 ? 'alpha' : 'beta' }) }
            : { output: { kind: 'answer', content: [{ kind: 'text', text: 'Neither pattern matched' }] } }
        },
        onExecute(intent) {
          calls.push(intent.arguments)
        },
        onResult() {
          return {
            ...outcome,
            value: { matches: [] },
            content: [],
            directive: { conclude: false, additions: [] },
          }
        },
      }),
      { ...config, maxNoProgress: 1 },
    )
    expect((await runtime.run(turn, [input])).status).toBe('completed')
    expect(calls).toEqual([{ pattern: 'alpha' }, { pattern: 'beta' }])
    expect((await ledger.read()).filter((entry) => entry.record.kind === 'action.dispatching')).toHaveLength(
      2,
    )
  })

  it('ignores per-dispatch observation locators when the outcome has not changed', async () => {
    const { ledger } = ledgerA()
    let executions = 0
    const base = fixture(ledger, {
      onExecute() {
        executions++
      },
      onResult() {
        return { ...outcome, directive: { conclude: false, additions: [] } }
      },
    })
    const ports: RuntimePorts<number> = {
      ...base,
      semantics: {
        candidates() {
          return []
        },
        observations(_tool, _result, intent) {
          return [
            {
              kind: 'native.result',
              source: 'host-tool',
              data: {
                intentId: intent.id,
                source: `dispatch-${executions}`,
                toolRevision: intent.toolRevision,
                epoch: intent.environmentEpoch,
              },
            },
          ]
        },
        effectDisposition() {
          return undefined
        },
      },
    }
    const runtime = await openJevRuntime(ports, {
      ...config,
      maxSteps: 5,
      maxModelAttempts: 10,
      maxRepeatedFailures: 3,
    })
    expect((await runtime.run(turn, [input])).status).toBe('budget')
    expect(executions).toBe(2)
    const records = (await ledger.read()).map((entry) => entry.record)
    const actions = records.filter((record) => record.kind === 'action.settled')
    expect(actions).toHaveLength(2)
    expect(
      actions.every(
        (record) => record.observations.map((observation) => observation.kind).join(',') === 'native.result',
      ),
    ).toBe(true)
    expect(
      records.some(
        (record) =>
          record.kind === 'resource.observed' &&
          typeof record.resource === 'object' &&
          record.resource !== null &&
          !Array.isArray(record.resource) &&
          record.resource.code === 'DUPLICATE_NO_PROGRESS',
      ),
    ).toBe(true)
  })

  it('retains duplicate detection when the environment epoch changes on reopen', async () => {
    const { ledger } = ledgerA()
    let executions = 0
    let settledSteps = 0
    const options = {
      onExecute() {
        executions++
      },
      onResult() {
        return { ...outcome, directive: { conclude: false, additions: [] } }
      },
    }
    const firstPorts = fixture(ledger, {
      ...options,
      admitStep: {
        async admitStep(_turn, _step, inputs) {
          return { kind: 'enter', inputs }
        },
        async stepSettled() {
          if (++settledSteps === 2) throw new Error('host step hook failed')
        },
      },
    })
    const bounded = { ...config, maxSteps: 5, maxNoProgress: 3, maxModelAttempts: 12, maxRepeatedFailures: 3 }
    const first = await openJevRuntime(firstPorts, bounded)
    expect((await first.run(turn, [input])).status).toBe('failed')
    expect(executions).toBe(2)

    const base = fixture(ledger, options)
    const nextEpoch = brandString<EnvironmentEpoch>('epoch-after-reopen')
    const resumed = await openJevRuntime(
      {
        ...base,
        environment: {
          ...base.environment,
          async snapshot() {
            return { epoch: nextEpoch, facts: { cwd: '/workspace' } }
          },
        },
      },
      bounded,
    )
    expect((await resumed.run(turn, [])).status).toBe('budget')
    expect(executions).toBe(2)
    expect(
      (await ledger.read()).some(
        (entry) =>
          entry.record.kind === 'resource.observed' &&
          typeof entry.record.resource === 'object' &&
          entry.record.resource !== null &&
          !Array.isArray(entry.record.resource) &&
          entry.record.resource.code === 'DUPLICATE_NO_PROGRESS',
      ),
    ).toBe(true)
  })

  it('rebuilds every decision offer from newly committed settlements and retires consumed choices', async () => {
    const { ledger, entries } = ledgerA()
    let executions = 0
    const offered: string[][] = []
    const contexts: NonNullable<
      Parameters<NonNullable<RuntimePorts<number>['semantics']>['candidates']>[3]
    >[] = []
    const base = fixture(ledger, {
      onResult() {
        return {
          ...outcome,
          value: { remaining: ++executions === 1 ? ['left', 'right'] : executions === 2 ? ['right'] : [] },
          directive: { conclude: false, additions: [] },
        }
      },
      onInvoke(call) {
        const questions = (call.input as { questions: Record<string, JsonValue> }).questions
        const binding = questions['binding_native_tool'] as
          | { criteria: Record<string, JsonValue> }
          | undefined
        const options = Object.keys(binding?.criteria ?? {}).filter((key) => key !== 'LLM_PARAMETERS')
        offered.push(options.map((key) => bindingValue(binding?.criteria[key]).description as string))
        if (executions === 3) return { output: decisionAnswers(questions, { purpose: 'RESPOND' }) }
        return { output: decision(questions, options[0]) }
      },
    })
    const ports: RuntimePorts<number> = {
      ...base,
      semantics: {
        ...base.semantics!,
        candidates(_tool, _observations, _epoch, context) {
          if (context === undefined) throw new Error('Missing committed candidate context')
          expect(contexts).not.toContain(context)
          contexts.push(context)
          expect(
            context.records.every((record) =>
              ['environment.observed', 'resource.observed', 'action.intended', 'action.settled'].includes(
                record.kind,
              ),
            ),
          ).toBe(true)
          expect(context.records.map((record) => record.id)).not.toContain(
            entries.find((entry) => entry.payload.kind === 'input.admitted')?.payload.id,
          )
          const latest = context.records.findLast((record) => record.kind === 'action.settled')
          if (latest?.kind !== 'action.settled') return []
          const value = latest.outcome.value as { remaining: string[] }
          return value.remaining.map(
            (item, index): Candidate => ({
              id: brandString<CandidateId>(item),
              tool: tool.name,
              label: item,
              arguments: { item },
              sourceRecordIds: [latest.id],
              environmentEpoch: epoch,
              toolRevision: tool.revision,
              evidence: [
                { sourceRecordId: latest.id, pointer: `/outcome/value/remaining/${index}`, value: item },
              ],
            }),
          )
        },
      },
    }
    expect((await (await openJevRuntime(ports, { ...config, maxSteps: 4 })).run(turn, [input])).status).toBe(
      'completed',
    )
    expect(offered).toEqual([[], ['left', 'right'], ['right'], []])
    const requests = (await ledger.read()).flatMap((entry) =>
      entry.record.kind === 'model.requested' ? [entry.record.call.purpose] : [],
    )
    expect(requests.filter((purpose) => purpose === 'parameters')).toHaveLength(1)
    expect(requests.filter((purpose) => purpose === 'arbitration')).toHaveLength(0)
  })

  it('deduplicates validated invocations before charging the offer budget and dispatches without a helper', async () => {
    const { ledger } = ledgerA()
    let helpers = 0
    const candidates: Candidate[] = [
      {
        id: brandString<CandidateId>('stale'),
        tool: tool.name,
        label: 'Stale',
        arguments: { path: 'one' },
        sourceRecordIds: [],
        environmentEpoch: epoch,
        toolRevision: tool.revision,
        preconditions: { stale: true },
      },
      ...['one', 'duplicate', 'two'].map(
        (id): Candidate => ({
          id: brandString<CandidateId>(id),
          tool: tool.name,
          label: id,
          arguments: { path: id === 'two' ? 'two' : 'one' },
          sourceRecordIds: [],
          environmentEpoch: epoch,
          toolRevision: tool.revision,
        }),
      ),
    ]
    const base = fixture(ledger, {
      onInvoke(call) {
        const questions = (call.input as { questions: Record<string, JsonValue> }).questions
        expect(
          Object.keys((questions['binding_native_tool'] as { criteria: Record<string, JsonValue> }).criteria),
        ).toEqual(['LLM_PARAMETERS', 'c1', 'c2'])
        return { output: decision(questions, 'c2') }
      },
      onLanguage() {
        helpers++
        throw new Error('Complete selected binding must execute directly')
      },
      onExecute(intent) {
        expect(intent.arguments).toEqual({ path: 'two' })
      },
    })
    const ports: RuntimePorts<number> = {
      ...base,
      environment: {
        ...base.environment,
        async validate(descriptor, args, preconditions) {
          if ((preconditions as { stale?: boolean } | undefined)?.stale) throw new Error('stale resource')
          return base.environment.validate(descriptor, args, preconditions)
        },
      },
      semantics: {
        ...base.semantics!,
        candidates() {
          return candidates
        },
      },
    }
    expect(
      (await (await openJevRuntime(ports, { ...config, maxCandidates: 2 })).run(turn, [input])).status,
    ).toBe('completed')
    expect(helpers).toBe(0)
    expect(
      (await ledger.read()).some(
        (entry) =>
          entry.record.kind === 'resource.observed' &&
          typeof entry.record.resource === 'object' &&
          entry.record.resource !== null &&
          !Array.isArray(entry.record.resource) &&
          entry.record.resource.kind === 'candidate.offer.summary' &&
          entry.record.resource.duplicates === 1 &&
          entry.record.resource.offered === 2,
      ),
    ).toBe(true)
  })

  it('offers newest valid bindings within the candidate limit and records omitted counts', async () => {
    const { ledger } = ledgerA()
    let decisions = 0
    let executions = 0
    const base = fixture(ledger, {
      onExecute() {
        executions++
      },
      onResult() {
        return { ...outcome, directive: { conclude: executions === 2, additions: [] } }
      },
      onInvoke(call) {
        const questions = (call.input as { questions: Record<string, JsonValue> }).questions
        decisions++
        if (decisions === 2) {
          const binding = questions['binding_native_tool'] as { criteria: Record<string, JsonValue> }
          expect(Object.keys(binding.criteria)).toEqual(['LLM_PARAMETERS', 'c1', 'c2'])
        }
        return { output: decision(questions, decisions === 2 ? 'c1' : undefined) }
      },
    })
    const ports: RuntimePorts<number> = {
      ...base,
      semantics: {
        candidates(_tool, observations) {
          if (observations.length === 0) return []
          const old = Array.from(
            { length: 4 },
            (_, index): Candidate => ({
              id: brandString<CandidateId>(`old-${index}`),
              tool: tool.name,
              label: `Old binding ${index}`,
              arguments: { exact: true, old: index },
              sourceRecordIds: [],
              environmentEpoch: epoch,
              toolRevision: tool.revision,
            }),
          )
          return [
            ...old,
            {
              id: brandString<CandidateId>('recent'),
              tool: tool.name,
              label: 'Binding from latest result',
              arguments: { exact: true, recent: true },
              sourceRecordIds: [observations.at(-1)!.sourceRecordId],
              environmentEpoch: epoch,
              toolRevision: tool.revision,
            },
          ]
        },
        observations() {
          return []
        },
        effectDisposition() {
          return undefined
        },
      },
    }
    const runtime = await openJevRuntime(ports, { ...config, maxCandidates: 2 })
    expect((await runtime.run(turn, [input])).status).toBe('completed')
    expect(executions).toBe(2)
    expect(
      (await ledger.read()).some(
        (entry) =>
          entry.record.kind === 'resource.observed' &&
          typeof entry.record.resource === 'object' &&
          entry.record.resource !== null &&
          !Array.isArray(entry.record.resource) &&
          entry.record.resource.kind === 'candidate.offer.summary' &&
          entry.record.resource.eligibleKnown === 5 &&
          entry.record.resource.offered === 2 &&
          entry.record.resource.omittedKnown === 3,
      ),
    ).toBe(true)
  })

  it('records changed decision guidance and clears it without changing language tool definitions', async () => {
    const { ledger } = ledgerA()
    const profiles: DecisionToolProfile[] = [
      {
        operation: tool.name,
        toolRevision: tool.revision,
        selection: 'Inspect the chosen target',
        phases: ['ACT'],
        inputs: 'Target',
        result: 'Target content',
        constraints: ['Use scoped access'],
      },
      {
        operation: tool.name,
        toolRevision: tool.revision,
        selection: 'Verify the chosen target',
        phases: ['ACT'],
        inputs: 'Target',
        result: 'Verified content',
        constraints: ['Use scoped access'],
      },
    ]
    const seenStates: JsonValue[] = []
    const seenCriteria: JsonValue[] = []
    const languageTools: (readonly ToolDescriptor[] | undefined)[] = []
    const languageStates: JsonValue[] = []
    let decisions = 0
    let executions = 0
    const base = fixture(ledger, {
      onInvoke(call) {
        const body = call.input as { questions: JsonValue; state: JsonValue }
        seenStates.push(body.state)
        seenCriteria.push(
          (
            (body.questions as Record<string, JsonValue>)['operation_ACT'] as {
              criteria: Record<string, JsonValue>
            }
          ).criteria['native_tool']!,
        )
        decisions++
        return { output: decision(body.questions) }
      },
      onResult() {
        return {
          ...outcome,
          value: { execution: ++executions },
          directive: { conclude: executions === 3, additions: [] },
        }
      },
    })
    const ports: RuntimePorts<number> = {
      ...base,
      environment: {
        ...base.environment,
        async catalog() {
          return [tool, { ...tool, name: 'alternate_tool', description: 'Another enabled tool' }]
        },
      },
      decisionContext: {
        ...base.decisionContext,
        describeTool(descriptor) {
          return descriptor.name === tool.name ? profiles[decisions] : undefined
        },
      },
      language: {
        ...base.language,
        async prepare(model, signal) {
          languageTools.push(model.tools)
          languageStates.push(model.state)
          return base.language.prepare(model, signal)
        },
      },
    }
    const runtime = await openJevRuntime(ports, config)
    expect((await runtime.run(turn, [input])).status).toBe('completed')
    const recorded = (await ledger.read()).filter(
      (entry) =>
        entry.record.kind === 'resource.observed' &&
        typeof entry.record.resource === 'object' &&
        entry.record.resource !== null &&
        !Array.isArray(entry.record.resource) &&
        entry.record.resource.kind === 'jev.decision-tools.v1',
    )
    expect(
      recorded.map((entry) => entry.record.kind === 'resource.observed' && entry.record.resource),
    ).toEqual([
      { kind: 'jev.decision-tools.v1', profiles: [profiles[0]] },
      { kind: 'jev.decision-tools.v1', profiles: [profiles[1]] },
      { kind: 'jev.decision-tools.v1', profiles: [] },
    ])
    expect(seenCriteria).toEqual(Array.from({ length: 3 }, () => ({ operation: tool.name })))
    expect(seenStates).toMatchObject([
      { operations: { [tool.name]: { description: profiles[0]?.selection } } },
      { operations: { [tool.name]: { description: profiles[1]?.selection } } },
      { operations: { [tool.name]: { description: tool.description } } },
    ])
    expect(JSON.stringify(seenStates.slice(0, 2))).not.toContain(tool.description)
    expect(languageTools).toHaveLength(3)
    expect(languageTools.every((catalog) => catalog?.[0]?.description === tool.description)).toBe(true)
    expect(JSON.stringify(languageStates)).not.toContain('jev.decision-tools.v1')
  })

  it('does not append unchanged guidance after reopening the recorded turn', async () => {
    const { ledger } = ledgerA()
    const profile: DecisionToolProfile = {
      operation: tool.name,
      toolRevision: tool.revision,
      selection: 'Use the scoped target',
      phases: ['ACT'],
      inputs: 'Target',
      result: 'Content',
      constraints: [],
    }
    let executions = 0
    const base = fixture(ledger, {
      onResult() {
        return {
          ...outcome,
          value: { execution: ++executions },
          directive: { conclude: executions === 2, additions: [] },
        }
      },
    })
    const firstPorts: RuntimePorts<number> = {
      ...base,
      decisionContext: {
        ...base.decisionContext,
        describeTool() {
          return profile
        },
      },
      lifecycle: {
        async admitStep(_turn, _step, inputs) {
          return { kind: 'enter', inputs }
        },
        async stepSettled() {
          throw new Error('host step failed')
        },
      },
    }
    const first = await openJevRuntime(firstPorts, config)
    expect((await first.run(turn, [input])).status).toBe('failed')
    const resumed = await openJevRuntime(
      {
        ...base,
        decisionContext: {
          ...base.decisionContext,
          describeTool() {
            return profile
          },
        },
      },
      config,
    )
    expect((await resumed.run(turn, [])).status).toBe('completed')
    expect(
      (await ledger.read()).filter(
        (entry) =>
          entry.record.kind === 'resource.observed' &&
          typeof entry.record.resource === 'object' &&
          entry.record.resource !== null &&
          !Array.isArray(entry.record.resource) &&
          entry.record.resource.kind === 'jev.decision-tools.v1',
      ),
    ).toHaveLength(1)
  })

  it('offers one complete binding per tool before a second binding from the same tool', async () => {
    const { ledger } = ledgerA()
    const alternate: ToolDescriptor = {
      ...tool,
      name: 'alternate_tool',
      description: 'Use another enabled tool',
    }
    const base = fixture(ledger, {
      onInvoke(call) {
        const questions = (call.input as { questions: Record<string, JsonValue> }).questions
        expect(
          Object.keys((questions['binding_native_tool'] as { criteria: Record<string, JsonValue> }).criteria),
        ).toEqual(['LLM_PARAMETERS', 'c1'])
        expect(
          Object.keys(
            (questions['binding_alternate_tool'] as { criteria: Record<string, JsonValue> }).criteria,
          ),
        ).toEqual(['LLM_PARAMETERS', 'c1'])
        return { output: decisionAnswers(questions) }
      },
    })
    const ports: RuntimePorts<number> = {
      ...base,
      environment: {
        ...base.environment,
        async catalog() {
          return [tool, alternate]
        },
      },
      semantics: {
        candidates(descriptor) {
          return descriptor.name === tool.name
            ? Array.from(
                { length: 4 },
                (_, index): Candidate => ({
                  id: brandString<CandidateId>(`primary-${index}`),
                  tool: tool.name,
                  label: `Primary ${index}`,
                  arguments: { index },
                  sourceRecordIds: [],
                  environmentEpoch: epoch,
                  toolRevision: tool.revision,
                }),
              )
            : [
                {
                  id: brandString<CandidateId>('alternate'),
                  tool: alternate.name,
                  label: 'Alternate',
                  arguments: { alternate: true },
                  sourceRecordIds: [],
                  environmentEpoch: epoch,
                  toolRevision: alternate.revision,
                },
              ]
        },
        observations() {
          return []
        },
        effectDisposition() {
          return undefined
        },
      },
    }
    const runtime = await openJevRuntime(ports, { ...config, maxCandidates: 2 })
    const runResult = await runtime.run(turn, [input])
    expect(runResult.status, runResult.reason).toBe('completed')
    expect(
      (await ledger.read()).some(
        (entry) =>
          entry.record.kind === 'resource.observed' &&
          typeof entry.record.resource === 'object' &&
          entry.record.resource !== null &&
          !Array.isArray(entry.record.resource) &&
          entry.record.resource.kind === 'candidate.offer.summary' &&
          entry.record.resource.eligibleKnown === 5 &&
          entry.record.resource.offered === 2,
      ),
    ).toBe(true)
  })

  it('ranks verification revisits after fresh and evidence-missing calls within the hard offer budget', async () => {
    const { ledger, entries } = ledgerA()
    let visible: readonly RecordId[] = []
    const base = fixture(ledger, {
      admitStep: {
        async admitStep(_turn, _step, inputs) {
          return {
            kind: 'enter',
            inputs,
            resources: [
              {
                kind: 'jev.workspace-directory.v1',
                root: '/workspace',
                status: 'observed',
                entries: [{ path: 'unread.txt', kind: 'file' }],
                complete: false,
              },
              {
                kind: 'jev.workspace-directory.v1',
                root: '/workspace',
                status: 'observed',
                entries: [{ path: 'read-before.txt', kind: 'file' }],
                complete: false,
              },
            ],
          }
        },
        async stepSettled() {},
      },
      onInvoke(call) {
        const questions = (call.input as { questions: Record<string, JsonValue> }).questions
        const criteria = (questions['binding_native_tool'] as { criteria: Record<string, JsonValue> })
          .criteria
        expect(Object.keys(criteria)).toEqual(['LLM_PARAMETERS', 'c1', 'c2'])
        expect(bindingValue(criteria.c1)).toMatchObject({ description: 'Evidence missing' })
        expect(bindingValue(criteria.c2)).toMatchObject({ description: 'Unread' })
        const manifest = resources(
          entries.map((entry) => entry.payload),
          'jev.decision.manifest.v1',
        ).at(-1)
        expect(visible).toEqual(manifest?.sourceRecordIds)
        return { output: decision(questions, 'c1') }
      },
    })
    const ports: RuntimePorts<number> = {
      ...base,
      semantics: {
        ...base.semantics!,
        candidates(_tool, _observations, _epoch, context) {
          if (context?.visibleSourceRecordIds === undefined)
            throw new Error('Candidate visibility was not supplied')
          expect(Object.isFrozen(context.visibleSourceRecordIds)).toBe(true)
          visible = context.visibleSourceRecordIds
          const directoryRecords = context.records.filter(
            (record) =>
              record.kind === 'resource.observed' &&
              typeof record.resource === 'object' &&
              record.resource !== null &&
              !Array.isArray(record.resource) &&
              record.resource.kind === 'jev.workspace-directory.v1',
          )
          const common = { tool: tool.name, environmentEpoch: epoch, toolRevision: tool.revision }
          return [
            {
              ...common,
              id: brandString<CandidateId>('verification'),
              label: 'Verification',
              revisit: 'verification',
              arguments: { path: '/workspace' },
              sourceRecordIds: [context.environmentRecord.id],
              evidence: [
                { sourceRecordId: context.environmentRecord.id, pointer: '/facts/cwd', value: '/workspace' },
              ],
            },
            ...directoryRecords.map(
              (record, index): Candidate => ({
                ...common,
                id: brandString<CandidateId>(`directory-${index}`),
                label: index === 0 ? 'Unread' : 'Evidence missing',
                ...(index === 0 ? {} : { revisit: 'evidence_missing' }),
                arguments: { path: index === 0 ? 'unread.txt' : 'read-before.txt' },
                sourceRecordIds: [record.id],
                evidence: [
                  {
                    sourceRecordId: record.id,
                    pointer: '/resource/entries/0/path',
                    value: index === 0 ? 'unread.txt' : 'read-before.txt',
                  },
                ],
              }),
            ),
          ]
        },
      },
    }
    const runtime = await openJevRuntime(ports, { ...config, maxCandidates: 2 })
    const result = await runtime.run(turn, [input])
    expect(result.status, result.reason).toBe('completed')
    expect(
      resources(
        (await ledger.read()).map((entry) => entry.record),
        'candidate.offer.summary',
      ),
    ).toMatchObject([{ eligibleKnown: 3, offered: 2, omittedKnown: 1 }])
  })

  it('offers only bindings whose observations remain visible in the decision window', async () => {
    const { ledger } = ledgerA()
    let decisions = 0
    let executions = 0
    const base = fixture(ledger, {
      onInvoke(call) {
        const questions = (call.input as { questions: Record<string, JsonValue> }).questions
        if (++decisions === 3) {
          const binding = questions['binding_native_tool'] as { criteria: Record<string, JsonValue> }
          expect(Object.keys(binding.criteria)).toEqual(['LLM_PARAMETERS', 'c1'])
          return respond(call)
        }
        return { output: decision(questions) }
      },
      onResult() {
        return { ...outcome, value: { result: ++executions }, directive: { conclude: false, additions: [] } }
      },
    })
    const ports: RuntimePorts<number> = {
      ...base,
      decisionContext: {
        ...base.decisionContext,
        config: { ...base.decisionContext.config, observationCount: 1 },
      },
      semantics: {
        candidates(_tool, observations) {
          if (observations.length < 2) return []
          return [
            {
              id: brandString<CandidateId>('old'),
              tool: tool.name,
              label: 'Old observation',
              arguments: { result: 1 },
              sourceRecordIds: [observations[0]!.sourceRecordId],
              environmentEpoch: epoch,
              toolRevision: tool.revision,
            },
            {
              id: brandString<CandidateId>('recent'),
              tool: tool.name,
              label: 'Recent observation',
              arguments: { result: 2 },
              sourceRecordIds: [observations[1]!.sourceRecordId],
              environmentEpoch: epoch,
              toolRevision: tool.revision,
            },
          ]
        },
        observations() {
          return []
        },
        effectDisposition() {
          return undefined
        },
      },
    }
    const runtime = await openJevRuntime(ports, config)
    expect((await runtime.run(turn, [input])).status).toBe('completed')
    expect(executions).toBe(2)
    expect(
      (await ledger.read()).some(
        (entry) =>
          entry.record.kind === 'resource.observed' &&
          typeof entry.record.resource === 'object' &&
          entry.record.resource !== null &&
          !Array.isArray(entry.record.resource) &&
          entry.record.resource.kind === 'candidate.offer.summary' &&
          entry.record.resource.eligibleKnown === 1 &&
          entry.record.resource.offered === 1 &&
          entry.record.resource.generated === 2,
      ),
    ).toBe(true)
  })

  it('uses complete language parameters when a candidate observation is clipped', async () => {
    const { ledger } = ledgerA()
    let decisions = 0
    let helperCalls = 0
    let executions = 0
    const base = fixture(ledger, {
      onInvoke(call) {
        const body = call.input as {
          questions: Record<string, JsonValue>
          state: { coverage: Record<string, JsonValue> }
        }
        if (++decisions === 2) {
          expect(body.state.coverage['step:1.result.0']).toMatchObject({ reason: 'decision display limit' })
          expect(body.questions['binding_native_tool']).toBeUndefined()
        }
        return { output: decision(body.questions) }
      },
      onLanguage(call) {
        helperCalls++
        return { output: authoredCall(call, { generated: helperCalls }) }
      },
      onResult() {
        return {
          ...outcome,
          value: { text: 'evidence '.repeat(200) },
          directive: { conclude: ++executions === 2, additions: [] },
        }
      },
    })
    const ports: RuntimePorts<number> = {
      ...base,
      decisionContext: {
        ...base.decisionContext,
        config: { ...base.decisionContext.config, excerptBytes: 80 },
      },
      semantics: {
        candidates(_tool, observations) {
          if (observations.length === 0) return []
          return [
            {
              id: brandString<CandidateId>('clipped'),
              tool: tool.name,
              label: 'Clipped observation',
              arguments: { copied: true },
              sourceRecordIds: [observations[0]!.sourceRecordId],
              environmentEpoch: epoch,
              toolRevision: tool.revision,
            },
          ]
        },
        observations() {
          return []
        },
        effectDisposition() {
          return undefined
        },
      },
    }
    const runtime = await openJevRuntime(ports, config)
    expect((await runtime.run(turn, [input])).status).toBe('completed')
    expect(helperCalls).toBe(2)
    expect(
      (await ledger.read()).some(
        (entry) =>
          entry.record.kind === 'resource.observed' &&
          typeof entry.record.resource === 'object' &&
          entry.record.resource !== null &&
          !Array.isArray(entry.record.resource) &&
          entry.record.resource.kind === 'candidate.offer.summary' &&
          entry.record.resource.eligibleKnown === 0 &&
          entry.record.resource.offered === 0 &&
          entry.record.resource.generated === 1,
      ),
    ).toBe(true)
  })

  it('offers an exact recorded field from clipped evidence but rejects forged and missing fields', async () => {
    const { ledger } = ledgerA()
    const observedText = 'field evidence '.repeat(120)
    let decisions = 0
    let executions = 0
    let helpers = 0
    const base = fixture(ledger, {
      onInvoke(call) {
        const body = call.input as {
          questions: Record<string, JsonValue>
          state: { coverage: Record<string, JsonValue> }
        }
        if (++decisions === 2) {
          expect(body.state.coverage['step:1.result.0']).toMatchObject({ reason: 'decision display limit' })
          const binding = body.questions['binding_native_tool'] as { criteria: Record<string, JsonValue> }
          expect(Object.keys(binding.criteria)).toEqual(['LLM_PARAMETERS', 'c1'])
          expect(bindingValue(binding.criteria.c1)).toEqual({
            operation: tool.name,
            description: 'Recorded field',
            arguments: { copied: true },
          })
          expect(JSON.stringify(binding.criteria)).not.toContain('/observations/0/data/value/text')
        }
        return { output: decision(body.questions, decisions === 2 ? 'c1' : undefined) }
      },
      onLanguage(call) {
        helpers++
        return { output: authoredCall(call, { generated: true }) }
      },
      onResult() {
        return {
          ...outcome,
          value: { text: observedText },
          directive: { conclude: ++executions === 2, additions: [] },
        }
      },
    })
    const ports: RuntimePorts<number> = {
      ...base,
      decisionContext: {
        ...base.decisionContext,
        config: { ...base.decisionContext.config, excerptBytes: 80 },
      },
      semantics: {
        candidates(_tool, observations, _epoch, context) {
          const sourceRecordId = observations[0]?.sourceRecordId
          if (sourceRecordId === undefined) return []
          expect(context?.visibleSourceRecordIds).not.toContain(sourceRecordId)
          const common = {
            tool: tool.name,
            arguments: { copied: true },
            sourceRecordIds: [sourceRecordId],
            environmentEpoch: epoch,
            toolRevision: tool.revision,
          }
          return [
            {
              ...common,
              id: brandString<CandidateId>('exact'),
              label: 'Recorded field',
              evidence: [{ sourceRecordId, pointer: '/observations/0/data/value/text', value: observedText }],
            },
            {
              ...common,
              id: brandString<CandidateId>('forged'),
              label: 'Changed field',
              evidence: [{ sourceRecordId, pointer: '/observations/0/data/value/text', value: 'different' }],
            },
            {
              ...common,
              id: brandString<CandidateId>('missing'),
              label: 'Absent field',
              evidence: [{ sourceRecordId, pointer: '/observations/0/data/value/absent', value: 'absent' }],
            },
          ]
        },
        observations() {
          return []
        },
        effectDisposition() {
          return undefined
        },
      },
      candidatePolicy: { maxPerTool: 3, maxEvidenceBytes: 3000 },
    }
    const runtime = await openJevRuntime(ports, config)
    expect((await runtime.run(turn, [input])).status).toBe('completed')
    expect(helpers).toBe(1)
    const entries = await ledger.read()
    expect(
      entries.filter(
        (entry) =>
          entry.record.kind === 'resource.observed' &&
          typeof entry.record.resource === 'object' &&
          entry.record.resource !== null &&
          !Array.isArray(entry.record.resource) &&
          entry.record.resource.kind === 'jev.candidate.evidence.error.v1',
      ),
    ).toHaveLength(2)
    expect(
      entries.some(
        (entry) =>
          entry.record.kind === 'resource.observed' &&
          typeof entry.record.resource === 'object' &&
          entry.record.resource !== null &&
          !Array.isArray(entry.record.resource) &&
          entry.record.resource.kind === 'jev.candidate.route.v1' &&
          entry.record.resource.route === 'direct' &&
          entry.record.resource.reason === 'binding_confident',
      ),
    ).toBe(true)
  })

  it('uses only the latest recorded recipe fields and excludes candidate diagnostics from language state', async () => {
    const { ledger } = ledgerA()
    let steps = 0
    let decisions = 0
    const base = fixture(ledger, {
      onInvoke(call) {
        const body = call.input as { questions: Record<string, JsonValue>; state: JsonValue }
        if (++decisions === 2) {
          const binding = body.questions['binding_native_tool'] as { criteria: Record<string, JsonValue> }
          expect(Object.keys(binding.criteria)).toEqual(['LLM_PARAMETERS', 'c1'])
          expect(JSON.stringify(body.state)).not.toContain('jev.native-candidate-recipes.v1')
        }
        return { output: decision(body.questions) }
      },
      onResult() {
        return { ...outcome, directive: { conclude: ++steps === 2, additions: [] } }
      },
    })
    const ports: RuntimePorts<number> = {
      ...base,
      lifecycle: {
        async admitStep(_turn, _step, inputs) {
          return {
            kind: 'enter' as const,
            inputs,
            resources: [
              {
                kind: 'jev.native-candidate-recipes.v1',
                globPatterns: [{ pattern: steps === 0 ? 'old' : 'new', path: '/workspace' }],
              },
            ],
          }
        },
        async stepSettled() {},
      },
      language: {
        ...base.language,
        async prepare(model, signal) {
          expect(JSON.stringify(model.state)).not.toContain('jev.native-candidate-recipes.v1')
          expect(JSON.stringify(model.state)).not.toContain('jev.candidate.policy.v1')
          return base.language.prepare(model, signal)
        },
      },
      semantics: {
        candidates(_tool, _observations, _epoch, context) {
          if (steps === 0 || context === undefined) return []
          const recipes = context.records.filter(
            (record) =>
              record.kind === 'resource.observed' &&
              typeof record.resource === 'object' &&
              record.resource !== null &&
              !Array.isArray(record.resource) &&
              record.resource.kind === 'jev.native-candidate-recipes.v1',
          )
          return recipes.map((source, index) => ({
            id: brandString<CandidateId>(index === 0 ? 'old-recipe' : 'current-recipe'),
            tool: tool.name,
            label: 'Configured pattern',
            arguments: { pattern: index === 0 ? 'old' : 'new' },
            sourceRecordIds: [source.id],
            environmentEpoch: epoch,
            toolRevision: tool.revision,
            evidence: [
              {
                sourceRecordId: source.id,
                pointer: '/resource/globPatterns/0/pattern',
                value: index === 0 ? 'old' : 'new',
              },
            ],
          }))
        },
        observations() {
          return []
        },
        effectDisposition() {
          return undefined
        },
      },
    }
    const runResult = await (await openJevRuntime(ports, config)).run(turn, [input])
    expect(runResult.status, runResult.reason).toBe('completed')
  })

  it('rejects a field receipt from a superseded environment catalog record', async () => {
    const { ledger } = ledgerA()
    let decisions = 0
    let executions = 0
    const base = fixture(ledger, {
      onInvoke(call) {
        const questions = (call.input as { questions: Record<string, JsonValue> }).questions
        if (++decisions === 2) expect(questions['binding_native_tool']).toBeUndefined()
        return { output: decision(questions) }
      },
      onResult() {
        return { ...outcome, directive: { conclude: ++executions === 2, additions: [] } }
      },
    })
    const ports: RuntimePorts<number> = {
      ...base,
      semantics: {
        candidates(_tool, _observations, _epoch, context) {
          if (executions === 0 || context === undefined) return []
          const old = context.records.find((record) => record.kind === 'environment.observed')
          if (old === undefined) return []
          return [
            {
              id: brandString<CandidateId>('old-catalog'),
              tool: tool.name,
              label: 'Old catalog fact',
              arguments: { exact: true },
              sourceRecordIds: [old.id],
              environmentEpoch: epoch,
              toolRevision: tool.revision,
              evidence: [{ sourceRecordId: old.id, pointer: '/facts/cwd', value: '/workspace' }],
            },
          ]
        },
        observations() {
          return []
        },
        effectDisposition() {
          return undefined
        },
      },
    }
    expect((await (await openJevRuntime(ports, config)).run(turn, [input])).status).toBe('completed')
    expect(
      (await ledger.read()).some(
        (entry) =>
          entry.record.kind === 'resource.observed' &&
          typeof entry.record.resource === 'object' &&
          entry.record.resource !== null &&
          !Array.isArray(entry.record.resource) &&
          entry.record.resource.kind === 'jev.candidate.evidence.error.v1' &&
          entry.record.resource.candidateId === 'old-catalog',
      ),
    ).toBe(true)
  })

  it('stops a candidate generator at its per-tool limit before validating offered bindings', async () => {
    const { ledger } = ledgerA()
    let yielded = 0
    let validated = 0
    const base = fixture(ledger, {
      onInvoke(call) {
        expect(validated).toBe(1)
        return { output: decision((call.input as { questions: JsonValue }).questions) }
      },
    })
    const ports: RuntimePorts<number> = {
      ...base,
      candidatePolicy: { maxPerTool: 2, maxEvidenceBytes: 100 },
      environment: {
        ...base.environment,
        async validate(definition, args, preconditions) {
          validated++
          return base.environment.validate(definition, args, preconditions)
        },
      },
      semantics: {
        *candidates() {
          for (let index = 0; ; index++) {
            yielded++
            yield {
              id: brandString<CandidateId>(`generated-${index}`),
              tool: tool.name,
              label: 'Bound',
              arguments: { index },
              sourceRecordIds: [],
              environmentEpoch: epoch,
              toolRevision: tool.revision,
            }
          }
        },
        observations() {
          return []
        },
        effectDisposition() {
          return undefined
        },
      },
    }
    expect(
      (await (await openJevRuntime(ports, { ...config, maxCandidates: 1 })).run(turn, [input])).status,
    ).toBe('completed')
    expect(yielded).toBe(2)
    expect(validated).toBe(3)
    expect(
      (await ledger.read()).some(
        (entry) =>
          entry.record.kind === 'resource.observed' &&
          typeof entry.record.resource === 'object' &&
          entry.record.resource !== null &&
          !Array.isArray(entry.record.resource) &&
          entry.record.resource.kind === 'candidate.offer.summary' &&
          entry.record.resource.availabilityComplete === false &&
          JSON.stringify(entry.record.resource.generationLimitReachedTools) === '["native_tool"]',
      ),
    ).toBe(true)
  })

  it('routes a selected but low-confidence binding to full parameter generation', async () => {
    const { ledger } = ledgerA()
    let helpers = 0
    const candidate: Candidate = {
      id: brandString<CandidateId>('bound'),
      tool: tool.name,
      label: 'Bound call',
      arguments: { from: 'candidate' },
      sourceRecordIds: [],
      environmentEpoch: epoch,
      toolRevision: tool.revision,
    }
    const ports = fixture(ledger, {
      candidate,
      onInvoke(call) {
        const questions = (call.input as { questions: Record<string, JsonValue> }).questions
        return { output: decisionAnswers(questions, { binding: 'c1', bindingConfidence: 0.2 }) }
      },
      onLanguage(call) {
        helpers++
        return { output: authoredCall(call, { from: 'helper' }) }
      },
      onExecute(intent) {
        expect(intent.arguments).toEqual({ from: 'helper' })
      },
    })
    expect((await (await openJevRuntime(ports, config)).run(turn, [input])).status).toBe('completed')
    expect(helpers).toBe(1)
    expect(
      (await ledger.read()).some(
        (entry) =>
          entry.record.kind === 'resource.observed' &&
          typeof entry.record.resource === 'object' &&
          entry.record.resource !== null &&
          !Array.isArray(entry.record.resource) &&
          entry.record.resource.kind === 'jev.candidate.route.v1' &&
          entry.record.resource.route === 'parameters' &&
          entry.record.resource.reason === 'binding_below_threshold' &&
          entry.record.resource.bindingConfidence === 0.2,
      ),
    ).toBe(true)
  })

  it('reuses the latest recipe receipt after reopening without another recipe resource', async () => {
    const { ledger } = ledgerA()
    let executions = 0
    const base = fixture(ledger, {
      onResult() {
        return { ...outcome, directive: { conclude: ++executions === 2, additions: [] } }
      },
    })
    const semantics: NonNullable<RuntimePorts<number>['semantics']> = {
      candidates(_tool, _observations, _epoch, context) {
        if (executions === 0 || context === undefined) return []
        const source = context.records.find(
          (record) =>
            record.kind === 'resource.observed' &&
            typeof record.resource === 'object' &&
            record.resource !== null &&
            !Array.isArray(record.resource) &&
            record.resource.kind === 'jev.native-candidate-recipes.v1',
        )
        if (source === undefined) return []
        return [
          {
            id: brandString<CandidateId>('recovered-recipe'),
            tool: tool.name,
            label: 'Recorded recipe',
            arguments: { pattern: 'tracked' },
            sourceRecordIds: [source.id],
            environmentEpoch: epoch,
            toolRevision: tool.revision,
            evidence: [
              { sourceRecordId: source.id, pointer: '/resource/globPatterns/0/pattern', value: 'tracked' },
            ],
          },
        ]
      },
      observations() {
        return []
      },
      effectDisposition() {
        return undefined
      },
    }
    const first = await openJevRuntime(
      {
        ...base,
        semantics,
        lifecycle: {
          async admitStep(_turn, _step, inputs) {
            return {
              kind: 'enter' as const,
              inputs,
              resources: [
                {
                  kind: 'jev.native-candidate-recipes.v1',
                  globPatterns: [{ pattern: 'tracked', path: '/workspace' }],
                },
              ],
            }
          },
          async stepSettled() {
            throw new Error('host step failed')
          },
        },
      },
      config,
    )
    const firstResult = await first.run(turn, [input])
    expect(firstResult.status, firstResult.reason).toBe('failed')
    const resumed = await openJevRuntime(
      {
        ...base,
        semantics,
        decision: {
          ...base.decision,
          async invoke(call, signal) {
            const questions = (call.input as { questions: Record<string, JsonValue> }).questions
            expect(questions['binding_native_tool']).toBeDefined()
            return base.decision.invoke(call, signal)
          },
        },
      },
      config,
    )
    const runResult = await resumed.run(turn, [])
    expect(runResult.status, runResult.reason).toBe('completed')
    expect(
      (await ledger.read()).filter(
        (entry) =>
          entry.record.kind === 'resource.observed' &&
          typeof entry.record.resource === 'object' &&
          entry.record.resource !== null &&
          !Array.isArray(entry.record.resource) &&
          entry.record.resource.kind === 'jev.native-candidate-recipes.v1',
      ),
    ).toHaveLength(1)
  })

  it('keeps host resource evidence visible when a candidate summary is recorded', async () => {
    const { ledger, entries } = ledgerA()
    const base = fixture(ledger, {
      onInvoke(call) {
        const questions = (call.input as { questions: Record<string, JsonValue> }).questions
        expect(questions['binding_native_tool']).toBeDefined()
        return { output: decision(questions) }
      },
      admitStep: {
        async admitStep(_turn, _step, inputs) {
          return {
            kind: 'enter',
            inputs,
            resources: [
              {
                kind: 'jev.workspace-directory.v1',
                root: '/workspace',
                entries: [{ path: 'known.txt', kind: 'file', size: 4 }],
                complete: true,
              },
            ],
          }
        },
        async stepSettled() {},
      },
    })
    const ports: RuntimePorts<number> = {
      ...base,
      decisionContext: {
        ...base.decisionContext,
        config: { ...base.decisionContext.config, observationCount: 1 },
      },
      semantics: {
        candidates() {
          const source = entries.find(
            (entry) =>
              entry.payload.kind === 'resource.observed' &&
              typeof entry.payload.resource === 'object' &&
              entry.payload.resource !== null &&
              !Array.isArray(entry.payload.resource) &&
              entry.payload.resource.kind === 'jev.workspace-directory.v1',
          )?.payload.id
          if (source === undefined) throw new Error('Host evidence was not recorded')
          return [
            {
              id: brandString<CandidateId>('evidence'),
              tool: tool.name,
              label: 'Recorded resource',
              arguments: { path: 'known.txt' },
              sourceRecordIds: [source],
              environmentEpoch: epoch,
              toolRevision: tool.revision,
              evidence: [{ sourceRecordId: source, pointer: '/resource/entries/0/path', value: 'known.txt' }],
            },
            {
              id: brandString<CandidateId>('other'),
              tool: tool.name,
              label: 'Alternative',
              arguments: { from: 'default' },
              sourceRecordIds: [],
              environmentEpoch: epoch,
              toolRevision: tool.revision,
            },
          ]
        },
        observations() {
          return []
        },
        effectDisposition() {
          return undefined
        },
      },
    }
    const runtime = await openJevRuntime(ports, { ...config, maxCandidates: 1 })
    expect((await runtime.run(turn, [input])).status).toBe('completed')
    const summaries = (await ledger.read()).filter(
      (entry) =>
        entry.record.kind === 'resource.observed' &&
        typeof entry.record.resource === 'object' &&
        entry.record.resource !== null &&
        !Array.isArray(entry.record.resource) &&
        entry.record.resource.kind === 'candidate.offer.summary',
    )
    expect(
      summaries.map((entry) => entry.record.kind === 'resource.observed' && entry.record.resource),
    ).toEqual([
      {
        kind: 'candidate.offer.summary',
        eligibleKnown: 2,
        offered: 1,
        omittedKnown: 1,
        generated: 2,
        validated: 1,
        generationLimitReachedTools: [],
        availabilityComplete: true,
        policy: 'tool-round-robin-newest-source-first-verification-last',
      },
    ])
  })

  it('drops oversized bindings while retaining the operation and parameter fallback', async () => {
    const { ledger } = ledgerA()
    const baseline = compileQuestions([tool], [], config)
    const maxQuestionBytes = new TextEncoder().encode(JSON.stringify(baseline.questions)).length + 100
    const candidate: Candidate = {
      id: brandString<CandidateId>('large'),
      tool: tool.name,
      label: 'x'.repeat(1_000),
      arguments: { exact: true },
      sourceRecordIds: [],
      environmentEpoch: epoch,
      toolRevision: tool.revision,
    }
    const runtime = await openJevRuntime(
      fixture(ledger, {
        candidate,
        onInvoke(call) {
          const questions = (call.input as { questions: Record<string, JsonValue> }).questions
          expect(questions['binding_native_tool']).toBeUndefined()
          expect(questions.purpose).toBeDefined()
          return { output: decision(questions) }
        },
      }),
      { ...config, maxQuestionBytes },
    )
    expect((await runtime.run(turn, [input])).status).toBe('completed')
    expect(
      (await ledger.read()).some(
        (entry) =>
          entry.record.kind === 'resource.observed' &&
          typeof entry.record.resource === 'object' &&
          entry.record.resource !== null &&
          !Array.isArray(entry.record.resource) &&
          entry.record.resource.kind === 'candidate.offer.summary' &&
          entry.record.resource.eligibleKnown === 1 &&
          entry.record.resource.offered === 0 &&
          entry.record.resource.omittedKnown === 1,
      ),
    ).toBe(true)
  })

  it('rebuilds consumed progress from the same turn after reopen', async () => {
    const { ledger } = ledgerA()
    let helperCalls = 0
    const options = {
      onLanguage() {
        helperCalls++
        return { output: { kind: 'cannot_bind', reason: 'No usable binding' } }
      },
    }
    const firstPorts = fixture(ledger, {
      ...options,
      admitStep: {
        async admitStep(_turn, _step, inputs) {
          return { kind: 'enter', inputs }
        },
        async stepSettled() {
          throw new Error('host step hook failed')
        },
      },
    })
    const bounded = { ...config, maxSteps: 4, maxModelAttempts: 8, maxRepeatedFailures: 3 }
    const first = await openJevRuntime(firstPorts, bounded)
    expect((await first.run(turn, [input])).status).toBe('failed')
    const resumed = await openJevRuntime(fixture(ledger, options), bounded)
    expect((await resumed.run(turn, [])).status).toBe('budget')
    expect(helperCalls).toBe(2)
    expect(
      (await ledger.read()).filter(
        (entry) =>
          entry.record.kind === 'resource.observed' &&
          typeof entry.record.resource === 'object' &&
          entry.record.resource !== null &&
          !Array.isArray(entry.record.resource) &&
          entry.record.resource.code === 'BINDING_DECLINED',
      ),
    ).toHaveLength(2)
  })
})
