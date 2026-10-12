import { describe, expect, it } from 'vitest'
import { brandString } from '../src/brand.js'
import type {
  AttemptId,
  EnvironmentEpoch,
  FrozenIntent,
  IntentId,
  RecordId,
  RuntimeConfig,
  RuntimeLedger,
  RuntimeRecord,
  StepId,
  TurnId,
} from '../src/index.js'
import { assertRuntimeRecord, interrupted, openJevRuntime, replayRecords } from '../src/index.js'
import { createLedgerReplay } from '../src/ledger.js'

const turn = brandString<TurnId>('turn-ledger')
const step = brandString<StepId>('step-ledger')
const attempt = brandString<AttemptId>('attempt-ledger')
const epoch = brandString<EnvironmentEpoch>('epoch-ledger')
const intentId = brandString<IntentId>('intent-ledger')
const config: RuntimeConfig = {
  maxSteps: 2,
  maxModelAttempts: 3,
  maxNoProgress: 2,
  maxRepeatedFailures: 2,
  maxCandidates: 2,
  maxHistory: 3,
  maxQuestionBytes: 2000,
  maxOutputBytes: 5000,
  escalateBelow: 0.5,
  equivalentSupportThreshold: 0.8,
  ambiguityGate: null,
  answerProgressFloor: null,
  bindingBelow: 0.6,
  mutationEscalateBelow: 0.6,
  responseReviewMode: 'diagnostic',
  maxResponseReviewAttempts: 2,
}
const rid = (id: string): RecordId => brandString<RecordId>(id)
const intent: FrozenIntent = {
  id: intentId,
  tool: 'native',
  toolRevision: 'v1',
  arguments: {},
  effectClass: 'workspace_mutation',
  environmentEpoch: epoch,
}
const request: RuntimeRecord = {
  version: 1,
  id: rid('request'),
  turn,
  step,
  attempt,
  kind: 'model.requested',
  call: {
    purpose: 'decision',
    backend: 'jev',
    endpoint: 'local',
    requestedModel: 'm',
    codec: 'c',
    input: {},
    inputCursor: null,
  },
}
const settlement: RuntimeRecord = {
  version: 1,
  id: rid('settlement'),
  turn,
  step,
  attempt,
  kind: 'model.settled',
  requested: request.id,
  settlement: { output: { answers: {} } },
}
const selected: RuntimeRecord = {
  version: 1,
  id: rid('selected'),
  turn,
  step,
  attempt,
  kind: 'decision.selected',
  requested: request.id,
  phase: 'ACT',
  operation: 'native',
  confidence: 0.8,
}
const intended: RuntimeRecord = {
  version: 1,
  id: rid('intended'),
  turn,
  step,
  attempt,
  kind: 'action.intended',
  intent,
  decision: selected.id,
}
const dispatching: RuntimeRecord = {
  version: 1,
  id: rid('dispatching'),
  turn,
  step,
  attempt,
  kind: 'action.dispatching',
  intentId,
  epoch,
}
const action: RuntimeRecord = {
  version: 1,
  id: rid('action'),
  turn,
  step,
  attempt,
  kind: 'action.settled',
  intentId,
  outcome: { kind: 'error', content: [], directive: { conclude: false, additions: [] } },
  effect: 'unknown',
  observations: [],
}
const entries = (records: readonly RuntimeRecord[]) => records.map((record, cursor) => ({ record, cursor }))

describe('incremental ledger replay', () => {
  it('keeps legacy numeric confidence and rejects fabricated arbitration confidence or malformed review facts', () => {
    expect(() => {
      assertRuntimeRecord(selected)
    }).not.toThrow()
    const { confidence: _confidence, ...arbitrated } = selected
    expect(() => {
      assertRuntimeRecord({ ...arbitrated, source: 'llm_arbitration', phase: 'UNSPECIFIED' })
    }).not.toThrow()
    expect(() => {
      assertRuntimeRecord({ ...selected, source: 'llm_arbitration' })
    }).toThrow()
    expect(() => {
      assertRuntimeRecord({ ...arbitrated, source: 'jev' })
    }).toThrow()
    for (const resource of [
      { kind: 'jev.response-review.v1', checkpoint: '', stage: 'requested' },
      { kind: 'jev.response-review.v1', checkpoint: 'evidence', stage: 'accepted', verdict: 'complete' },
    ])
      expect(() => {
        assertRuntimeRecord({ ...selected, kind: 'resource.observed', resource })
      }).toThrow()
  })
  it('matches complete replay at every prefix, including UNKNOWN resolution and observations', () => {
    const resolved: RuntimeRecord = {
      version: 1,
      id: rid('resolved'),
      turn,
      kind: 'action.resolved',
      intentId,
      resolution: 'accepted_uncertainty',
      actor: 'operator',
      explanation: 'checked',
      evidence: ['receipt'],
    }
    const records: RuntimeRecord[] = [
      { version: 1, id: rid('opened'), turn, kind: 'run.opened', config, runtimeVersion: 'v1' },
      {
        version: 1,
        id: rid('environment'),
        turn,
        kind: 'environment.observed',
        epoch,
        facts: {},
        catalog: [],
      },
      {
        version: 1,
        id: rid('input'),
        turn,
        kind: 'input.admitted',
        input: { id: 'task', source: 'user', content: [] },
      },
      { version: 1, id: rid('resource'), turn, kind: 'resource.observed', resource: {} },
      request,
      settlement,
      selected,
      intended,
      dispatching,
      { ...action, observations: [{ kind: 'receipt', source: 'tool', data: { code: 1 } }] },
      resolved,
      {
        version: 1,
        id: rid('stopped'),
        turn,
        kind: 'run.stopped',
        reason: 'blocked',
        detail: 'finished',
        unresolved: [],
      },
    ]
    const replay = createLedgerReplay()
    expect(replay.state).toEqual(replayRecords(entries([])))
    for (const [index, record] of records.entries()) {
      replay.append(record)
      expect(replay.state).toEqual(replayRecords(entries(records.slice(0, index + 1))))
    }
    expect(replay.state.unresolved).toEqual([])
    expect(replay.state.observations).toEqual([
      { kind: 'receipt', source: 'tool', data: { code: 1 }, sourceRecordId: action.id },
    ])
  })

  it.each(['arbitration', 'parameters'] as const)(
    'binds each batch decision to a unique index of its settled %s proposal',
    (purpose) => {
      const replay = createLedgerReplay()
      const parent = { ...selected, id: rid('original-jev-selection'), source: 'jev' as const }
      if (purpose === 'parameters') {
        const originalRequest = { ...request, id: rid('original-request') }
        replay.append(originalRequest)
        replay.append({ ...settlement, id: rid('original-settlement'), requested: originalRequest.id })
        replay.append({ ...parent, requested: originalRequest.id })
      }
      replay.append({ ...request, call: { ...request.call, purpose } })
      replay.append({
        ...settlement,
        settlement: {
          output: {
            kind: 'calls',
            calls: [
              { kind: 'call', name: 'native', arguments: {} },
              { kind: 'call', name: purpose === 'parameters' ? 'native' : 'other', arguments: {} },
            ],
          },
        },
      })
      const decision: Extract<RuntimeRecord, { kind: 'decision.selected' }> = {
        version: 1,
        id: rid('batch-first'),
        turn,
        step,
        attempt,
        kind: 'decision.selected',
        requested: request.id,
        phase: 'UNSPECIFIED',
        operation: 'native',
        source: purpose === 'parameters' ? 'jev' : 'llm_arbitration',
        ...(purpose === 'parameters'
          ? { parameterDecision: parent.id, confidence: parent.confidence, phase: parent.phase }
          : {}),
        callIndex: 0,
      }
      for (const [index, invalid] of [
        { ...decision, callIndex: -1 },
        { ...decision, callIndex: 32 },
        { ...decision, operation: 'missing' },
        { ...decision, source: 'jev' as const, parameterDecision: rid('missing-parent') },
        { ...decision, turn: brandString<TurnId>('other-turn') },
      ].entries())
        expect(() => replay.append({ ...invalid, id: rid(`invalid-batch-${index}`) })).toThrow()
      expect(replay.state.records).toHaveLength(purpose === 'parameters' ? 5 : 2)
      replay.append(decision)
      expect(() => replay.append({ ...decision, id: rid('duplicate') })).toThrow('unique matching proposal')
      replay.append({
        ...decision,
        id: rid('batch-second'),
        callIndex: 1,
        operation: purpose === 'parameters' ? 'native' : 'other',
      })
      expect(replay.state.records).toHaveLength(purpose === 'parameters' ? 7 : 4)
    },
  )

  it.each(['single', 'batch'] as const)(
    'binds repaired parameter decisions to the preserved %s proposal and explicit call index',
    (shape) => {
      const replay = createLedgerReplay()
      const root = {
        ...request,
        id: rid('schema-root'),
        call: { ...request.call, purpose: 'arbitration' as const },
      }
      const calls = [
        { kind: 'call', name: 'native', arguments: { invalid: true } },
        ...(shape === 'batch' ? [{ kind: 'call', name: 'other', arguments: { invalid: true } }] : []),
      ]
      replay.append(root)
      const original: RuntimeRecord = {
        ...settlement,
        id: rid('schema-original'),
        requested: root.id,
        settlement: { output: shape === 'single' ? calls[0]! : { kind: 'calls', calls } },
      }
      replay.append(original)
      replay.append({
        version: 1,
        id: rid('schema-rejected'),
        turn,
        step,
        kind: 'resource.observed',
        resource: {
          kind: 'jev.argument-repair.v1',
          phase: 'rejected',
          root: root.id,
          requested: root.id,
          error: { code: 'INVALID_PARAMETERS', message: 'Required field missing' },
        },
      })
      replay.append({
        version: 1,
        id: rid('repair-opportunity'),
        turn,
        step,
        kind: 'resource.observed',
        resource: {
          kind: 'jev.argument-repair.v1',
          phase: 'requested',
          root: root.id,
          requested: root.id,
          attempt: 1,
        },
      })
      const repairPrefix = [...replay.state.records]
      const correction = {
        root: root.id,
        requested: root.id,
        attempt: 1,
        calls: calls.map(({ name, arguments: args }) => ({ name, arguments: args })),
        error: { code: 'INVALID_PARAMETERS', message: 'Required field missing' },
      }
      const repaired: RuntimeRecord & { kind: 'model.requested' } = {
        ...request,
        id: rid('repair-request'),
        call: {
          ...request.call,
          purpose: 'parameters',
          input: { argumentRepair: correction },
        },
      }
      replay.append(repaired)
      const fixed = calls.map((call) => ({ ...call, arguments: { fixed: true } }))
      const repairedSettlement: RuntimeRecord = {
        ...settlement,
        id: rid('repair-settled'),
        requested: repaired.id,
        settlement: { output: shape === 'single' ? fixed[0]! : { kind: 'calls', calls: fixed } },
      }
      replay.append(repairedSettlement)
      const acceptance: RuntimeRecord = {
        version: 1,
        id: rid('repair-accepted'),
        turn,
        step,
        kind: 'resource.observed',
        resource: {
          kind: 'jev.argument-repair.v1',
          phase: 'accepted',
          root: root.id,
          requested: repaired.id,
        },
      }
      const beforeAcceptance = [...replay.state.records]
      for (const invalid of [
        { ...acceptance, id: rid('wrong-turn-acceptance'), turn: brandString<TurnId>('another-turn') },
        { ...acceptance, id: rid('wrong-step-acceptance'), step: brandString<StepId>('another-step') },
      ]) {
        expect(() => replay.append(invalid)).toThrow()
        expect(replay.state.records).toEqual(beforeAcceptance)
      }
      for (const invalidSettlement of [
        { error: { code: 'MODEL_FAILURE', message: 'No complete response', retryable: false } },
        { output: { kind: 'answer', content: [{ kind: 'text', text: 'Cannot repair' }] } },
        { output: { kind: 'calls', calls: fixed.map((call) => ({ ...call, name: 'changed-tool' })) } },
      ]) {
        const invalid = createLedgerReplay()
        for (const record of repairPrefix) invalid.append(record)
        invalid.append(repaired)
        invalid.append({ ...repairedSettlement, settlement: invalidSettlement })
        expect(() => invalid.append(acceptance)).toThrow()
      }
      const wrongAttempt = createLedgerReplay()
      for (const record of repairPrefix) wrongAttempt.append(record)
      wrongAttempt.append({
        ...repaired,
        call: { ...repaired.call, input: { argumentRepair: { ...correction, attempt: 2 } } },
      })
      wrongAttempt.append(repairedSettlement)
      const beforeWrongAttemptAcceptance = [...wrongAttempt.state.records]
      expect(() => wrongAttempt.append(acceptance)).toThrow()
      expect(wrongAttempt.state.records).toEqual(beforeWrongAttemptAcceptance)
      replay.append(acceptance)
      const decision: Extract<RuntimeRecord, { kind: 'decision.selected' }> = {
        version: 1,
        id: rid('repair-selection'),
        turn,
        step,
        attempt,
        kind: 'decision.selected',
        requested: repaired.id,
        phase: 'UNSPECIFIED',
        operation: 'native',
        source: 'llm_parameters',
        argumentRepair: root.id,
        callIndex: 0,
      }
      const prefix = [...replay.state.records]
      const { callIndex: _callIndex, ...withoutCallIndex } = decision
      for (const [index, invalid] of [
        withoutCallIndex,
        { ...decision, callIndex: -1 },
        { ...decision, callIndex: fixed.length },
        { ...decision, confidence: 0.99 },
        { ...decision, argumentRepair: rid('missing-root') },
        { ...decision, operation: 'other-tool' },
        { ...decision, source: 'llm_arbitration' as const },
      ].entries()) {
        expect(() => replay.append({ ...invalid, id: rid(`invalid-repair-${index}`) })).toThrow()
        expect(replay.state.records).toEqual(prefix)
      }
      replay.append(decision)
      expect(() => replay.append({ ...decision, id: rid('duplicate-repair-selection') })).toThrow()
      if (shape === 'batch')
        replay.append({ ...decision, id: rid('repair-second-selection'), operation: 'other', callIndex: 1 })
      expect(replay.state.records).toContainEqual(original)
      const rows = replay.state.records.filter((r) => r.kind === 'decision.selected')
      expect(rows.map((r) => r.callIndex)).toEqual(shape === 'single' ? [0] : [0, 1])
      expect(rows.every((r) => r.argumentRepair === root.id && r.confidence === undefined)).toBe(true)
    },
  )

  it('refuses broken causality without publishing the rejected record', () => {
    const replay = createLedgerReplay()
    replay.append(request)
    expect(() => {
      replay.append(selected)
    }).toThrow('Decision uses an unsettled model request')
    expect(replay.state.records).toEqual([request])

    const actionReplay = createLedgerReplay()
    for (const record of [request, settlement, selected, intended]) actionReplay.append(record)
    expect(() => {
      actionReplay.append(action)
    }).toThrow('Undispatched action cannot claim an effect')
    expect(actionReplay.state.records).toEqual([request, settlement, selected, intended])
  })
})

describe('durable record validation', () => {
  it('preserves recorded diagnostic configuration from previous runtime generations', () => {
    expect(() => {
      assertRuntimeRecord({
        version: 1,
        id: 'historical-config',
        turn,
        kind: 'run.opened',
        runtimeVersion: '2',
        config: { ...config, purposeDiagnostics: false },
      })
    }).not.toThrow()
  })

  it('rejects unknown versions, incomplete records, and duplicate ids', () => {
    expect(() => {
      assertRuntimeRecord({ version: 2, kind: 'model.requested', id: 'x', turn: 't' })
    }).toThrow()
    expect(() => {
      assertRuntimeRecord({ version: 1, kind: 'model.requested', id: 'x', turn: 't' })
    }).toThrow()
    expect(() => replayRecords(entries([request, request]))).toThrow('Duplicate record')
  })

  it('rejects invalid durable discriminants and unserializable provider data', () => {
    const priced = { ...request, call: { ...request.call, pricing: { amount: 0.042 } } }
    expect(() => assertRuntimeRecord(priced)).not.toThrow()
    expect(() =>
      assertRuntimeRecord({ ...priced, call: { ...priced.call, pricing: { amount: NaN } } }),
    ).toThrow()
    expect(replayRecords(entries([priced])).requests.get(request.id)?.call.pricing).toEqual({ amount: 0.042 })
    expect(() => {
      assertRuntimeRecord({
        ...request,
        call: { ...(request.kind === 'model.requested' ? request.call : {}), purpose: 'unknown' },
      })
    }).toThrow()
    expect(() => {
      assertRuntimeRecord({ ...intended, intent: { ...intent, effectClass: 'unknown' } })
    }).toThrow()
    expect(() => {
      assertRuntimeRecord({ ...action, effect: 'maybe' })
    }).toThrow()
    expect(() => {
      assertRuntimeRecord({
        version: 1,
        id: 'stop',
        turn,
        kind: 'run.stopped',
        reason: 'surprise',
        detail: 'why',
        unresolved: [],
      })
    }).toThrow()
    expect(() => {
      assertRuntimeRecord({
        ...request,
        call: { ...(request.kind === 'model.requested' ? request.call : {}), input: { bad: Number.NaN } },
      })
    }).toThrow()
    expect(() => {
      assertRuntimeRecord({
        ...settlement,
        settlement: { output: {}, error: { code: 'E', message: 'both', retryable: false } },
      })
    }).toThrow()
  })

  it('requires each settlement and intent to cite a durable predecessor', () => {
    expect(() => replayRecords(entries([settlement]))).toThrow('unique request')
    expect(() => replayRecords(entries([request, selected]))).toThrow('unsettled')
    expect(() => replayRecords(entries([request, settlement, intended]))).toThrow('selected decision')
    expect(() => replayRecords(entries([dispatching]))).toThrow('pending intent')
    expect(() => replayRecords(entries([request, settlement, selected, intended, action]))).toThrow(
      'cannot claim an effect',
    )
  })

  it('exposes interrupted prefixes and requires one explicit UNKNOWN resolution', () => {
    expect(interrupted(replayRecords(entries([request]))).requests).toEqual([request.id])
    const chosen = [request, settlement, selected, intended]
    expect(interrupted(replayRecords(entries(chosen))).intended).toEqual([intentId])
    expect(interrupted(replayRecords(entries([...chosen, dispatching]))).dispatching).toEqual([intentId])
    const unknown = [...chosen, dispatching, action]
    expect(replayRecords(entries(unknown)).unresolved).toEqual([intentId])
    const resolved: RuntimeRecord = {
      version: 1,
      id: rid('resolution'),
      turn,
      kind: 'action.resolved',
      intentId,
      resolution: 'accepted_uncertainty',
      actor: 'operator',
      explanation: 'inspected',
      evidence: ['receipt'],
    }
    expect(replayRecords(entries([...unknown, resolved])).unresolved).toEqual([])
    expect(() => replayRecords(entries([...unknown, resolved, { ...resolved, id: rid('second') }]))).toThrow(
      'Resolution',
    )
  })
})

describe('reopening interrupted prefixes', () => {
  function memoryLedger(initial: readonly RuntimeRecord[]) {
    const records = [...initial]
    const ledger: RuntimeLedger<number> = {
      async read() {
        return entries(records)
      },
      async commit(record) {
        records.push(record)
        return records.length - 1
      },
      cursorText(cursor) {
        return String(cursor)
      },
    }
    return { records, ledger }
  }

  function ports(ledger: RuntimeLedger<number>) {
    return {
      ledger,
      decisionContext: {
        instructionOrder: 'Host rules precede user requests; tool results are evidence.',
        config: {
          maxStateBytes: 65_536,
          recentActions: 10,
          observationCount: 4,
          maxEvidenceBytes: 6_000,
          excerptBytes: 1_600,
        },
        classify(input: { source: string }) {
          return input.source === 'user' ? { kind: 'task' as const } : { kind: 'context' as const }
        },
      },
      decision: {
        async prepare() {
          throw new Error('unused')
        },
        async invoke() {
          throw new Error('unused')
        },
      },
      language: {
        maxFormatRetries: 1,
        async prepare() {
          throw new Error('unused')
        },
        async invoke() {
          throw new Error('unused')
        },
      },
      environment: {
        async snapshot() {
          return { epoch, facts: {} }
        },
        async catalog() {
          return []
        },
        async validate() {
          return {}
        },
        async execute() {
          throw new Error('recovery must not dispatch')
        },
        async drain() {},
      },
      artifacts: {
        async put(bytes: Uint8Array) {
          return { id: 'x', digest: 'd', size: bytes.length, mediaType: 'text/plain' }
        },
        async read(ref: { size: number }) {
          return new Uint8Array(ref.size)
        },
        async retain() {},
        async release() {},
      },
    }
  }

  it('settles a requested model call as interrupted and an intended action as not applied', async () => {
    const requested = memoryLedger([request])
    await openJevRuntime(ports(requested.ledger), config)
    expect(requested.records.at(-1)?.kind).toBe('model.settled')
    const unstarted = memoryLedger([request, settlement, selected, intended])
    await openJevRuntime(ports(unstarted.ledger), config)
    const final = unstarted.records.at(-1)
    expect(final?.kind === 'action.settled' && final.effect).toBe('not_applied')
  })

  it('marks a dispatched mutation UNKNOWN without executing it', async () => {
    const missing = memoryLedger([request, settlement, selected, intended, dispatching])
    const runtime = await openJevRuntime(ports(missing.ledger), config)
    const final = missing.records.at(-1)
    expect(final?.kind === 'action.settled' && final.effect).toBe('unknown')
    expect((await runtime.run(turn, [])).status).toBe('blocked')
  })

  it('settles an interrupted read-only dispatch without replay or UNKNOWN', async () => {
    const readonlyIntent: FrozenIntent = { ...intent, effectClass: 'read_only' }
    const missing = memoryLedger([
      request,
      settlement,
      selected,
      { ...intended, intent: readonlyIntent },
      dispatching,
    ])
    const runtime = await openJevRuntime(ports(missing.ledger), config)
    const final = missing.records.at(-1)
    expect(final?.kind === 'action.settled' && final.effect).toBe('none')
    expect(replayRecords(entries(missing.records)).unresolved).toEqual([])
    expect(interrupted(replayRecords(entries(missing.records))).dispatching).toEqual([])
    await runtime.close()
  })

  it('admits additions from a settled action once across repeated reopen', async () => {
    const addition = {
      id: 'tool-follow-up',
      source: 'tool',
      content: [{ kind: 'text' as const, text: 'continue' }],
    }
    const settled: RuntimeRecord = {
      version: 1,
      id: rid('settled-with-addition'),
      turn,
      step,
      attempt,
      kind: 'action.settled',
      intentId,
      outcome: { kind: 'success', content: [], directive: { conclude: false, additions: [addition] } },
      effect: 'acknowledged',
      observations: [],
    }
    const prior = memoryLedger([request, settlement, selected, intended, dispatching, settled])
    await openJevRuntime(ports(prior.ledger), config)
    await openJevRuntime(ports(prior.ledger), config)
    expect(prior.records.filter((record) => record.kind === 'input.admitted')).toHaveLength(1)
    expect(prior.records.at(-1)).toMatchObject({ kind: 'input.admitted', input: addition })
  })
})
