/** Durable recovery feedback and evidence-based progress derived from runtime records. */
import { brandString } from './brand.js'
import type { FrozenIntent, JsonValue, RecordId, RuntimeRecord, TurnId } from './types.js'

/** Host schema validation rejected model-authored arguments before any intent was frozen. */
export class InvalidAuthoredArguments extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidAuthoredArguments'
  }
}

/** A finite candidate's previously observed resource state no longer holds before dispatch. */
export class StaleCandidate extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StaleCandidate'
  }
}

/** One recoverable refusal linked to the request that produced it. */
export interface RuntimeFeedback {
  readonly kind: 'jev.runtime.feedback.v1'
  readonly code:
    | 'INVALID_DECISION'
    | 'BINDING_DECLINED'
    | 'INVALID_PARAMETERS'
    | 'INVALID_ARBITRATION'
    | 'INVALID_ANSWER'
    | 'DUPLICATE_NO_PROGRESS'
    | 'CANDIDATE_STALE'
  readonly stage: 'decision' | 'parameters' | 'arbitration' | 'answer' | 'preflight'
  readonly sourceRecordId: RecordId
  readonly operation: string | null
  readonly message: string
  /** False excludes new internal decision feedback from language history; absence preserves the recorded projection. */
  readonly languageVisible?: false
}

/**
 * Recognize internal feedback and reject malformed records claiming its marker.
 * @param resource - committed runtime resource.
 * @returns validated feedback, or undefined for other resource kinds.
 */
export function readFeedback(resource: JsonValue): RuntimeFeedback | undefined {
  if (
    resource === null ||
    typeof resource !== 'object' ||
    Array.isArray(resource) ||
    resource.kind !== 'jev.runtime.feedback.v1'
  )
    return undefined
  if (
    typeof resource.sourceRecordId !== 'string' ||
    typeof resource.message !== 'string' ||
    !(resource.operation === null || typeof resource.operation === 'string') ||
    !feedbackCode(resource.code) ||
    !feedbackStage(resource.stage) ||
    (resource.languageVisible !== undefined && resource.languageVisible !== false)
  ) {
    throw new Error('Invalid Jev runtime feedback record')
  }
  return {
    kind: 'jev.runtime.feedback.v1',
    code: resource.code,
    stage: resource.stage,
    sourceRecordId: brandString<RecordId>(resource.sourceRecordId),
    operation: resource.operation,
    message: resource.message,
    ...(resource.languageVisible === false ? { languageVisible: false } : {}),
  }
}

function feedbackCode(value: JsonValue | undefined): value is RuntimeFeedback['code'] {
  return (
    value === 'INVALID_DECISION' ||
    value === 'BINDING_DECLINED' ||
    value === 'INVALID_PARAMETERS' ||
    value === 'INVALID_ARBITRATION' ||
    value === 'INVALID_ANSWER' ||
    value === 'DUPLICATE_NO_PROGRESS' ||
    value === 'CANDIDATE_STALE'
  )
}

function feedbackStage(value: JsonValue | undefined): value is RuntimeFeedback['stage'] {
  return (
    value === 'decision' ||
    value === 'parameters' ||
    value === 'arbitration' ||
    value === 'answer' ||
    value === 'preflight'
  )
}

function stable(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key] ?? null)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function intentKey(intent: FrozenIntent): string {
  return stable({ tool: intent.tool, revision: intent.toolRevision, arguments: intent.arguments })
}

function resultKey(record: RuntimeRecord & { kind: 'action.settled' }): string {
  return stable({
    effect: record.effect,
    kind: record.outcome.kind,
    value: record.outcome.value ?? null,
    content: record.outcome.content.map((block) =>
      block.kind === 'text'
        ? { kind: 'text', text: block.text }
        : {
            kind: 'artifact',
            artifact: {
              digest: block.artifact.digest,
              size: block.artifact.size,
              mediaType: block.artifact.mediaType,
            },
            label: block.label ?? null,
          },
    ),
    error:
      record.outcome.error === undefined
        ? null
        : {
            code: record.outcome.error.code,
            data: record.outcome.error.data ?? null,
          },
  })
}

function taskContentKey(record: RuntimeRecord): string | undefined {
  if (
    record.kind !== 'input.admitted' ||
    record.input.source !== 'user' ||
    !record.input.content.some((block) =>
      block.kind === 'text' ? block.text.trim().length > 0 : block.artifact.digest.length > 0,
    )
  )
    return
  return stable(
    record.input.content.map((block) =>
      block.kind === 'text'
        ? { kind: 'text', text: block.text }
        : {
            kind: 'artifact',
            digest: block.artifact.digest,
            size: block.artifact.size,
            mediaType: block.artifact.mediaType,
          },
    ),
  )
}

function successfulResult(record: RuntimeRecord & { kind: 'action.settled' }, dispatched: boolean): boolean {
  return (
    dispatched &&
    record.outcome.kind === 'success' &&
    record.effect !== 'unknown' &&
    record.effect !== 'not_applied'
  )
}

/**
 * Refuse a third dispatch after two equal results without new task content or successful evidence.
 * @param records - committed prefix.
 * @param turn - current turn.
 * @param intent - invocation proposed for dispatch.
 * @returns true after two equal results for this invocation since the last substantive progress checkpoint.
 */
export function repeatedIntent(
  records: readonly RuntimeRecord[],
  turn: TurnId,
  intent: FrozenIntent,
): boolean {
  const intents = new Map(
    records
      .filter((record) => record.kind === 'action.intended')
      .map((record) => [record.intent.id, record.intent] as const),
  )
  const dispatching = new Set(
    records.filter((record) => record.kind === 'action.dispatching').map((record) => record.intentId),
  )
  const target = intentKey(intent)
  const tasks = new Set<string>()
  const seen = new Set<string>()
  let lastResult: string | undefined
  let repeats = 0
  for (const record of records) {
    if (record.turn !== turn) continue
    const task = taskContentKey(record)
    if (task !== undefined && !tasks.has(task)) {
      tasks.add(task)
      seen.clear()
      lastResult = undefined
      repeats = 0
    }
    if (record.kind !== 'action.settled' || !dispatching.has(record.intentId)) continue
    const stored = intents.get(record.intentId)
    if (stored === undefined) continue
    const invocation = intentKey(stored)
    const result = resultKey(record)
    const key = `${invocation}|${result}`
    if (successfulResult(record, true) && !seen.has(key)) {
      seen.add(key)
      lastResult = undefined
      repeats = 0
    }
    if (invocation === target) {
      repeats = result === lastResult ? repeats + 1 : 1
      lastResult = result
    }
  }
  return repeats >= 2
}

/**
 * Reconstruct limits from recorded steps, stable failure categories, and substantive results.
 * @param records - Committed runtime prefix.
 * @param turn - Turn whose progress is reconstructed.
 * @returns Counters used by the turn's progress and recovery limits.
 */
export function progressOf(
  records: readonly RuntimeRecord[],
  turn: TurnId,
): {
  readonly noProgress: number
  readonly repeatedFailures: number
  readonly invalidDecisions: number
} {
  const intents = new Map(
    records
      .filter((record) => record.kind === 'action.intended')
      .map((record) => [record.intent.id, record.intent] as const),
  )
  const dispatching = new Set(
    records.filter((record) => record.kind === 'action.dispatching').map((record) => record.intentId),
  )
  const steps = new Map<
    string,
    {
      feedback: RuntimeFeedback[]
      newTask?: boolean
      newTaskAfterAction?: boolean
      actions: (RuntimeRecord & { kind: 'action.settled' })[]
    }
  >()
  const failures = new Map<string, number>()
  const knownRecords = new Set<RecordId>()
  const tasks = new Set<string>()
  let invalidDecisions = 0
  for (const record of records) {
    if (record.turn !== turn) {
      knownRecords.add(record.id)
      continue
    }
    const task = taskContentKey(record)
    const newTask = task !== undefined && !tasks.has(task)
    if (newTask) tasks.add(task)
    if (record.step === undefined && !newTask) {
      knownRecords.add(record.id)
      continue
    }
    const stepKey = record.step ?? `input:${record.id}`
    let entry = steps.get(stepKey)
    if (entry === undefined) {
      entry = { feedback: [], actions: [] }
      steps.set(stepKey, entry)
    }
    if (newTask) {
      if (entry.actions.length === 0) entry.newTask = true
      else entry.newTaskAfterAction = true
    }
    if (record.kind === 'resource.observed') {
      const feedback = readFeedback(record.resource)
      if (feedback === undefined) {
        knownRecords.add(record.id)
        continue
      }
      if (!knownRecords.has(feedback.sourceRecordId))
        throw new Error('Jev runtime feedback has no prior source record')
      entry.feedback.push(feedback)
      if (feedback.code === 'INVALID_DECISION') invalidDecisions++
      const signature = `${feedback.stage}|${feedback.operation ?? ''}|${feedback.code}`
      failures.set(signature, (failures.get(signature) ?? 0) + 1)
    }
    if (record.kind === 'action.settled') {
      entry.actions.push(record)
      const error = record.outcome.error
      if (error !== undefined) {
        const intent = intents.get(record.intentId)
        const stage = dispatching.has(record.intentId) ? 'dispatch' : 'preflight'
        const signature = `${stage}|${intent?.tool ?? ''}|${intent === undefined ? '' : intentKey(intent)}|${error.code}`
        failures.set(signature, (failures.get(signature) ?? 0) + 1)
      }
    }
    knownRecords.add(record.id)
  }
  const seen = new Set<string>()
  let noProgress = 0
  for (const step of steps.values()) {
    if (step.newTask) {
      seen.clear()
      noProgress = 0
    }
    if (step.actions.length > 0) {
      let advanced = false
      for (const action of step.actions) {
        const intent = intents.get(action.intentId)
        if (intent === undefined) throw new Error('Settled action has no frozen intent')
        const key = `${intentKey(intent)}|${resultKey(action)}`
        if (successfulResult(action, dispatching.has(action.intentId)) && !seen.has(key)) {
          seen.add(key)
          advanced = true
        }
      }
      noProgress = advanced ? 0 : noProgress + 1
    } else if (step.feedback.length > 0) noProgress++
    if (step.newTaskAfterAction) {
      seen.clear()
      noProgress = 0
    }
  }
  return { noProgress, repeatedFailures: Math.max(0, ...failures.values()), invalidDecisions }
}
