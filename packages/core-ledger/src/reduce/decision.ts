import { sha256Hex } from '@agnes/core-common/request/hash'
import { CoreError, type Event } from '@agnes/core-common/types'
import { compileDecisionSchema, inspectJsonData, jcs, validateEvent } from '@agnes/protocol'
import type { DecisionConsumed, DecisionInvalidated, DecisionRequestRecord, DecisionRequested,
  DecisionResolved, DecisionSnapshot } from '@agnes/protocol/gen/session-v1'

export type DecisionStoredCommand = { readonly digest: string; readonly seq: number; readonly revision: number;
  readonly outcome: 'answered' | 'expired' | 'unavailable' | 'stopped' | 'invalidated' | 'consumed' }
export type DecisionState = DecisionSnapshot & { readonly dedupeDigest: string;
  readonly commands: Readonly<Record<string, DecisionStoredCommand>> }
export const decisionDigest = (value: unknown): string => sha256Hex(jcs(value))
export function decisionDedupeKey(r: DecisionRequestRecord): string {
  return jcs([r.profileId, r.aggregate, r.source.owner, r.source.operationId, r.source.sourceKey])
}
export function decisionSpecDigest(r: DecisionRequestRecord): string {
  const { id: _id, requestRevision: _rev, createdAt: _at, expiresAt: _expires, ...spec } = r
  return decisionDigest(spec)
}
function requireRelation(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CoreError('E_RELATION', `decision: ${message}`)
}
export function validateDecisionRequest(r: DecisionRequestRecord): void {
  requireRelation(inspectJsonData(r, 262144).ok && inspectJsonData(r.continuation.data, 65536).ok, 'unbounded request')
  requireRelation(new Set(r.subject.refs.map(ref => jcs([ref.type, ref.id]))).size === r.subject.refs.length, 'duplicate subject refs')
  requireRelation(new Set(r.actions.map(a => a.id)).size === r.actions.length, 'duplicate actions')
  requireRelation(r.actions.every(a => r.authority.maxScopes.includes(a.scope)), 'action exceeds authority')
  requireRelation(r.authority.separation !== 'different-human-author' || r.authority.humanAuthor?.category === 'human', 'missing human author')
  requireRelation(r.aggregate.type === 'session' ? r.source.lane !== null : r.source.lane === null && r.source.stepId === null, 'source lane')
  requireRelation(r.continuation.digest === decisionDigest({target:r.continuation.target,codecId:r.continuation.codecId,
    codecVersion:r.continuation.codecVersion,codePin:r.continuation.codePin,data:r.continuation.data}), 'continuation digest')
  const expiry = r.lifecycle.expireAfter === null ? null : new Date(Date.parse(r.createdAt) + r.lifecycle.expireAfter).toISOString()
  requireRelation(r.expiresAt === expiry, 'deadline does not match lifecycle')
  compileDecisionSchema(r.responseSchema)
  for (const action of r.actions) compileDecisionSchema(action.valueSchema)
}
export function validateDecisionResponse(r: DecisionRequestRecord, answer: {actionId:string;scope:string;value:unknown}): void {
  const action = r.actions.find(a => a.id === answer.actionId)
  requireRelation(action && action.scope === answer.scope && r.authority.maxScopes.includes(action.scope), 'response was not offered')
  requireRelation(compileDecisionSchema(action.valueSchema)(answer.value) && compileDecisionSchema(r.responseSchema)(answer.value), 'response schema')
}
const codes = {
  expired: ['deadline'], unavailable: ['no-eligible-surface','unsupported-surface','no-eligible-reviewer'],
  stopped: ['operation-stop','explicit-cancel'], invalidated: ['subject-changed','policy-changed','authority-revoked','explicit-invalidation'],
} as const

/** Pure canonical fold. A checksum-valid relationship error stops reconstruction. */
export function reduceDecision(previous: DecisionState | undefined, event: Event): DecisionState {
  const checked = validateEvent(event)
  requireRelation(checked.ok && event.origin === 'system' && event.trust === 'trusted', 'invalid authoritative event')
  if (event.type === 'decision/requested') {
    const d = event.data as DecisionRequested
    requireRelation(!previous && d.decisionId === d.request.id, 'duplicate request or mismatched id')
    validateDecisionRequest(d.request)
    requireRelation(d.request.aggregate.type !== 'session' || d.request.source.lane === (event.lane ?? 'main'), 'request lane')
    return { handle:{id:d.decisionId,aggregate:d.request.aggregate,revision:1,requestedSeq:event.seq,subjectDigest:d.request.subject.digest},
      request:structuredClone(d.request), result:null,resultRevision:null,
      execution:{status:'waiting',code:null,consumedSeq:null,operationReceiptId:null},
      dedupeDigest:decisionSpecDigest(d.request),commands:{} }
  }
  requireRelation(previous, 'mutation without request')
  const d = event.data as DecisionResolved | DecisionInvalidated | DecisionConsumed
  requireRelation(d.decisionId === previous.handle.id && d.previousRevision === previous.handle.revision &&
    d.revision === d.previousRevision + 1 && d.requestRevision === 1 && d.subjectDigest === previous.handle.subjectDigest, 'revision or subject mismatch')
  requireRelation(previous.request.source.lane === (event.lane ?? 'main'), 'mutation lane')
  requireRelation(!Object.hasOwn(previous.commands,d.commandId), 'duplicate command event')
  requireRelation(previous.execution.consumedSeq === null && previous.execution.status !== 'blocked', 'terminal mutation')
  let result = previous.result, resultRevision = previous.resultRevision, execution = previous.execution
  let outcome: DecisionStoredCommand['outcome']
  if (event.type === 'decision/resolved') {
    const resolved = d as DecisionResolved
    requireRelation(result === null, 'second resolution')
    result = resolved.result; resultRevision = d.revision; outcome = result.reason
    if (result.reason === 'answered') {
      requireRelation(result.answeredBy.principal.category === 'human', 'non-human answer')
      requireRelation(result.answeredBy.principal.source.kind !== 'channel' || result.answeredBy.sourceEventRef !== null, 'unattested channel')
      validateDecisionResponse(previous.request,{actionId:result.actionId,scope:result.scope,value:result.response})
      requireRelation(previous.request.expiresAt === null || Date.parse(result.at) < Date.parse(previous.request.expiresAt), 'late answer')
    } else requireRelation((codes[result.reason] as readonly string[]).includes(result.code), 'invalid terminal code')
    execution = {...execution,status:'ready'}
  } else if (event.type === 'decision/invalidated') {
    const invalidated = d as DecisionInvalidated
    requireRelation(result !== null || !['operation-stopped','validity-expired'].includes(invalidated.cause), 'pending stop/expiry must resolve')
    requireRelation(invalidated.changedRefs.length > 0 || ['operation-stopped','validity-expired','authority-revoked','explicit-invalidation'].includes(invalidated.cause), 'missing changed refs')
    if (result === null) { result={reason:'invalidated',at:invalidated.at,code:invalidated.cause,causedBy:invalidated.causedBy};resultRevision=d.revision }
    execution={...execution,status:'blocked',code:invalidated.cause === 'validity-expired' ? 'decision-expired' : invalidated.cause}
    outcome='invalidated'
  } else {
    requireRelation(event.type === 'decision/consumed', 'unknown decision event')
    const consumed = d as DecisionConsumed
    requireRelation(result !== null && resultRevision === consumed.resultRevision && consumed.operationId === previous.request.source.operationId &&
      consumed.continuationDigest === previous.request.continuation.digest,'invalid consumption binding')
    if (consumed.disposition === 'refuse') requireRelation(consumed.refusalCode !== null && consumed.effectId === null && consumed.grantLinks.length === 0,'invalid refusal')
    else {
      requireRelation(result.reason === 'answered' && consumed.refusalCode === null,'positive consumption without answer')
      requireRelation(previous.request.expiresAt === null || Date.parse(consumed.at) < Date.parse(previous.request.expiresAt),'expired consumption')
      if (consumed.disposition === 'execute') {
        const action=previous.request.actions.find(a=>a.id===result?.actionId)
        requireRelation(action?.intent === 'approve' && consumed.effectId !== null,'execute without approval intent')
      } else requireRelation(consumed.effectId === null && consumed.grantLinks.length === 0,'checkpoint consumption cannot issue grants')
    }
    // Grant issuance and effect dispatch are implemented by their owning later slices.
    requireRelation(consumed.grantLinks.length === 0,'DECISION_CONTINUATION_BLOCKED: grant consumption unavailable')
    execution={...execution,status:'consumed',consumedSeq:event.seq};outcome='consumed'
  }
  return {...previous,handle:{...previous.handle,revision:d.revision},result:structuredClone(result),resultRevision,execution,
    commands:{...previous.commands,[d.commandId]:{digest:d.commandDigest,seq:event.seq,revision:d.revision,outcome}}}
}
