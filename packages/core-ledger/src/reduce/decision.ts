import { canonicalJson, sha256Hex } from '@agnes/core-common/request/hash'
import { CoreError, type Event } from '@agnes/core-common/types'
import {
  type DecisionSnapshot,
  inspectJsonData,
  DecisionSnapshot as SnapshotSchema,
  validateAgainst,
} from '@agnes/protocol'

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
  if (!previous) {
    if (
      next.revision !== 1 ||
      next.result !== null ||
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
    if (
      previous.consumption !== null ||
      previous.invalidation !== null ||
      (previous.result !== null && previous.result.reason !== 'answered')
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
    if (changed !== 1) fail('one transition required')
  }
  if (next.result?.reason === 'answered') {
    if (Date.parse(next.result.at) < Date.parse(next.request.createdAt)) fail('answer before request')
    if (
      !previous?.result &&
      (next.answerCommand?.revision !== next.revision || next.answerCommand.seq !== event.seq)
    )
      fail('answer receipt mismatch')
    if (!next.request.spec.options.includes(next.result.response.option) || next.answerCommand === null)
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
