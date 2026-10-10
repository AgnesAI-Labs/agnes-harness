/** Persisted response-review decisions are scoped to substantive evidence rather than model-call history. */

import { readFeedback } from './progress.js'
import type { DecisionContextPort, IntentId, JsonValue, RecordId, RuntimeRecord, TurnId } from './types.js'

function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key] ?? null)}`)
      .join(',')}}`
  return JSON.stringify(value)
}

function withoutLocalRefs(value: JsonValue | undefined, names: readonly string[]): JsonValue {
  if (value === undefined) return null
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !names.includes(key)))
}

function checkpointWorkspace(value: JsonValue | undefined): JsonValue {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value))
    return value ?? null
  return { ...value, coverage: withoutLocalRefs(value.coverage, ['observedAt']) }
}

function checkpointResources(value: JsonValue | undefined): JsonValue {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value))
    return value ?? {}
  const attachments = value.attachments
  if (attachments === null || typeof attachments !== 'object' || Array.isArray(attachments)) return value
  return {
    ...value,
    attachments: {
      ...attachments,
      items: Array.isArray(attachments.items)
        ? attachments.items.map((item) => withoutLocalRefs(item, ['ref', 'inputRef']))
        : [],
    },
  }
}

/**
 * Identify a response-review checkpoint without letting repeated model calls create new evidence.
 * @param records - Committed ledger prefix.
 * @param turn - Current task turn.
 * @param state - Current decision facts; history and display budgets are excluded.
 * @param describeObservation - Pure host projection removing only recognized transport metadata.
 * @returns Stable SHA-256 identity of task, rules, resources and distinct execution outcomes.
 */
export async function responseCheckpoint(
  records: readonly RuntimeRecord[],
  turn: TurnId,
  state: JsonValue,
  describeObservation?: DecisionContextPort['describeObservation'],
): Promise<string> {
  const view = state !== null && typeof state === 'object' && !Array.isArray(state) ? state : {}
  const intents = new Map(
    records.flatMap((record) =>
      record.kind === 'action.intended' ? [[record.intent.id, record.intent] as const] : [],
    ),
  )
  const evidence = new Set<string>()
  for (const record of records) {
    if (record.turn !== turn) continue
    if (record.kind === 'action.settled') {
      const intent = intents.get(record.intentId)
      evidence.add(
        canonical({
          operation: intent?.tool ?? null,
          arguments: intent?.arguments ?? null,
          effect: record.effect,
          outcome: record.outcome.kind,
          value: record.outcome.value ?? null,
          observations: record.observations.map((item) => {
            const semantic = describeObservation?.({ ...item, sourceRecordId: record.id })
            return {
              kind: item.kind,
              source: item.source,
              data: semantic === undefined ? item.data : semantic.data,
              coverage: semantic?.coverage === undefined ? (item.coverage ?? null) : semantic.coverage,
              references: item.references?.map((ref) => ({ ...ref })) ?? [],
            }
          }),
          content: record.outcome.content.map((block) =>
            block.kind === 'text'
              ? { text: block.text }
              : { digest: block.artifact.digest, mediaType: block.artifact.mediaType },
          ),
          error:
            record.outcome.error === undefined
              ? null
              : { code: record.outcome.error.code, data: record.outcome.error.data ?? null },
        }),
      )
    }
  }
  // Request identity must survive presentation changes; a new task cannot reuse an accepted answer checkpoint.
  const task =
    view.task !== null && typeof view.task === 'object' && !Array.isArray(view.task) ? view.task : undefined
  const payload = canonical({
    turn,
    requests: task?.requests ?? [],
    rules: view.rules ?? [],
    environment: view.environment ?? {},
    workspace: checkpointWorkspace(view.workspace),
    resources: checkpointResources(view.resources),
    pending: Array.isArray(view.pending)
      ? view.pending.map((item) => withoutLocalRefs(item, ['ref', 'step', 'sourceRef']))
      : [],
    evidence: [...evidence].sort(),
  })
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Recover the attempts and accepted result for one response checkpoint.
 * @param records - Committed prefix including review-request and accepted-verdict resources.
 * @param turn - Current turn.
 * @param checkpoint - Exact evidence checkpoint.
 * @returns Consumed attempt count and any accepted response or one-shot tool choice.
 */
export function responseReviewState(
  records: readonly RuntimeRecord[],
  turn: TurnId,
  checkpoint: string,
): {
  readonly attempts: number
  readonly accepted?: 'allow_response' | 'continue_call'
} {
  let attempts = 0
  let accepted: 'allow_response' | 'continue_call' | undefined
  for (const record of records) {
    if (record.turn !== turn || record.kind !== 'resource.observed') continue
    const value = record.resource
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      value.kind !== 'jev.response-review.v1' ||
      value.checkpoint !== checkpoint
    )
      continue
    if (value.stage === 'requested') attempts++
    else if (
      value.stage === 'accepted' &&
      (value.verdict === 'allow_response' || value.verdict === 'continue_call')
    )
      accepted = value.verdict
  }
  return { attempts, ...(accepted === undefined ? {} : { accepted }) }
}

/**
 * Select the latest typed current-turn recovery, independently of repeated successful observations.
 * A success only clears a failure the caller already knew about: a sibling that was dispatched
 * before the failure settled may finish later, but it never observed the failure, so it proves
 * nothing about recovery. Dispatch markers supply that ordering without a second state store.
 * @param records - Committed prefix.
 * @param turn - Current turn.
 * @returns An unsettled recoverable failure's source record, or undefined after success or arbitration acceptance.
 */
export function pendingRecovery(records: readonly RuntimeRecord[], turn: TurnId): RecordId | undefined {
  let pending: RecordId | undefined
  const pendingAtDispatch = new Map<IntentId, RecordId | undefined>()
  for (const record of records) {
    if (record.turn !== turn) continue
    if (record.kind === 'resource.observed' && readFeedback(record.resource) !== undefined)
      pending = record.id
    else if (record.kind === 'action.dispatching') pendingAtDispatch.set(record.intentId, pending)
    else if (record.kind === 'action.settled') {
      if (record.outcome.kind === 'error' && (record.effect === 'none' || record.effect === 'not_applied'))
        pending = record.id
      else if (pending !== undefined && pendingAtDispatch.get(record.intentId) === pending)
        pending = undefined
    } else if (record.kind === 'decision.selected' && record.source === 'llm_arbitration') pending = undefined
  }
  return pending
}
