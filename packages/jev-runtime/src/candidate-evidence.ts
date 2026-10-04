/** Exact candidate field receipts and decision-only resource classification. */

import type { Candidate, CandidateEvidence, JsonValue, RecordId, RuntimeRecord } from './types.js'

const DECISION_ONLY_KINDS = new Set([
  'candidate.enrichment.error',
  'candidate.validation.error',
  'candidate.offer.summary',
  'jev.candidate.policy.v1',
  'jev.candidate.route.v1',
  'jev.candidate.evidence.error.v1',
  'jev.native-candidate-recipes.v1',
  'jev.decision.manifest.v1',
  'jev.decision.route.v1',
  'jev.response-review.v1',
])

/**
 * Check whether a resource is reserved for candidate planning rather than host evidence.
 * @param resource - recorded resource value.
 * @returns true only for the explicit reserved kinds.
 */
export function isCandidateDiagnostic(resource: JsonValue): boolean {
  return (
    resource !== null &&
    typeof resource === 'object' &&
    !Array.isArray(resource) &&
    typeof resource.kind === 'string' &&
    DECISION_ONLY_KINDS.has(resource.kind)
  )
}

function tokens(pointer: string): readonly string[] | undefined {
  if (pointer === '') return []
  if (!pointer.startsWith('/')) return undefined
  const parts = pointer.slice(1).split('/')
  if (parts.some((part) => /~(?![01])/.test(part))) return undefined
  return parts.map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
}

function atPointer(value: RuntimeRecord, pointer: string): unknown {
  const parts = tokens(pointer)
  if (parts === undefined) return undefined
  let current: unknown = value
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(part)) return undefined
      current = current[Number(part)]
    } else {
      if (!Object.hasOwn(current, part)) return undefined
      current = Reflect.get(current, part)
    }
  }
  return current
}

function sameJson(left: unknown, right: JsonValue): boolean {
  if (left === right) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => right[index] !== undefined && sameJson(item, right[index]))
    )
  }
  const keys = Object.keys(left)
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => {
      const leftValue: unknown = Reflect.get(left, key)
      const rightValue = right[key]
      return Object.hasOwn(right, key) && rightValue !== undefined && sameJson(leftValue, rightValue)
    })
  )
}

function evidenceField(source: RuntimeRecord, pointer: string): boolean {
  switch (source.kind) {
    case 'action.settled':
      return (
        /^\/observations\/(0|[1-9]\d*)\/(data|coverage|references)(\/|$)/.test(pointer) ||
        /^\/outcome\/(value|content|meta)(\/|$)/.test(pointer)
      )
    case 'input.admitted':
      return false
    case 'resource.observed':
      return pointer.startsWith('/resource/')
    case 'environment.observed':
      return /^\/(facts|catalog)(\/|$)/.test(pointer)
    default:
      return false
  }
}

/**
 * Check a field receipt against the recorded fact and current source eligibility.
 * @param evidence - model-visible field receipt.
 * @param source - recorded fact named by the receipt.
 * @param currentEnvironmentId - latest catalog and facts record.
 * @param currentRecipeId - latest host candidate recipe record, if any.
 * @param factSourceIds - identities in the restricted candidate fact projection.
 * @returns true only for an exact eligible field value.
 */
export function validCandidateEvidence(
  evidence: CandidateEvidence,
  source: RuntimeRecord,
  currentEnvironmentId: RecordId,
  currentRecipeId: RecordId | undefined,
  factSourceIds: ReadonlySet<RecordId>,
): boolean {
  if (source.id !== evidence.sourceRecordId) return false
  if (!factSourceIds.has(source.id)) return false
  if (!evidenceField(source, evidence.pointer)) return false
  if (source.kind === 'environment.observed' && source.id !== currentEnvironmentId) return false
  if (
    source.kind === 'resource.observed' &&
    isCandidateDiagnostic(source.resource) &&
    !(
      source.id === currentRecipeId &&
      source.resource !== null &&
      typeof source.resource === 'object' &&
      !Array.isArray(source.resource) &&
      source.resource.kind === 'jev.native-candidate-recipes.v1'
    )
  )
    return false
  const actual = atPointer(source, evidence.pointer)
  return actual !== undefined && sameJson(actual, evidence.value)
}

/**
 * Require each source to be fully displayed or represented by an exact field receipt.
 * @param candidate - complete binding offered for a decision.
 * @param completeSources - source IDs displayed without clipping.
 * @returns true when every source can be inspected in the request.
 */
export function candidateSourcesVisible(
  candidate: Candidate,
  completeSources: ReadonlySet<RecordId>,
): boolean {
  return candidate.sourceRecordIds.every(
    (source) =>
      completeSources.has(source) ||
      candidate.evidence?.some((field) => field.sourceRecordId === source) === true,
  )
}
