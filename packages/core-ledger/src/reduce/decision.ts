import { acceptedOptions } from '@agnes/core-common/command-table/prefix'
import { canonicalJson, sha256Hex } from '@agnes/core-common/request/hash'
import { CoreError, type Event } from '@agnes/core-common/types'
import {
  automaticPermissionDecision,
  type DecisionSnapshot,
  inspectJsonData,
  validateAgainst,
} from '@agnes/protocol'
import { DecisionSnapshot as SnapshotSchema } from '@agnes/protocol/gen/session-v1'

function fail(message: string): never {
  throw new CoreError('E_RELATION', `decision/state: ${message}`)
}
export const decisionSubjectDigest = (subject: unknown): string => sha256Hex(canonicalJson(subject))

/** Full snapshots keep one register truth; malformed immutable/revision history refuses reconstruction. */
export function reduceDecision(previous: DecisionSnapshot | undefined, event: Event): DecisionSnapshot {
  const json = inspectJsonData(event.data, 262144)
  if (!json.ok || !validateAgainst<DecisionSnapshot>(SnapshotSchema, json.value).ok) fail('invalid snapshot')
  const next = json.value as DecisionSnapshot
  if (
    event.origin !== 'system' ||
    event.trust !== 'trusted' ||
    event.register !== 'decision/state' ||
    next.request.lane !== (event.lane ?? 'main')
  )
    fail('untrusted owner')
  if (
    next.request.expiresAt !== null &&
    Date.parse(next.request.expiresAt) <= Date.parse(next.request.createdAt)
  )
    fail('invalid deadline')
  if (decisionSubjectDigest(next.request.spec.subject) !== next.request.subjectDigest) fail('subject digest')
  const automatic = next.result?.reason === 'answered' && next.result.code === 'full-access'
  const business =
    automatic && next.result?.reason === 'answered' && next.request.spec.purpose === 'business.confirm'
      ? automaticPermissionDecision(
          { policy: 'full-access', actor: next.result.answeredBy },
          next.request.spec.purpose,
          next.request.spec.options,
          'question',
          next.request.spec.presentation,
        )
      : undefined
  if (
    automatic &&
    (next.result?.reason !== 'answered' ||
      next.result.response.option !== 'allowed-once' ||
      (next.request.spec.purpose === 'business.confirm'
        ? !business ||
          next.result.response.value !== business.responseValue ||
          !next.result.authorization ||
          next.result.answeredBy.attrs.confirmationMode !== 'auto-confirmed under full access'
        : next.result.answeredBy.role !== 'system') ||
      next.result.answeredBy.attrs.permissionPolicy !== 'full-access' ||
      next.answerCommand !== null)
  )
    fail('invalid automatic permission')
  if (!previous) {
    if (
      next.revision !== 1 ||
      (next.result !== null && !automatic) ||
      next.consumption !== null ||
      next.answerCommand !== null ||
      next.invalidation !== null
    )
      fail('invalid initial state')
  } else {
    if (
      next.revision !== previous.revision + 1 ||
      canonicalJson(next.handle) !== canonicalJson(previous.handle) ||
      canonicalJson(next.request) !== canonicalJson(previous.request)
    )
      fail('immutable request or revision changed')
    // "Allow for this session" outlives the call that consumed it. Withdrawing that allowance is the
    // one write a consumed decision accepts; its answer and its consumption stay exactly as they were.
    const revokesGrant =
      previous.consumption !== null &&
      previous.invalidation === null &&
      previous.result?.reason === 'answered' &&
      (previous.result.response.option === 'allowed-session' ||
        previous.result.response.option === 'allow_prefix_session') &&
      next.invalidation?.code === 'grant-revoked' &&
      canonicalJson(next.consumption) === canonicalJson(previous.consumption)
    if (
      !revokesGrant &&
      (previous.consumption !== null ||
        previous.invalidation !== null ||
        (previous.result !== null && previous.result.reason !== 'answered'))
    )
      fail('terminal state')
    if (
      previous.result !== null &&
      (canonicalJson(next.result) !== canonicalJson(previous.result) ||
        canonicalJson(next.answerCommand) !== canonicalJson(previous.answerCommand))
    )
      fail('answer changed')
    const changed = [
      next.result !== previous.result && canonicalJson(next.result) !== canonicalJson(previous.result),
      next.consumption !== null,
      next.invalidation !== null,
    ].filter(Boolean).length
    if (changed !== (revokesGrant ? 2 : 1)) fail('one transition required')
  }
  if (next.result?.reason === 'answered') {
    if (Date.parse(next.result.at) < Date.parse(next.request.createdAt)) fail('answer before request')
    if (
      !automatic &&
      !previous?.result &&
      (next.answerCommand?.revision !== next.revision || next.answerCommand.seq !== event.seq)
    )
      fail('answer receipt mismatch')
    if (
      !acceptedOptions(next.request.spec).includes(next.result.response.option) ||
      (!automatic && next.answerCommand === null)
    )
      fail('unoffered answer')
    if (next.request.expiresAt !== null && Date.parse(next.result.at) >= Date.parse(next.request.expiresAt))
      fail('late answer')
  } else if (next.answerCommand !== null) fail('receipt without human answer')
  if (next.invalidation !== null && next.result?.reason !== 'answered')
    fail('invalidation without original answer')
  if (next.consumption !== null) {
    if (next.result?.reason !== 'answered' || next.consumption.operationId !== next.request.operationId)
      fail('consumption without result or original operation')
    if (Date.parse(next.consumption.at) < Date.parse(next.result.at)) fail('consumption before answer')
    if (
      next.result.reason === 'answered' &&
      next.request.expiresAt !== null &&
      Date.parse(next.consumption.at) >= Date.parse(next.request.expiresAt)
    )
      fail('expired consumption')
  }
  return next
}
