import { RuntimeApprovalIntentPolicy } from '../../gen/ts/runtime-catalog.js'
import { RuntimeSchemaRefs } from '../../gen/ts/runtime-schema-refs.js'
import { jcs } from '../jcs.js'
import { canonicalJsonDigest } from './jcs-digest.js'
import type {
  ApprovalAnswer,
  ApprovalAnswerDataRef,
  ApprovalRequest,
  Digest,
  DomainCommandClientSubmitRequest,
  EventsPublishRequest,
  JsonValue,
  OutboxDeadLetterItem,
  ProjectionChanges,
  ValidationResult,
} from './public.js'
import { validateRuntime } from './public.js'

const refuse = <T>(message: string): ValidationResult<T> => ({
  ok: false,
  errors: [{ path: '', code: 'OTHER', message }],
})

function utf8Order(left: string, right: string): number {
  const encoder = new TextEncoder()
  const a = encoder.encode(left)
  const b = encoder.encode(right)
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference) return difference
  }
  return a.length - b.length
}

/** Computes the fixed intent binding; this neither authenticates a response nor grants permission. */
export function computeApprovalIntentDigest(value: unknown): ValidationResult<Digest> {
  const parsed = validateRuntime('ApprovalRequest', value)
  if (!parsed.ok) return parsed
  const request = parsed.value
  const document: Record<string, JsonValue> = {}
  for (const field of RuntimeApprovalIntentPolicy.fields) {
    if (field === 'allowedResponders') document[field] = [...new Set(request[field])].sort(utf8Order)
    else if (field === 'allowedGrantScopes')
      document[field] = [
        ...new Set(request[field] ?? RuntimeApprovalIntentPolicy.defaultAllowedGrantScopes),
      ].sort(utf8Order)
    else document[field] = request[field]
  }
  return { ok: true, value: canonicalJsonDigest(document) }
}

export function validateApprovalIntent(value: unknown): ValidationResult<ApprovalRequest> {
  const parsed = validateRuntime('ApprovalRequest', value)
  if (!parsed.ok) return parsed
  const computed = computeApprovalIntentDigest(parsed.value)
  if (!computed.ok) return computed
  return computed.value === parsed.value.intentDigest ? parsed : refuse('approval intent digest mismatch')
}

/** Checks the platform answer against the immutable question; current actor authorization is separate. */
export function validateApprovalAnswerForRequest(
  request: unknown,
  answer: unknown,
): ValidationResult<ApprovalAnswer> {
  const question = validateApprovalIntent(request)
  if (!question.ok) return question
  const parsed = validateRuntime('ApprovalAnswer', answer)
  if (!parsed.ok) return parsed
  if (parsed.value.intentDigest !== question.value.intentDigest)
    return refuse('approval answer belongs to another intent')
  const allowed: readonly string[] =
    question.value.allowedGrantScopes ?? RuntimeApprovalIntentPolicy.defaultAllowedGrantScopes
  if (parsed.value.decision === 'approve' && !allowed.includes(parsed.value.grantScope))
    return refuse('approval grant scope was not offered')
  return parsed
}

/** Checks inline codec identity and content; Blob answers require the authorized owner's decoder. */
export function validateInlineApprovalAnswerReference(
  request: unknown,
  value: unknown,
): ValidationResult<Extract<ApprovalAnswerDataRef, { kind: 'inline' }>> {
  const parsed = validateRuntime('ApprovalAnswerDataRef', value)
  if (!parsed.ok) return parsed
  const data = parsed.value
  if (jcs(data.schema) !== jcs(RuntimeSchemaRefs.ApprovalAnswer))
    return refuse('approval answer codec identity mismatch')
  if (data.kind !== 'inline') return refuse('approval Blob answer requires an authorized decoder')
  const answer = validateApprovalAnswerForRequest(request, data.value)
  if (!answer.ok) return answer
  if (
    data.digest !== canonicalJsonDigest(data.value) ||
    data.bytes !== new TextEncoder().encode(jcs(data.value)).length
  )
    return refuse('approval answer content evidence mismatch')
  return { ok: true, value: data }
}

/** Enforces the reset batch relationship; cursor authorization and continuity remain owner checks. */
export function validateProjectionChanges(value: unknown): ValidationResult<ProjectionChanges> {
  const parsed = validateRuntime('ProjectionChanges', value)
  if (!parsed.ok) return parsed
  const resets = parsed.value.changes.filter((change) => change.kind === 'reset')
  if (
    resets.length &&
    (parsed.value.changes.length !== 1 ||
      parsed.value.hasMore ||
      parsed.value.cursor !== resets[0]?.snapshot.cursor)
  )
    return refuse('projection reset does not describe one snapshot boundary')
  return parsed
}

/** Verifies schema identity only; supplied view/registry references must come from an authorized owner. */
export function validateDomainCommandSchemas(
  value: unknown,
  viewSchema: unknown,
  registeredSchema: unknown,
): ValidationResult<DomainCommandClientSubmitRequest> {
  const request = validateRuntime('DomainCommandClientSubmitRequest', value)
  if (!request.ok) return request
  const view = validateRuntime('SchemaRef', viewSchema)
  if (!view.ok) return view
  const registered = validateRuntime('SchemaRef', registeredSchema)
  if (!registered.ok) return registered
  const expected = jcs(request.value.commandSchema)
  if (
    expected !== jcs(request.value.input.schema) ||
    expected !== jcs(view.value) ||
    expected !== jcs(registered.value)
  )
    return refuse('command schema identity mismatch')
  return request
}

export function validateEventsPublishSchemas(value: unknown): ValidationResult<EventsPublishRequest> {
  const parsed = validateRuntime('EventsPublishRequest', value)
  if (!parsed.ok) return parsed
  if (
    parsed.value.typeId !== parsed.value.domainSchema.typeId ||
    jcs(parsed.value.domainSchema) !== jcs(parsed.value.payload.schema)
  )
    return refuse('published event type and payload schema disagree')
  return parsed
}

export function validateOutboxDeadLetter(value: unknown): ValidationResult<OutboxDeadLetterItem> {
  const parsed = validateRuntime('OutboxDeadLetterItem', value)
  if (!parsed.ok) return parsed
  const { delivery, outbox } = parsed.value
  if (
    outbox.delivery !== 'dead' ||
    parsed.value.owner.authority.authorityId !== outbox.sourceAuthorityId ||
    delivery.sourceAuthorityId !== outbox.sourceAuthorityId ||
    delivery.eventId !== outbox.eventId ||
    delivery.destination !== outbox.destination
  )
    return refuse('dead letter does not match the original delivery key')
  return parsed
}
