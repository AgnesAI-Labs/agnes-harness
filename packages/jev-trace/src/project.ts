/** Pure projection of an observed Session prefix into decision and action traces. */

import type { IntentId, JsonValue, RecordId, RuntimeRecord, StepId, TurnId } from '@agnes/jev-runtime'
import type {
  TraceAction,
  TraceDecision,
  TraceEntry,
  TraceHead,
  TraceOption,
  TraceRequest,
  TraceStep,
  TraceStop,
  TraceTurn,
  TraceView,
} from './types.js'

type MutableRequest = { -readonly [K in keyof TraceRequest]: TraceRequest[K] }
type MutableAction = { -readonly [K in keyof TraceAction]: TraceAction[K] }
interface MutableStep {
  id?: StepId
  number: number
  firstSeq: number
  lastSeq: number
  requests: MutableRequest[]
  decisions: TraceDecision[]
  actions: MutableAction[]
}
interface MutableTurn {
  id: TurnId
  number: number
  firstSeq: number
  lastSeq: number
  steps: Map<number, MutableStep>
  stops: TraceStop[]
  actions: MutableAction[]
}

function object(value: JsonValue | undefined): { [key: string]: JsonValue } | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function role(key: string): TraceHead['role'] {
  if (key === 'phase' || key === 'purpose') return 'phase'
  if (
    key === 'operation' ||
    key.startsWith('operation::') ||
    key.startsWith('operation_') ||
    key.startsWith('action__')
  )
    return 'action'
  if (key.startsWith('binding::') || key.startsWith('binding_')) return 'binding'
  return 'other'
}

function submittedHeads(input: JsonValue): TraceHead[] {
  const questions = object(object(input)?.['questions'])
  if (questions === undefined) return []
  return Object.entries(questions).flatMap(([key, value]) => {
    const question = object(value)
    const criteria = object(question?.['criteria'])
    if (question?.['type'] !== 'choice' || criteria === undefined) return []
    return [
      {
        key,
        role: role(key),
        status: 'pending' as const,
        options: Object.entries(criteria).map(
          ([option, criterion]): TraceOption => ({
            key: option,
            criterion,
            selected: false,
          }),
        ),
      },
    ]
  })
}

function validChoice(answer: JsonValue | undefined, head: TraceHead, expected: string): TraceHead {
  const fields = object(answer)
  const values = object(fields?.['probabilities'])
  const confidence = fields?.['confidence']
  const keys = head.options.map((option) => option.key)
  const probabilities = keys.map((key) => values?.[key])
  const valid =
    (fields?.['type'] === undefined || fields['type'] === 'choice') &&
    fields?.['choice'] === expected &&
    keys.includes(expected) &&
    typeof confidence === 'number' &&
    Number.isFinite(confidence) &&
    confidence >= 0 &&
    confidence <= 1 &&
    values !== undefined &&
    Object.keys(values).length === keys.length &&
    probabilities.every(
      (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1,
    ) &&
    Math.abs(probabilities.reduce<number>((sum, value) => sum + (value as number), 0) - 1) < 0.02 &&
    (values[expected] as number) >= Math.max(...(probabilities as number[])) - 1e-6
  if (!valid) return { ...head, status: 'invalid' }
  return {
    ...head,
    status: 'consumed',
    selected: expected,
    confidence,
    options: head.options.map((option) => ({
      ...option,
      selected: option.key === expected,
      probability: values[option.key] as number,
    })),
  }
}

function deterministic(key: string, kind: TraceHead['role'], selected: string): TraceHead {
  return {
    key,
    role: kind,
    status: 'deterministic',
    selected,
    options: [{ key: selected, criterion: selected, selected: true }],
  }
}

function sharedHeads(
  request: TraceRequest,
  answers: ReturnType<typeof object>,
  decision: TraceDecision,
  manifest: NonNullable<ReturnType<typeof object>>,
): TraceHead[] {
  const operations = manifest['operations']
  const branch = Array.isArray(operations)
    ? operations.map(object).find((value) => value?.['purpose'] === decision.phase)
    : undefined
  const choices = branch?.['choices']
  const operation = Array.isArray(choices)
    ? choices
        .map(object)
        .find((value) =>
          decision.operation === 'RESPOND'
            ? value?.['kind'] === 'respond'
            : value?.['operation'] === decision.operation,
        )
    : undefined
  const bindings = manifest['bindings']
  const binding = Array.isArray(bindings)
    ? bindings.map(object).find((value) => value?.['operation'] === decision.operation)
    : undefined
  const selected = new Map<string, string>([['purpose', decision.phase]])
  if (typeof branch?.['question'] === 'string' && typeof operation?.['key'] === 'string') {
    selected.set(branch['question'], operation['key'])
  }
  const bindingQuestion = binding?.['question']
  if (typeof bindingQuestion === 'string') {
    const candidates = binding?.['choices']
    const offered = Array.isArray(candidates)
      ? candidates.map(object).find((value) => object(value?.['candidate'])?.['id'] === decision.candidateId)
      : undefined
    selected.set(
      bindingQuestion,
      decision.candidateId === undefined
        ? 'LLM_PARAMETERS'
        : typeof offered?.['key'] === 'string'
          ? offered['key']
          : String(decision.candidateId),
    )
  }
  // Recorded manifest keys bind the submitted questions to one route; M7 display strings never define executable calls.
  const heads = request.heads.map((head) => {
    const expected = selected.get(head.key)
    return expected === undefined
      ? { ...head, status: 'unconsumed' as const }
      : validChoice(answers?.[head.key], head, expected)
  })
  if (
    decision.operation === 'RESPOND' &&
    branch?.['question'] === null &&
    operation?.['kind'] === 'respond'
  ) {
    heads.push(deterministic('operation_RESPOND', 'action', 'RESPOND'))
  }
  if (typeof binding?.['key'] === 'string' && !heads.some((head) => head.key === binding['key'])) {
    if (binding['mode'] === 'no_arguments')
      heads.push(deterministic(binding['key'], 'binding', 'no_arguments'))
    else if (
      binding['mode'] === 'parameterized' &&
      bindingQuestion === null &&
      Array.isArray(binding['choices']) &&
      binding['choices'].length === 0
    ) {
      heads.push(deterministic(binding['key'], 'binding', 'LLM_PARAMETERS'))
    }
  }
  return heads
}

function conditionalHeads(
  request: TraceRequest,
  answers: ReturnType<typeof object>,
  decision: TraceDecision,
  manifest: ReturnType<typeof object>,
): TraceHead[] {
  const operationKey = `operation::${decision.phase}`
  const operationChoice =
    decision.operation === 'RESPOND' ? 'RESPOND' : `tool::${encodeURIComponent(decision.operation)}`
  const bindingKey = `binding::${decision.phase}::${encodeURIComponent(decision.operation)}`
  const bindings = manifest?.['bindings']
  const binding = Array.isArray(bindings)
    ? bindings
        .map(object)
        .find(
          (value) =>
            value?.['key'] === bindingKey &&
            value['purpose'] === decision.phase &&
            value['operation'] === decision.operation,
        )
    : undefined
  const selected = new Map([
    ['purpose', decision.phase],
    [operationKey, operationChoice],
  ])
  const bindingChoice = object(answers?.[bindingKey])?.['choice']
  const candidates = binding?.['choices']
  if (decision.candidateId !== undefined && Array.isArray(candidates)) {
    const offered = candidates
      .map(object)
      .find((value) => object(value?.['candidate'])?.['id'] === decision.candidateId)
    selected.set(
      bindingKey,
      typeof offered?.['key'] === 'string' ? offered['key'] : String(decision.candidateId),
    )
  } else if (typeof bindingChoice === 'string') selected.set(bindingKey, bindingChoice)
  else if (request.heads.some((head) => head.key === bindingKey)) selected.set(bindingKey, 'LLM_PARAMETERS')
  const heads = request.heads.map((head) => {
    const expected = selected.get(head.key)
    return expected === undefined
      ? { ...head, status: 'unconsumed' as const }
      : validChoice(answers?.[head.key], head, expected)
  })
  const operations = manifest?.['operations']
  const branch = Array.isArray(operations)
    ? operations.map(object).find((value) => value?.['purpose'] === decision.phase)
    : undefined
  const choices = branch?.['choices']
  if (
    !heads.some((head) => head.key === operationKey) &&
    branch?.['question'] === null &&
    Array.isArray(choices) &&
    choices.length === 1 &&
    object(choices[0])?.['key'] === operationChoice
  ) {
    heads.push(deterministic(operationKey, 'action', operationChoice))
  }
  if (!heads.some((head) => head.key === bindingKey) && binding !== undefined) {
    if (binding['mode'] === 'no_arguments') heads.push(deterministic(bindingKey, 'binding', 'no_arguments'))
    else if (
      binding['mode'] === 'parameterized' &&
      binding['question'] === null &&
      Array.isArray(binding['choices']) &&
      binding['choices'].length === 0
    ) {
      heads.push(deterministic(bindingKey, 'binding', 'LLM_PARAMETERS'))
    }
  }
  return heads
}

function selectedHeads(
  request: TraceRequest,
  output: JsonValue | undefined,
  decision: TraceDecision,
  manifest?: ReturnType<typeof object>,
): TraceHead[] {
  const answers = object(object(output)?.['answers'])
  if (manifest?.['designRevision'] === 5) return sharedHeads(request, answers, decision, manifest)
  if (
    request.heads.some((head) => head.key === 'purpose') &&
    !request.heads.some((head) => head.key === 'operation')
  ) {
    return conditionalHeads(request, answers, decision, manifest)
  }
  if (request.heads.some((head) => head.key === 'operation')) {
    const operation =
      decision.operation === 'RESPOND' ? 'RESPOND' : `tool::${encodeURIComponent(decision.operation)}`
    const binding = `binding::${encodeURIComponent(decision.operation)}`
    const offeredBinding = object(answers?.[binding])?.choice
    const selected = new Map<string, string>([['operation', operation]])
    if (decision.phase !== 'UNSPECIFIED') selected.set('purpose', decision.phase)
    if (request.heads.some((head) => head.key === binding))
      selected.set(
        binding,
        decision.candidateId === undefined
          ? 'LLM_PARAMETERS'
          : typeof offeredBinding === 'string'
            ? offeredBinding
            : String(decision.candidateId),
      )
    return request.heads.map((head) => {
      const expected = selected.get(head.key)
      return expected === undefined
        ? { ...head, status: 'unconsumed' as const }
        : validChoice(answers?.[head.key], head, expected)
    })
  }
  const phase = decision.phase.toLowerCase()
  const actionKey = `action__${phase}`
  const currentBindingKey = `binding__${decision.operation}`
  const legacyBindingKey = `binding__${phase}__${decision.operation}`
  const hasCurrentBinding = request.heads.some((head) => head.key === currentBindingKey)
  const hasLegacyBinding = request.heads.some((head) => head.key === legacyBindingKey)
  const legacyManifest = request.heads.some(
    (head) =>
      head.role === 'binding' &&
      request.heads.some(
        (action) =>
          action.role === 'action' &&
          action.options.some(
            (option) => head.key === `binding__${action.key.slice('action__'.length)}__${option.key}`,
          ),
      ),
  )
  const bindingKey = hasCurrentBinding
    ? currentBindingKey
    : hasLegacyBinding || legacyManifest
      ? legacyBindingKey
      : currentBindingKey
  const selected = new Map<string, string>([
    ['phase', decision.phase],
    [actionKey, decision.operation],
  ])
  if (decision.operation !== 'ANSWER') selected.set(bindingKey, decision.candidateId ?? 'LLM_PARAMETERS')
  const heads = request.heads.map((head) => {
    const expected = selected.get(head.key)
    return expected === undefined
      ? { ...head, status: 'unconsumed' as const }
      : validChoice(answers?.[head.key], head, expected)
  })
  for (const [key, expected] of selected) {
    if (heads.some((head) => head.key === key)) continue
    if (!heads.some((head) => head.key === 'phase')) continue
    heads.push(deterministic(key, role(key), expected))
  }
  return heads
}

function supportingHeads(
  request: TraceRequest,
  output: JsonValue | undefined,
  decision: TraceDecision,
  manifest: ReturnType<typeof object>,
  resource: NonNullable<ReturnType<typeof object>>,
): TraceHead[] {
  const questionIds = resource['supportingQuestionIds']
  const branches = manifest?.['operations']
  if (
    manifest?.['designRevision'] !== 5 ||
    resource['supportApplied'] !== true ||
    !Array.isArray(questionIds) ||
    !Array.isArray(branches) ||
    resource['decisionRecordId'] !== decision.id ||
    resource['operation'] !== decision.operation ||
    resource['purpose'] !== decision.phase ||
    decision.operation === 'RESPOND'
  )
    return [...request.heads]
  const answers = object(object(output)?.['answers'])
  return request.heads.map((head) => {
    // Supporting branches explain the gate only; they never consume a Binding or add an execution path.
    if (head.status !== 'unconsumed' || head.role !== 'action' || !questionIds.includes(head.key)) return head
    const branch = branches.map(object).find((value) => value?.['question'] === head.key)
    const choices = branch?.['choices']
    const offered = Array.isArray(choices)
      ? choices.map(object).find((value) => value?.['operation'] === decision.operation)
      : undefined
    if (typeof offered?.['key'] !== 'string') return head
    const validated = validChoice(answers?.[head.key], head, offered['key'])
    return validated.status !== 'consumed'
      ? head
      : {
          ...validated,
          status: 'supporting',
          options: validated.options.map((option) => ({ ...option, selected: false })),
        }
  })
}

function finishRequest(
  request: MutableRequest,
  record: RuntimeRecord & { kind: 'model.settled' },
  entry: TraceEntry,
): void {
  request.status = record.settlement.error === undefined ? 'settled' : 'failed'
  request.settledSeq = entry.seq
  request.settledTime = entry.time
  if (record.settlement.observedModel !== undefined) request.observedModel = record.settlement.observedModel
  if (record.settlement.usage !== undefined) request.usage = record.settlement.usage
  if (record.settlement.latencyMs !== undefined) request.latencyMs = record.settlement.latencyMs
  request.heads = request.heads.map((head) => ({ ...head, status: 'unconsumed' }))
}

/**
 * Project only records at or before an inclusive host Session sequence.
 * @param entries - Observed host records; Session sequence gaps from other event types are allowed.
 * @param throughSeq - Inclusive cursor for local seek; omitted reads all supplied records.
 * @returns A JSON-serializable read-only view without model, tool, or recovery effects.
 */
export function projectTrace(entries: readonly TraceEntry[], throughSeq?: number): TraceView {
  if (throughSeq !== undefined && (!Number.isSafeInteger(throughSeq) || throughSeq < 0)) {
    throw new RangeError('Trace cursor must be a nonnegative Session sequence')
  }
  const ordered = [...entries].sort((left, right) => left.seq - right.seq)
  for (let index = 0; index < ordered.length; index += 1) {
    const entry = ordered[index]
    if (
      entry === undefined ||
      !Number.isSafeInteger(entry.seq) ||
      entry.seq < 0 ||
      (index > 0 && ordered[index - 1]?.seq === entry.seq)
    ) {
      throw new Error('Trace entries require distinct nonnegative observation sequences')
    }
  }
  const visible = ordered.filter((entry) => throughSeq === undefined || entry.seq <= throughSeq)
  const turns = new Map<number, MutableTurn>()
  const requests = new Map<RecordId, MutableRequest>()
  const settledOutput = new Map<RecordId, JsonValue | undefined>()
  const manifests = new Map<string, ReturnType<typeof object>>()
  const requestManifests = new Map<RecordId, ReturnType<typeof object>>()
  const actions = new Map<IntentId, MutableAction>()
  for (const entry of visible) {
    const { record } = entry
    let turn = turns.get(entry.turn)
    if (turn === undefined) {
      turn = {
        id: record.turn,
        number: entry.turn,
        firstSeq: entry.seq,
        lastSeq: entry.seq,
        steps: new Map(),
        stops: [],
        actions: [],
      }
      turns.set(entry.turn, turn)
    } else if (turn.id !== record.turn) {
      throw new Error('Trace host turn number maps to multiple portable turn IDs')
    }
    turn.lastSeq = entry.seq
    let step: MutableStep | undefined
    if (entry.step !== undefined) {
      step = turn.steps.get(entry.step)
      if (step === undefined) {
        step = {
          ...(record.step === undefined ? {} : { id: record.step }),
          number: entry.step,
          firstSeq: entry.seq,
          lastSeq: entry.seq,
          requests: [],
          decisions: [],
          actions: [],
        }
        turn.steps.set(entry.step, step)
      } else if (record.step !== undefined && step.id !== undefined && step.id !== record.step) {
        throw new Error('Trace host step number maps to multiple portable step IDs')
      }
      if (step.id === undefined && record.step !== undefined) step.id = record.step
      step.lastSeq = entry.seq
    }
    switch (record.kind) {
      case 'resource.observed': {
        const resource = object(record.resource)
        if (resource?.['kind'] === 'jev.decision.manifest.v1')
          manifests.set(`${entry.turn}:${entry.step ?? ''}`, resource)
        if (resource?.['kind'] === 'jev.decision.route.v1' && typeof resource['requested'] === 'string') {
          const request = requests.get(resource['requested'] as RecordId)
          const decision = step?.decisions.find(
            (value) => value.requested === request?.id && value.purpose === 'decision',
          )
          if (request !== undefined && decision !== undefined)
            request.heads = supportingHeads(
              request,
              settledOutput.get(request.id),
              decision,
              requestManifests.get(request.id),
              resource,
            )
        }
        break
      }
      case 'model.requested': {
        const request: MutableRequest = {
          id: record.id,
          ...(record.attempt === undefined ? {} : { attempt: record.attempt }),
          requestedSeq: entry.seq,
          requestedTime: entry.time,
          purpose: record.call.purpose,
          backend: record.call.backend,
          requestedModel: record.call.requestedModel,
          status: 'pending',
          heads:
            record.call.purpose === 'decision' && record.call.codec === 'systemone-json-v1'
              ? submittedHeads(record.call.input)
              : [],
        }
        step?.requests.push(request)
        requests.set(record.id, request)
        if (record.call.purpose === 'decision')
          requestManifests.set(record.id, manifests.get(`${entry.turn}:${entry.step ?? ''}`))
        break
      }
      case 'model.settled': {
        const request = requests.get(record.requested)
        if (request === undefined) throw new Error('Trace model settlement has no observed request')
        finishRequest(request, record, entry)
        settledOutput.set(record.requested, record.settlement.output)
        break
      }
      case 'decision.selected': {
        const request = requests.get(record.requested)
        if (request === undefined || (request.purpose !== 'decision' && request.purpose !== 'arbitration')) {
          throw new Error('Trace selected decision has no decision or arbitration request')
        }
        const decision: TraceDecision = {
          id: record.id,
          seq: entry.seq,
          time: entry.time,
          requested: record.requested,
          purpose: request.purpose,
          phase: record.phase,
          operation: record.operation,
          ...(record.candidateId === undefined ? {} : { candidateId: record.candidateId }),
          ...(request.purpose === 'decision' && record.confidence !== undefined
            ? { confidence: record.confidence }
            : {}),
          ...(record.escalation === undefined ? {} : { escalation: record.escalation }),
        }
        step?.decisions.push(decision)
        if (request.purpose === 'decision') {
          request.heads = selectedHeads(
            request,
            settledOutput.get(record.requested),
            decision,
            requestManifests.get(record.requested),
          )
        }
        break
      }
      case 'action.intended': {
        const action: MutableAction = {
          intentId: record.intent.id,
          decisionId: record.decision,
          intendedSeq: entry.seq,
          intendedTime: entry.time,
          tool: record.intent.tool,
          arguments: record.intent.arguments,
          status: 'intended',
        }
        turn.actions.push(action)
        step?.actions.push(action)
        actions.set(record.intent.id, action)
        break
      }
      case 'action.dispatching': {
        const action = actions.get(record.intentId)
        if (action === undefined) throw new Error('Trace dispatch has no intended action')
        action.status = 'dispatching'
        action.dispatchingSeq = entry.seq
        break
      }
      case 'action.settled': {
        const action = actions.get(record.intentId)
        if (action === undefined) throw new Error('Trace action settlement has no intended action')
        action.status = record.effect === 'unknown' ? 'unknown' : 'settled'
        action.settledSeq = entry.seq
        action.outcome = record
        break
      }
      case 'action.resolved': {
        const action = actions.get(record.intentId)
        if (action === undefined) throw new Error('Trace resolution has no intended action')
        action.status = 'resolved'
        action.resolutionSeq = entry.seq
        action.resolution = record
        break
      }
      case 'run.stopped': {
        turn.stops.push({
          seq: entry.seq,
          time: entry.time,
          reason: record.reason,
          detail: record.detail,
          unresolved: record.unresolved,
        })
        for (const intentId of record.unresolved) {
          const action = actions.get(intentId)
          if (action !== undefined && action.status === 'dispatching') action.status = 'unknown'
        }
        break
      }
      default:
        break
    }
  }
  return {
    throughSeq: throughSeq ?? visible.at(-1)?.seq ?? null,
    turns: [...turns.values()]
      .sort((left, right) => left.firstSeq - right.firstSeq)
      .map(
        (turn): TraceTurn => ({
          id: turn.id,
          number: turn.number,
          firstSeq: turn.firstSeq,
          lastSeq: turn.lastSeq,
          stops: turn.stops,
          actions: turn.actions,
          steps: [...turn.steps.values()]
            .sort((left, right) => left.firstSeq - right.firstSeq)
            .map((step): TraceStep => {
              const originalDecision = step.decisions.find((decision) => decision.purpose === 'decision')
              const actionDecision = step.actions.at(-1)?.decisionId
              const finalDecision =
                actionDecision === undefined
                  ? step.decisions.at(-1)
                  : step.decisions.find((decision) => decision.id === actionDecision)
              return {
                ...(step.id === undefined ? {} : { id: step.id }),
                number: step.number,
                firstSeq: step.firstSeq,
                lastSeq: step.lastSeq,
                requests: step.requests,
                decisions: step.decisions,
                actions: step.actions,
                ...(originalDecision === undefined ? {} : { originalDecision }),
                ...(finalDecision === undefined ? {} : { finalDecision }),
              }
            }),
        }),
      ),
  }
}
