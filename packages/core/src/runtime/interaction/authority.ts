import type { Outcome } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import {
  canonicalJsonDigest,
  RuntimeErrorDetails,
  RuntimeSchemaRefs,
  validateApprovalAnswerForRequest,
  validateApprovalIntent,
  validateInlineApprovalAnswerReference,
  validateRuntime,
} from '@agnes/protocol/runtime'

type Answered = Extract<Wire.InteractionRecord, { status: 'answered' }>
export type InteractionEvidence = Answered['resolution']['evidence']
export type InteractionOwner = Wire.InteractionRecord['owner']

/** One accepted response, kept with the fingerprint that decides whether a retry is the same response. */
export type StoredInteractionResponse = Readonly<{
  responseId: Wire.Id
  fingerprint: Wire.Digest
  status: Wire.InteractionResponseStatus
}>

/** A terminal change that must wake the waiter; the delivery key is stable across redelivery. */
export type InteractionWake = Readonly<{
  deliveryKey: string
  interactionId: Wire.Id
  owner: InteractionOwner
  version: number
  status: Wire.InteractionRecord['status']
  responseId: Wire.Id | null
}>

/** Delivery progress of one wake. A dead wake keeps its data so a repair redelivers the same key. */
export type StoredInteractionWake = Readonly<{
  wake: InteractionWake
  delivery: 'pending' | 'acked' | 'dead'
  consecutiveFailures: number
  nextAttemptAt: Wire.Timestamp
  lastError: Wire.RuntimeError | null
  ackRef: string | null
}>

export interface InteractionTransaction {
  record(interactionId: Wire.Id): Wire.InteractionRecord | undefined
  recordByIdempotencyKey(idempotencyKey: Wire.Id): Wire.InteractionRecord | undefined
  response(responseId: Wire.Id): StoredInteractionResponse | undefined
  putRecord(record: Wire.InteractionRecord): void
  putResponse(response: StoredInteractionResponse): void
  wake(deliveryKey: string): StoredInteractionWake | undefined
  /** Pending wakes whose next attempt is due, oldest first. */
  dueWakes(now: Wire.Timestamp, limit: number): readonly StoredInteractionWake[]
  putWake(wake: StoredInteractionWake): void
}

export interface InteractionStorage {
  /** Commits every put of one body together. A body that throws leaves nothing behind. */
  transaction<T>(body: (tx: InteractionTransaction) => T): Promise<T>
}

export type InteractionClock = Readonly<{ now(): Wire.Timestamp; newId(): Wire.Id }>

export type InteractionResponseMethod = 'respond' | 'acceptResponse' | 'respondApproval'

/** The caller resolves actor and evidence from trusted ingress; a client cannot supply either. */
export type InteractionResponseInput = Readonly<{
  method: InteractionResponseMethod
  request: unknown
  actorRef: Wire.Id
  evidence: InteractionEvidence
}>

type Detail = keyof typeof RuntimeErrorDetails
type Refusal = { ok: false; error: Wire.RuntimeError }

export const fail = (detail: Detail, message: string): Refusal => ({
  ok: false,
  error: {
    code: RuntimeErrorDetails[detail].code as Wire.RuntimeError['code'],
    detailCode: detail,
    message,
    retryAdvice: { kind: 'never' },
    diagnosticId: 'interaction-authority',
  },
})

const requestSchema = {
  respond: 'InteractionRespondRequest',
  acceptResponse: 'InteractionClientRespondRequest',
  respondApproval: 'ApprovalRespondRequest',
} as const

const inline = (schema: Wire.SchemaRef, value: Wire.JsonValue) => ({
  kind: 'inline' as const,
  schema,
  value,
  digest: canonicalJsonDigest(value),
  bytes: new TextEncoder().encode(jcs(value)).length,
})

const isDue = (now: Wire.Timestamp, deadline: Wire.Timestamp) => Date.parse(now) >= Date.parse(deadline)

/** Stores only records the frozen schema accepts, so a construction slip can never be persisted. */
function checked(record: unknown): Outcome<Wire.InteractionRecord> {
  const parsed = validateRuntime('InteractionRecord', record)
  return parsed.ok ? parsed : fail('internal_error', 'interaction record failed its own schema')
}

/** Field rules a question answer must meet; full answerSchema decoding belongs to the schema owner. */
function questionAnswerError(
  question: Wire.QuestionRequest,
  answer: Extract<Wire.DataRef, { kind: 'inline' }>,
): string | undefined {
  const { value } = answer
  if (
    answer.digest !== canonicalJsonDigest(value) ||
    answer.bytes !== new TextEncoder().encode(jcs(value)).length
  )
    return 'answer content evidence mismatch'
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'answer must be an object'
  const fields = new Map(question.fields.map((field) => [field.id, field]))
  for (const key of Object.keys(value)) if (!fields.has(key)) return `unknown answer field ${key}`
  for (const field of question.fields) {
    const given = (value as Record<string, Wire.JsonValue>)[field.id]
    if (given === undefined) {
      if (field.required) return `missing required field ${field.id}`
      continue
    }
    const options = 'options' in field ? new Set(field.options.map((option) => option.id)) : undefined
    switch (field.kind) {
      case 'text':
        if (typeof given !== 'string' || given.length > field.maxLength) return `invalid text for ${field.id}`
        if (!field.multiline && /[\r\n]/.test(given)) return `single-line field ${field.id} has a line break`
        break
      case 'singleChoice':
        if (typeof given !== 'string' || !options?.has(given)) return `unknown option for ${field.id}`
        break
      case 'multiChoice':
        if (
          !Array.isArray(given) ||
          new Set(given).size !== given.length ||
          given.length < field.minItems ||
          given.length > field.maxItems ||
          !given.every((item) => typeof item === 'string' && options?.has(item))
        )
          return `invalid selection for ${field.id}`
        break
      case 'confirm':
        if (typeof given !== 'boolean') return `confirm field ${field.id} needs a boolean`
        break
      // ponytail: custom fields need the author schema codec; refused until the provider wires one in.
      case 'custom':
        return `custom field ${field.id} needs its schema decoder`
    }
  }
  return undefined
}

/** Builds the stored answer for one method, or the reason it is refused. */
function answerFor(
  method: InteractionResponseMethod,
  request: Wire.InteractionRequest,
  input: Record<string, unknown>,
): Outcome<Wire.DataRef> {
  if (method === 'respondApproval') {
    if (request.kind !== 'approval') return fail('invalid_request', 'question cannot take an approval answer')
    const answer =
      input.decision === 'approve'
        ? { decision: 'approve', intentDigest: input.intentDigest, grantScope: input.grantScope ?? 'once' }
        : { decision: 'deny', intentDigest: input.intentDigest }
    const valid = validateApprovalAnswerForRequest(request, answer)
    if (!valid.ok) return fail('invalid_request', valid.errors[0]?.message ?? 'invalid approval answer')
    return { ok: true, value: inline(RuntimeSchemaRefs.ApprovalAnswer, valid.value) }
  }
  const answer = input.answer as Wire.DataRef
  if (request.kind === 'approval') {
    const valid = validateInlineApprovalAnswerReference(request, answer)
    return valid.ok
      ? valid
      : fail('invalid_request', valid.errors[0]?.message ?? 'approval needs the platform answer')
  }
  if (jcs(answer.schema) !== jcs(request.answerSchema))
    return fail('invalid_request', 'answer schema does not match the question')
  if (answer.kind !== 'inline') return fail('unsupported', 'blob answers need the schema owner decoder')
  const error = questionAnswerError(request, answer)
  return error === undefined ? { ok: true, value: answer } : fail('invalid_request', error)
}

/**
 * The interaction service domain rules over any atomic store: a pending question, one accepted answer per
 * interaction version, and a wake per terminal change. Reading permission stays with the provider.
 */
export function createInteractionAuthority(storage: InteractionStorage, clock: InteractionClock) {
  const wake = (record: Wire.InteractionRecord, now: Wire.Timestamp): StoredInteractionWake => ({
    wake: {
      deliveryKey: `${record.interactionId}@${record.version}`,
      interactionId: record.interactionId,
      owner: record.owner,
      version: record.version,
      status: record.status,
      responseId: record.status === 'answered' ? record.resolution.responseId : null,
    },
    delivery: 'pending',
    consecutiveFailures: 0,
    nextAttemptAt: now,
    lastError: null,
    ackRef: null,
  })

  return {
    async request(input: {
      request: unknown
      owner: InteractionOwner
    }): Promise<Outcome<Wire.InteractionRecord>> {
      const parsed = validateRuntime('InteractionRequest', input.request)
      if (!parsed.ok) return fail('invalid_request', 'interaction request does not match its schema')
      const request = parsed.value
      if (request.kind === 'approval' && !validateApprovalIntent(request).ok)
        return fail('invalid_request', 'approval intent digest does not match the question')
      if (
        request.kind === 'question' &&
        new Set(request.fields.map((f) => f.id)).size !== request.fields.length
      )
        return fail('invalid_request', 'question field ids repeat')
      const now = clock.now()
      return storage.transaction((tx) => {
        const prior = tx.recordByIdempotencyKey(request.idempotencyKey)
        if (prior)
          return jcs(prior.request) === jcs(request) && jcs(prior.owner) === jcs(input.owner)
            ? { ok: true as const, value: prior }
            : fail('idempotency_conflict', 'idempotency key already names another interaction')
        if (isDue(now, request.expiresAt))
          return fail('invalid_request', 'interaction expires before it opens')
        const record = checked({
          interactionId: clock.newId(),
          owner: input.owner,
          request,
          version: 1,
          createdAt: now,
          updatedAt: now,
          status: 'pending',
          terminationReason: null,
          resolution: null,
        })
        if (record.ok) tx.putRecord(record.value)
        return record
      })
    },

    async respond(input: InteractionResponseInput): Promise<Outcome<Wire.InteractionResponseStatus>> {
      const parsed = validateRuntime(requestSchema[input.method], input.request)
      if (!parsed.ok) return fail('invalid_request', 'response does not match its schema')
      const { interactionId, responseId, expectedVersion } = parsed.value
      return storage.transaction((tx) => {
        const record = tx.record(interactionId)
        if (!record) return fail('not_found', 'no such interaction')
        const answer = answerFor(input.method, record.request, parsed.value as Record<string, unknown>)
        if (!answer.ok) return answer
        const fingerprint = canonicalJsonDigest({
          method: input.method,
          interactionId,
          expectedVersion,
          actorRef: input.actorRef,
          answer: answer.value,
        })
        const prior = tx.response(responseId)
        if (prior)
          return prior.fingerprint === fingerprint
            ? { ok: true as const, value: prior.status }
            : fail('idempotency_conflict', 'response id already carries another answer')
        if (record.status !== 'pending' || record.version !== expectedVersion)
          return fail('revision_conflict', 'interaction is no longer at the expected version')
        const now = clock.now()
        if (isDue(now, record.request.expiresAt)) return fail('blocked', 'interaction has expired')
        if (!record.request.allowedResponders.includes(input.actorRef))
          return fail('permission_denied', 'actor may not answer this interaction')
        const answered = checked({
          ...record,
          version: record.version + 1,
          updatedAt: now,
          status: 'answered',
          terminationReason: null,
          resolution: {
            responseId,
            actorRef: input.actorRef,
            answer: answer.value,
            committedAt: now,
            evidence: input.evidence,
          },
        })
        if (!answered.ok) return answered
        const status: Wire.InteractionResponseStatus = {
          interactionId,
          responseId,
          status: 'accepted',
          version: answered.value.version,
          result: answered.value,
          error: null,
        }
        tx.putRecord(answered.value)
        tx.putResponse({ responseId, fingerprint, status })
        tx.putWake(wake(answered.value, now))
        return { ok: true as const, value: status }
      })
    },

    async terminate(method: 'expire' | 'cancel', request: unknown): Promise<Outcome<Wire.InteractionRecord>> {
      const parsed = validateRuntime(
        method === 'expire' ? 'InteractionExpireRequest' : 'InteractionCancelRequest',
        request,
      )
      if (!parsed.ok) return fail('invalid_request', `${method} request does not match its schema`)
      const { interactionId, expectedVersion, reason } = parsed.value
      const status = method === 'expire' ? 'expired' : 'cancelled'
      return storage.transaction((tx) => {
        const record = tx.record(interactionId)
        if (!record) return fail('not_found', 'no such interaction')
        if (
          record.status === status &&
          record.version === expectedVersion + 1 &&
          record.terminationReason === reason
        )
          return { ok: true as const, value: record }
        if (record.status !== 'pending' || record.version !== expectedVersion)
          return fail('revision_conflict', 'interaction is no longer at the expected version')
        const now = clock.now()
        if (method === 'expire' && !isDue(now, record.request.expiresAt))
          return fail('blocked', 'interaction is not due to expire')
        const next = checked({
          ...record,
          version: record.version + 1,
          updatedAt: now,
          status,
          terminationReason: reason,
          resolution: null,
        })
        if (!next.ok) return next
        tx.putRecord(next.value)
        tx.putWake(wake(next.value, now))
        return next
      })
    },

    async read(interactionId: Wire.Id): Promise<Outcome<Wire.InteractionRecord>> {
      return storage.transaction((tx) => {
        const record = tx.record(interactionId)
        return record ? { ok: true as const, value: record } : fail('not_found', 'no such interaction')
      })
    },

    /** Absence is authoritative here: this store is the only place a response can be accepted. */
    async responseStatus(responseId: Wire.Id): Promise<Outcome<Wire.InteractionResponseStatus>> {
      return storage.transaction((tx) => ({
        ok: true as const,
        value: tx.response(responseId)?.status ?? {
          responseId,
          status: 'not-accepted' as const,
          interactionId: null,
          version: null,
          result: null,
          error: null,
        },
      }))
    },
  }
}

export type InteractionAuthority = ReturnType<typeof createInteractionAuthority>
