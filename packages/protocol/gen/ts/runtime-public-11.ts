import type { Page } from './runtime-public.js'
// generated from schema by tools/gen.ts — do not edit
import { Type, type Static } from '@sinclair/typebox'
import { FormatRegistry } from '@sinclair/typebox'

if (!FormatRegistry.Has('date-time')) FormatRegistry.Set('date-time', (value) => { const parts = value.split(/t/i); if (parts.length !== 2) return false; const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(parts[0] ?? ''); const time = /^(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)(z|([+-])(\d{2}):(\d{2}))$/i.exec(parts[1] ?? ''); if (!date || !time) return false; const year = Number(date[1]), month = Number(date[2]), day = Number(date[3]); const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0); const days = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; if (month < 1 || month > 12 || day < 1 || day > (days[month] ?? 0)) return false; const hour = Number(time[1]), minute = Number(time[2]), second = Number(time[3]); const offsetHour = Number(time[6] || 0), offsetMinute = Number(time[7] || 0); if (hour > 23 || minute > 59 || offsetHour > 23 || offsetMinute > 59) return false; if (second < 60) return true; const sign = time[5] === '-' ? -1 : 1; const utcMinute = minute - offsetMinute * sign; const utcHour = hour - offsetHour * sign - (utcMinute < 0 ? 1 : 0); return (utcHour === 23 || utcHour === -1) && (utcMinute === 59 || utcMinute === -1) && second < 61; })

export const JsonValue = Type.Recursive((This) => Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String(), Type.Array(This, { minItems: 0, maxItems: 10000 }), Type.Record(Type.String(), This)]))
export type JsonValue = Static<typeof JsonValue>

export const RuntimePublic11 = Type.Module({
  "Id": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }),
  "UInt53": Type.Integer({ minimum: 0, maximum: 9007199254740991 }),
  "Timestamp": Type.String({ pattern: "Z$", format: "date-time" }),
  "OutboxClaim": Type.Object({ "eventId": Type.Ref('Id'), "ownerId": Type.Ref('Id'), "epoch": Type.Ref('UInt53'), "until": Type.Ref('Timestamp') }, { additionalProperties: false }),
  "TypeId": Type.String({ minLength: 1, maxLength: 256, pattern: "^(?:[a-z][a-z0-9.-]*|@[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*)/[a-zA-Z0-9._/-]+@[1-9][0-9]*$" }),
  "Digest": Type.String({ pattern: "^[a-f0-9]{64}$" }),
  "SchemaRef": Type.Object({ "typeId": Type.Ref('TypeId'), "revision": Type.Ref('UInt53'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "BlobRef": Type.Object({ "authorityId": Type.Ref('Id'), "blobId": Type.Ref('Id'), "digest": Type.Ref('Digest'), "bytes": Type.Ref('UInt53'), "mediaType": Type.String(), "pinId": Type.Ref('Id') }, { additionalProperties: false }),
  "DataRef": Type.Union([Type.Object({ "kind": Type.Literal('inline'), "schema": Type.Ref('SchemaRef'), "value": JsonValue, "digest": Type.Ref('Digest'), "bytes": Type.Ref('UInt53') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('blob'), "schema": Type.Ref('SchemaRef'), "blob": Type.Ref('BlobRef') }, { additionalProperties: false })]),
  "ActionRef": Type.Union([Type.Object({ "existingActionId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "localKey": Type.String() }, { additionalProperties: false })]),
  "ActionDependency": Type.Object({ "action": Type.Ref('ActionRef'), "onDependencyFailure": Type.Union([Type.Literal('cancel'), Type.Literal('run_with_receipt')]) }, { additionalProperties: false }),
  "RuntimeErrorCode": Type.Union([Type.Literal('invalid_input'), Type.Literal('denied'), Type.Literal('incompatible'), Type.Literal('quota'), Type.Literal('cancelled'), Type.Literal('timeout'), Type.Literal('retryable'), Type.Literal('unknown_effect'), Type.Literal('conflict'), Type.Literal('internal')]),
  "OwnerRef": Type.Object({ "kind": Type.Union([Type.Literal('run'), Type.Literal('action'), Type.Literal('job'), Type.Literal('reconciliation')]), "id": Type.Ref('Id') }, { additionalProperties: false }),
  "RetryAdvice": Type.Union([Type.Object({ "kind": Type.Literal('never') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('retry_read'), "notBefore": Type.Optional(Type.Ref('Timestamp')) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('retry_same_action'), "notBefore": Type.Optional(Type.Ref('Timestamp')) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('reconcile'), "ownerRef": Type.Ref('OwnerRef') }, { additionalProperties: false })]),
  "RuntimeError": Type.Object({ "code": Type.Ref('RuntimeErrorCode'), "detailCode": Type.String(), "message": Type.String(), "retryAdvice": Type.Ref('RetryAdvice'), "diagnosticId": Type.Ref('Id'), "safeDetail": Type.Optional(JsonValue) }, { additionalProperties: false }),
  "ExternalRequestRef": Type.Object({ "system": Type.String(), "requestId": Type.Ref('Id'), "idempotencyKey": Type.Optional(Type.String()), "requestDigest": Type.Ref('Digest') }, { additionalProperties: false }),
  "RetentionRef": Type.Object({ "kind": Type.Union([Type.Literal('blob'), Type.Literal('artifact'), Type.Literal('domain-record'), Type.Literal('package'), Type.Literal('schema'), Type.Literal('codec')]), "authorityId": Type.Ref('Id'), "resourceId": Type.Ref('Id'), "version": Type.String(), "digest": Type.Ref('Digest'), "pinId": Type.Ref('Id') }, { additionalProperties: false }),
  "BindingRef": Type.Object({ "bindingId": Type.Ref('Id'), "contract": Type.String(), "logicalName": Type.String(), "providerId": Type.Ref('Id') }, { additionalProperties: false }),
  "Provenance": Type.Object({ "sourceRefs": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "producer": Type.Ref('BindingRef'), "trustLabels": Type.Array(Type.String(), { maxItems: 10000 }) }, { additionalProperties: false }),
  "ActionResultView": Type.Object({ "receiptId": Type.Ref('Id'), "actionId": Type.Ref('Id'), "attemptId": Type.Ref('Id'), "bindingId": Type.Ref('Id'), "inputDigest": Type.Ref('Digest'), "outcome": Type.Union([Type.Literal('succeeded'), Type.Literal('failed'), Type.Literal('cancelled'), Type.Literal('unknown_effect')]), "result": Type.Optional(Type.Ref('DataRef')), "error": Type.Optional(Type.Ref('RuntimeError')), "externalRequests": Type.Array(Type.Ref('ExternalRequestRef'), { maxItems: 10000 }), "usageRefs": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "references": Type.Array(Type.Ref('RetentionRef'), { maxItems: 10000 }), "provenance": Type.Ref('Provenance'), "completedAt": Type.Ref('Timestamp'), "visibility": Type.Literal('ready'), "viewId": Type.Ref('Id'), "sourceReceiptId": Type.Ref('Id'), "hookResultSetRef": Type.Union([Type.Ref('DataRef'), Type.Null()]) }, { additionalProperties: false }),
  "ActionVisibilityValue": Type.Union([Type.Object({ "actionId": Type.Ref('Id'), "sourceReceiptId": Type.Ref('Id'), "revision": Type.Ref('UInt53'), "state": Type.Literal('pending'), "stageActionId": Type.Union([Type.Ref('Id'), Type.Null()]), "registrationDigest": Type.Union([Type.Ref('Digest'), Type.Null()]), "result": Type.Null(), "uiResult": Type.Union([Type.Ref('DataRef'), Type.Null()]), "publishedByCommitId": Type.Null() }, { additionalProperties: false }), Type.Object({ "actionId": Type.Ref('Id'), "sourceReceiptId": Type.Ref('Id'), "revision": Type.Ref('UInt53'), "state": Type.Literal('ready'), "stageActionId": Type.Union([Type.Ref('Id'), Type.Null()]), "registrationDigest": Type.Union([Type.Ref('Digest'), Type.Null()]), "result": Type.Ref('ActionResultView'), "uiResult": Type.Union([Type.Ref('DataRef'), Type.Null()]), "publishedByCommitId": Type.Ref('Id') }, { additionalProperties: false })]),
  "StateAuthorityRef": Type.Object({ "authorityId": Type.Ref('Id'), "tenantId": Type.Ref('Id'), "authorityEpoch": Type.Ref('UInt53') }, { additionalProperties: false }),
  "ReadGuard": Type.Object({ "recordId": Type.Ref('Id'), "expectedRecordRevision": Type.Union([Type.Ref('UInt53'), Type.Null()]) }, { additionalProperties: false }),
  "QueryUsageFlush": Type.Object({ "grantId": Type.Ref('Id'), "invocationId": Type.Ref('Id'), "writerEpoch": Type.Ref('UInt53'), "cumulativeCount": Type.Ref('UInt53') }, { additionalProperties: false }),
  "CommitGuard": Type.Object({ "authority": Type.Ref('StateAuthorityRef'), "sessionId": Type.Ref('Id'), "runId": Type.Ref('Id'), "writerId": Type.Ref('Id'), "writerEpoch": Type.Ref('UInt53'), "expectedRunRevision": Type.Ref('UInt53'), "bindingId": Type.Ref('Id'), "invocationId": Type.Ref('Id'), "readGuards": Type.Array(Type.Ref('ReadGuard'), { maxItems: 10000 }), "queryUsage": Type.Union([Type.Ref('QueryUsageFlush'), Type.Null()]) }, { additionalProperties: false }),
  "VersionedState": Type.Object({ "namespace": Type.String(), "codecVersion": Type.String(), "data": Type.Ref('DataRef'), "provenance": Type.Ref('Provenance'), "createdAt": Type.Ref('Timestamp'), "references": Type.Array(Type.Ref('RetentionRef'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "RetryPolicy": Type.Object({ "mode": Type.Union([Type.Literal('never'), Type.Literal('before_dispatch'), Type.Literal('idempotent'), Type.Literal('reconcile_first')]), "maxAttempts": Type.Ref('UInt53'), "backoffMs": Type.Array(Type.Ref('UInt53'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "PreparedAction": Type.Union([Type.Object({ "key": Type.String(), "target": Type.Ref('BindingRef'), "method": Type.String(), "input": Type.Ref('DataRef'), "dependencies": Type.Array(Type.Ref('ActionDependency'), { maxItems: 10000 }), "retry": Type.Ref('RetryPolicy'), "obligation": Type.Literal('mandatory'), "deadline": Type.Ref('Timestamp'), "resultSchema": Type.Ref('SchemaRef'), "references": Type.Array(Type.Ref('RetentionRef'), { maxItems: 10000 }), "presentation": Type.Optional(Type.Object({ "audience": Type.Literal('conversation'), "turnId": Type.Ref('Id'), "kind": Type.Union([Type.Literal('tool'), Type.Literal('assistant-stream')]) }, { additionalProperties: false })), "intentFingerprint": Type.Ref('Digest') }, { additionalProperties: false }), Type.Object({ "key": Type.String(), "target": Type.Ref('BindingRef'), "method": Type.String(), "input": Type.Ref('DataRef'), "dependencies": Type.Array(Type.Ref('ActionDependency'), { maxItems: 10000 }), "retry": Type.Ref('RetryPolicy'), "obligation": Type.Literal('detached'), "deadline": Type.Ref('Timestamp'), "resultSchema": Type.Ref('SchemaRef'), "references": Type.Array(Type.Ref('RetentionRef'), { maxItems: 10000 }), "detachedOwner": Type.Object({ "jobId": Type.Ref('Id'), "authorityId": Type.Ref('Id'), "acceptanceRef": Type.Ref('DataRef') }, { additionalProperties: false }), "presentation": Type.Optional(Type.Object({ "audience": Type.Literal('conversation'), "turnId": Type.Ref('Id'), "kind": Type.Union([Type.Literal('tool'), Type.Literal('assistant-stream')]) }, { additionalProperties: false })), "intentFingerprint": Type.Ref('Digest') }, { additionalProperties: false })]),
  "WaitClause": Type.Union([Type.Object({ "kind": Type.Literal('actions'), "mode": Type.Union([Type.Literal('any'), Type.Literal('all')]), "actions": Type.Array(Type.Ref('ActionRef'), { minItems: 1, maxItems: 10000 }), "readyWhen": Type.Union([Type.Literal('receipt'), Type.Literal('resolved')]) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('interaction'), "interactionId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('signals'), "typeIds": Type.Array(Type.Ref('TypeId'), { minItems: 1, maxItems: 10000 }), "afterSeq": Type.Ref('UInt53') }, { additionalProperties: false })]),
  "WaitCondition": Type.Union([Type.Object({ "anyOf": Type.Array(Type.Ref('WaitClause'), { minItems: 1, maxItems: 10000 }), "deadline": Type.Optional(Type.Ref('Timestamp')) }, { additionalProperties: false }), Type.Object({ "anyOf": Type.Array(Type.Ref('WaitClause'), { minItems: 0, maxItems: 10000 }), "deadline": Type.Ref('Timestamp') }, { additionalProperties: false })]),
  "NextStep": Type.Union([Type.Object({ "kind": Type.Literal('continue') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('wait'), "condition": Type.Ref('WaitCondition') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('complete'), "output": Type.Ref('DataRef'), "references": Type.Array(Type.Ref('RetentionRef'), { maxItems: 10000 }) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('fail'), "error": Type.Ref('RuntimeError') }, { additionalProperties: false })]),
  "ProviderTransition": Type.Object({ "expectedProviderRevision": Type.Ref('UInt53'), "continuation": Type.Ref('VersionedState'), "consumeSignals": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "children": Type.Array(Type.Ref('PreparedAction'), { maxItems: 10000 }), "next": Type.Ref('NextStep') }, { additionalProperties: false }),
  "ConversationContribution": Type.Union([Type.Object({ "key": Type.Ref('Id'), "kind": Type.Literal('assistant-message'), "content": Type.Ref('DataRef'), "sourceResultId": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false }), Type.Object({ "key": Type.Ref('Id'), "kind": Type.Literal('plan-update'), "content": Type.Ref('DataRef'), "sourceResultId": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false })]),
  "LoopTransition": Type.Object({ "expectedRevision": Type.Ref('UInt53'), "continuation": Type.Ref('VersionedState'), "consumeSignals": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "actions": Type.Array(Type.Ref('PreparedAction'), { maxItems: 10000 }), "next": Type.Ref('NextStep'), "conversation": Type.Optional(Type.Array(Type.Ref('ConversationContribution'), { maxItems: 10000 })) }, { additionalProperties: false }),
  "HookEventName": Type.Union([Type.Literal('tool_call'), Type.Literal('approval_request'), Type.Literal('tool_result'), Type.Literal('context'), Type.Literal('before_request'), Type.Literal('request_error'), Type.Literal('format_deviation'), Type.Literal('before_compact'), Type.Literal('compact'), Type.Literal('session_start'), Type.Literal('shutdown'), Type.Literal('subagent_start'), Type.Literal('subagent_end'), Type.Literal('resources_discover'), Type.Literal('before_step'), Type.Literal('turn_stopping')]),
  "HookResultSet": Type.Object({ "stageId": Type.Ref('Id'), "event": Type.Ref('HookEventName'), "registrationDigest": Type.Ref('Digest'), "inputDigest": Type.Ref('Digest'), "entries": Type.Array(Type.Object({ "registrationId": Type.Ref('Id'), "ordinal": Type.Ref('UInt53'), "outcome": Type.Union([Type.Literal('applied'), Type.Literal('failed-open'), Type.Literal('denied')]), "output": Type.Union([Type.Ref('DataRef'), Type.Null()]), "diagnosticId": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false }), { maxItems: 10000 }), "output": Type.Ref('DataRef'), "digest": Type.Ref('Digest'), "sourceActionId": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false }),
  "ScopeRef": Type.Union([Type.Object({ "installationId": Type.Ref('Id'), "kind": Type.Literal('installation') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "kind": Type.Literal('runtime') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "kind": Type.Literal('workspace') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "kind": Type.Literal('session') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "runId": Type.Ref('Id'), "kind": Type.Literal('run') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "runId": Type.Ref('Id'), "kind": Type.Literal('action'), "actionId": Type.Ref('Id') }, { additionalProperties: false })]),
  "ApprovalRequest": Type.Object({ "kind": Type.Literal('approval'), "title": Type.String(), "body": Type.String(), "approvalHookResults": Type.Optional(Type.Ref('HookResultSet')), "allowedGrantScopes": Type.Optional(Type.Array(Type.Union([Type.Literal('once'), Type.Literal('session'), Type.Literal('permanent')]), { maxItems: 10000 })), "actionRef": Type.String(), "inputDigest": Type.Ref('Digest'), "policyDecisionRef": Type.String(), "scope": Type.Ref('ScopeRef'), "allowedResponders": Type.Array(Type.String(), { maxItems: 10000 }), "expiresAt": Type.Ref('Timestamp'), "idempotencyKey": Type.String(), "risk": Type.Union([Type.Literal('destructive'), Type.Literal('always'), Type.Literal('budget'), Type.Literal('unknown')]), "intentDigest": Type.Ref('Digest') }, { additionalProperties: false }),
  "DomainReference": Type.Object({ "authorityId": Type.Ref('Id'), "recordId": Type.Ref('Id'), "recordRevision": Type.Ref('UInt53'), "schema": Type.Ref('SchemaRef'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "ApprovalTaintAck": Type.Object({ "interaction": Type.Ref('DomainReference'), "responseId": Type.Ref('Id') }, { additionalProperties: false }),
  "AuthorizationPreparation": Type.Object({ "preparationId": Type.Ref('Id'), "actionId": Type.Ref('Id'), "inputDigest": Type.Ref('Digest'), "toolCallResults": Type.Union([Type.Ref('HookResultSet'), Type.Null()]), "approvalRequest": Type.Ref('ApprovalRequest'), "policyFactsRef": Type.Ref('DataRef'), "fingerprint": Type.Ref('Digest') }, { additionalProperties: false }),
  "OutboxRecord": Type.Union([Type.Object({ "eventId": Type.Ref('Id'), "sourceAuthorityId": Type.Ref('Id'), "sourceCommitId": Type.Ref('Id'), "destination": Type.Ref('Id'), "typeId": Type.Ref('TypeId'), "payload": Type.Ref('DataRef'), "fingerprint": Type.Ref('Digest'), "delivery": Type.Union([Type.Literal('pending'), Type.Literal('claimed'), Type.Literal('acked')]), "attempts": Type.Ref('UInt53'), "nextAttemptAt": Type.Ref('Timestamp'), "claim": Type.Union([Type.Object({ "ownerId": Type.Ref('Id'), "epoch": Type.Ref('UInt53'), "until": Type.Ref('Timestamp') }, { additionalProperties: false }), Type.Null()]), "ackRef": Type.Union([Type.Ref('Id'), Type.Null()]), "consecutiveFailures": Type.Ref('UInt53'), "lastError": Type.Union([Type.Ref('RuntimeError'), Type.Null()]) }, { additionalProperties: false }), Type.Object({ "eventId": Type.Ref('Id'), "sourceAuthorityId": Type.Ref('Id'), "sourceCommitId": Type.Ref('Id'), "destination": Type.Ref('Id'), "typeId": Type.Ref('TypeId'), "payload": Type.Ref('DataRef'), "fingerprint": Type.Ref('Digest'), "delivery": Type.Literal('dead'), "attempts": Type.Ref('UInt53'), "nextAttemptAt": Type.Ref('Timestamp'), "claim": Type.Union([Type.Object({ "ownerId": Type.Ref('Id'), "epoch": Type.Ref('UInt53'), "until": Type.Ref('Timestamp') }, { additionalProperties: false }), Type.Null()]), "ackRef": Type.Union([Type.Ref('Id'), Type.Null()]), "consecutiveFailures": Type.Ref('UInt53'), "lastError": Type.Ref('RuntimeError') }, { additionalProperties: false })]),
  "RequestIdentity": Type.Object({ "system": Type.String(), "aghRequestId": Type.Ref('Id'), "idempotencyKey": Type.Union([Type.String(), Type.Null()]), "requestDigest": Type.Ref('Digest') }, { additionalProperties: false }),
  "RuntimeControlCommand": Type.Union([Type.Object({ "kind": Type.Literal('prepare_authorization'), "actionId": Type.Ref('Id'), "expectedActionRevision": Type.Ref('UInt53'), "preparation": Type.Ref('AuthorizationPreparation') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('authorize_action'), "actionId": Type.Ref('Id'), "expectedActionRevision": Type.Ref('UInt53'), "decision": Type.Literal('allow'), "decisionRef": Type.Ref('DataRef'), "interactionId": Type.Union([Type.Ref('Id'), Type.Null()]), "validUntil": Type.Ref('Timestamp'), "hookResults": Type.Optional(Type.Array(Type.Ref('HookResultSet'), { maxItems: 10000 })), "approvalTaintAck": Type.Optional(Type.Ref('ApprovalTaintAck')) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('authorize_action'), "actionId": Type.Ref('Id'), "expectedActionRevision": Type.Ref('UInt53'), "decision": Type.Union([Type.Literal('ask'), Type.Literal('deny')]), "decisionRef": Type.Ref('DataRef'), "interactionId": Type.Union([Type.Ref('Id'), Type.Null()]), "validUntil": Type.Ref('Timestamp'), "hookResults": Type.Optional(Type.Array(Type.Ref('HookResultSet'), { maxItems: 10000 })) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('allocate_attempt'), "actionId": Type.Ref('Id'), "expectedActionRevision": Type.Ref('UInt53'), "attemptId": Type.Ref('Id'), "requestIdentity": Type.Ref('RequestIdentity'), "authorizationRef": Type.Ref('Id'), "reservationRefs": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "deadline": Type.Ref('Timestamp') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('start_composite'), "actionId": Type.Ref('Id'), "expectedActionRevision": Type.Ref('UInt53'), "attemptId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('settle_undispatched'), "actionId": Type.Ref('Id'), "expectedActionRevision": Type.Ref('UInt53'), "outcome": Type.Union([Type.Literal('failed'), Type.Literal('cancelled')]), "error": Type.Ref('RuntimeError') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('begin_drain'), "target": Type.Object({ "runId": Type.Ref('Id'), "actionId": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false }), "reason": Type.Ref('RuntimeError') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('finalize_composite'), "actionId": Type.Ref('Id'), "expectedProviderRevision": Type.Ref('UInt53'), "outcome": Type.Union([Type.Literal('failed'), Type.Literal('cancelled')]), "error": Type.Ref('RuntimeError'), "ownerRefs": Type.Array(Type.Ref('OwnerRef'), { maxItems: 10000 }) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('mark_running'), "attemptId": Type.Ref('Id'), "expectedAttemptRevision": Type.Ref('UInt53'), "externalRequests": Type.Array(Type.Ref('ExternalRequestRef'), { maxItems: 10000 }) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('mark_unknown'), "attemptId": Type.Ref('Id'), "expectedAttemptRevision": Type.Ref('UInt53'), "evidence": Type.Array(Type.Ref('DataRef'), { maxItems: 10000 }), "reconciliationOwnerRef": Type.Ref('OwnerRef'), "reason": Type.String() }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('resolve_action'), "actionId": Type.Ref('Id'), "expectedActionRevision": Type.Ref('UInt53'), "selectedReceiptId": Type.Union([Type.Ref('Id'), Type.Null()]), "evidence": Type.Array(Type.Ref('DataRef'), { maxItems: 10000 }), "state": Type.Union([Type.Literal('unresolved'), Type.Literal('resolved'), Type.Literal('conflicting')]), "ownerRef": Type.Ref('OwnerRef'), "nextCheckAt": Type.Union([Type.Ref('Timestamp'), Type.Null()]) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('cancel_run'), "runId": Type.Ref('Id'), "reason": Type.String(), "requestedBy": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('finalize_run'), "runId": Type.Ref('Id'), "expectedRunRevision": Type.Ref('UInt53'), "outcome": Type.Union([Type.Literal('failed'), Type.Literal('cancelled')]), "unknownActionIds": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "ownerRefs": Type.Array(Type.Ref('OwnerRef'), { maxItems: 10000 }) }, { additionalProperties: false })]),
  "DomainEvent": Type.Object({ "eventId": Type.Ref('Id'), "typeId": Type.Ref('TypeId'), "schema": Type.Ref('SchemaRef'), "source": Type.Ref('BindingRef'), "scope": Type.Ref('ScopeRef'), "occurredAt": Type.Ref('Timestamp'), "payload": Type.Ref('DataRef'), "idempotencyKey": Type.String(), "causation": Type.Object({ "runId": Type.Optional(Type.Ref('Id')), "actionId": Type.Optional(Type.Ref('Id')), "attemptId": Type.Optional(Type.Ref('Id')), "commandId": Type.Optional(Type.Ref('Id')) }, { additionalProperties: false }), "principalRef": Type.Ref('Id'), "correlationId": Type.Union([Type.Ref('Id'), Type.Null()]), "provenance": Type.Ref('Provenance') }, { additionalProperties: false }),
  "UsageFact": Type.Object({ "usageId": Type.Ref('Id'), "originKey": Type.String(), "actionId": Type.Ref('Id'), "attemptId": Type.Ref('Id'), "source": Type.Ref('BindingRef'), "dimensions": Type.Ref('DataRef'), "externalRequest": Type.Ref('ExternalRequestRef'), "observedAt": Type.Ref('Timestamp'), "certainty": Type.Union([Type.Literal('measured'), Type.Literal('estimated'), Type.Literal('unknown')]) }, { additionalProperties: false }),
  "ArtifactVersion": Type.Integer({ minimum: 1, maximum: 9007199254740991 }),
  "Revision": Type.Ref('UInt53'),
  "ModelFeatures": Type.Object({ "input": Type.Array(Type.Union([Type.Literal('text'), Type.Literal('image'), Type.Literal('audio'), Type.Literal('video')]), { maxItems: 10000 }), "output": Type.Array(Type.Union([Type.Literal('text'), Type.Literal('image'), Type.Literal('audio'), Type.Literal('video')]), { maxItems: 10000 }), "tools": Type.Boolean(), "structuredOutput": Type.Boolean(), "streaming": Type.Boolean() }, { additionalProperties: false }),
  "SecretConsumerBinding": Type.Object({ "consumer": Type.Union([Type.Literal('model'), Type.Literal('mcp'), Type.Literal('tls'), Type.Literal('jwt'), Type.Literal('source-auth'), Type.Literal('surface')]), "secretId": Type.Ref('Id'), "accountRef": Type.Union([Type.Ref('Id'), Type.Null()]), "serverRef": Type.Ref('Id'), "audience": Type.String(), "purpose": Type.String() }, { additionalProperties: false }),
  "ModelRouteSnapshot": Type.Object({ "routeId": Type.Ref('Id'), "routeRevision": Type.Ref('Revision'), "adapter": Type.Ref('BindingRef'), "model": Type.String(), "endpointRef": Type.Ref('Id'), "catalogRevision": Type.Ref('Revision'), "features": Type.Ref('ModelFeatures'), "priceVersion": Type.Ref('Id'), "credentialAudience": Type.String(), "credentialBinding": Type.Union([Type.Ref('SecretConsumerBinding'), Type.Null()]) }, { additionalProperties: false }),
  "SessionControlBoundary": Type.Object({ "kind": Type.Union([Type.Literal('immediate'), Type.Literal('next-request'), Type.Literal('next-turn'), Type.Literal('quiet-step'), Type.Literal('quiet-turn'), Type.Literal('next-run')]), "revision": Type.Ref('UInt53'), "runId": Type.Union([Type.Ref('Id'), Type.Null()]), "afterRequestId": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false }),
  "CompactOutcome": Type.Union([Type.Object({ "state": Type.Literal('completed'), "endSeq": Type.Integer({ minimum: 1 }) }, { additionalProperties: false }), Type.Object({ "state": Type.Literal('failed'), "endSeq": Type.Integer({ minimum: 1 }) }, { additionalProperties: false }), Type.Object({ "state": Type.Literal('unknown') }, { additionalProperties: false })]),
  "SessionControlResult": Type.Object({ "sessionId": Type.Ref('Id'), "requestId": Type.Ref('Id'), "status": Type.Union([Type.Literal('accepted'), Type.Literal('applied'), Type.Literal('rejected')]), "revision": Type.Ref('UInt53'), "effective": Type.Union([Type.Ref('SessionControlBoundary'), Type.Null()]), "runId": Type.Union([Type.Ref('Id'), Type.Null()]), "childSessionId": Type.Union([Type.Ref('Id'), Type.Null()]), "compact": Type.Union([Type.Ref('CompactOutcome'), Type.Null()]), "error": Type.Union([Type.Ref('RuntimeError'), Type.Null()]) }, { additionalProperties: false }),
  "ServiceCommandRecord": Type.Object({ "commandId": Type.Ref('Id'), "fingerprint": Type.Ref('Digest'), "sessionId": Type.Ref('Id'), "principalRef": Type.Ref('Id'), "sourceRef": Type.Ref('Id'), "extensionId": Type.Ref('Id'), "serviceName": Type.String(), "releaseSetId": Type.Ref('Id'), "bindingId": Type.Ref('Id'), "runId": Type.Ref('Id'), "actionId": Type.Ref('Id'), "state": Type.Union([Type.Literal('accepted'), Type.Literal('running'), Type.Literal('settled'), Type.Literal('unknown')]), "resultRef": Type.Union([Type.Ref('DataRef'), Type.Null()]), "error": Type.Union([Type.Ref('RuntimeError'), Type.Null()]), "ownerRef": Type.Ref('OwnerRef') }, { additionalProperties: false }),
  "ConversationImportResult": Type.Object({ "requestId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "state": Type.Union([Type.Literal('building'), Type.Literal('published'), Type.Literal('rejected')]), "sourceDigest": Type.Ref('Digest'), "factCount": Type.Ref('UInt53'), "commitId": Type.Union([Type.Ref('Id'), Type.Null()]), "error": Type.Union([Type.Ref('RuntimeError'), Type.Null()]) }, { additionalProperties: false }),
  "Cursor": Type.String(),
  "EffectResult": Type.Object({ "outcome": Type.Union([Type.Literal('succeeded'), Type.Literal('failed'), Type.Literal('cancelled'), Type.Literal('unknown_effect')]), "result": Type.Optional(Type.Ref('DataRef')), "error": Type.Optional(Type.Ref('RuntimeError')), "externalRequests": Type.Array(Type.Ref('ExternalRequestRef'), { maxItems: 10000 }), "usage": Type.Array(Type.Ref('UsageFact'), { maxItems: 10000 }), "references": Type.Array(Type.Ref('RetentionRef'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "ReconcileResult": Type.Union([Type.Object({ "kind": Type.Literal('resolved'), "evidence": Type.Ref('DataRef'), "result": Type.Ref('EffectResult') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('not_found'), "evidence": Type.Ref('DataRef'), "safeToRetry": Type.Boolean() }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('unknown'), "evidence": Type.Ref('DataRef'), "reason": Type.String() }, { additionalProperties: false })]),
  "StreamChunkInput": Type.Object({ "typeId": Type.Ref('TypeId'), "payload": Type.Ref('DataRef') }, { additionalProperties: false }),
  "MigrationToken": Type.Object({ "upgradeId": Type.Ref('Id'), "runId": Type.Ref('Id'), "fromBindingId": Type.Ref('Id'), "frozenRevision": Type.Ref('UInt53'), "frozenWriterEpoch": Type.Ref('UInt53'), "authorityEpoch": Type.Ref('UInt53'), "fingerprint": Type.Ref('Digest') }, { additionalProperties: false }),
  "MaintenanceEnvelopeJsonValue": Type.Object({ "recordId": Type.Ref('Id'), "revision": Type.Ref('UInt53'), "writerEpoch": Type.Ref('UInt53'), "createdAt": Type.Ref('Timestamp'), "updatedAt": Type.Ref('Timestamp'), "schema": Type.Ref('SchemaRef'), "payload": JsonValue, "fingerprint": Type.Ref('Digest') }, { additionalProperties: false }),
  "MaintenanceMutation": Type.Object({ "recordId": Type.Ref('Id'), "expectedRevision": Type.Union([Type.Ref('UInt53'), Type.Null()]), "next": Type.Ref('MaintenanceEnvelopeJsonValue') }, { additionalProperties: false }),
  "AuthorityCheckpoint": Type.Object({ "authorityId": Type.Ref('Id'), "authorityEpoch": Type.Ref('UInt53'), "checkpointId": Type.Ref('Id'), "snapshotDigest": Type.Ref('Digest'), "recordCount": Type.Ref('UInt53'), "bridgeWatermarks": Type.Array(Type.Object({ "bridgeId": Type.Ref('Id'), "producedThrough": Type.Ref('UInt53'), "acceptedThrough": Type.Ref('UInt53') }, { additionalProperties: false }), { maxItems: 10000 }) }, { additionalProperties: false }),
  "AuthorityExport": Type.Object({ "upgradeId": Type.Ref('Id'), "fenceId": Type.Ref('Id'), "checkpoint": Type.Ref('AuthorityCheckpoint'), "collectionCount": Type.Ref('UInt53'), "partCount": Type.Ref('UInt53'), "manifestRoot": Type.Ref('DataRef'), "requiredAssetsRoot": Type.Ref('DataRef'), "deletionWatermark": Type.Ref('UInt53') }, { additionalProperties: false }),
  "AuthorityExportPart": Type.Object({ "collectionId": Type.Ref('Id'), "schema": Type.Ref('SchemaRef'), "partIndex": Type.Ref('UInt53'), "firstRecordKey": Type.Ref('Id'), "lastRecordKey": Type.Ref('Id'), "records": Type.Ref('UInt53'), "contentDigest": Type.Ref('Digest'), "chunk": Type.Ref('BlobRef') }, { additionalProperties: false }),
  "AuthorizedViewScope": Type.Union([Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "kind": Type.Literal('workspace') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "kind": Type.Literal('session') }, { additionalProperties: false })]),
  "ArtifactTitle": Object.assign(Type.String({ minLength: 1, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), {"x-max-utf8-bytes":1024}),
  "ArtifactMediaType": Object.assign(Type.String({ pattern: "^[a-z0-9][a-z0-9!#$&^_.+\\-]*/[a-z0-9][a-z0-9!#$&^_.+\\-]*$" }), {"x-max-utf8-bytes":255}),
  "ArtifactReservedView": Type.Object({ "artifactId": Type.Ref('Id'), "version": Type.Ref('ArtifactVersion'), "title": Type.Union([Type.Ref('ArtifactTitle'), Type.Null()]), "mime": Type.Union([Type.Ref('ArtifactMediaType'), Type.Null()]), "size": Type.Null(), "status": Type.Literal('reserved') }, { additionalProperties: false }),
  "ArtifactPendingPublishView": Type.Object({ "artifactId": Type.Ref('Id'), "version": Type.Ref('ArtifactVersion'), "title": Type.Ref('ArtifactTitle'), "mime": Type.Ref('ArtifactMediaType'), "size": Type.Ref('UInt53'), "status": Type.Literal('pending-publish') }, { additionalProperties: false }),
  "ArtifactReadyView": Type.Object({ "artifactId": Type.Ref('Id'), "version": Type.Ref('ArtifactVersion'), "title": Type.Ref('ArtifactTitle'), "mime": Type.Ref('ArtifactMediaType'), "size": Type.Ref('UInt53'), "status": Type.Literal('ready') }, { additionalProperties: false }),
  "ArtifactFailedView": Type.Object({ "artifactId": Type.Ref('Id'), "version": Type.Ref('ArtifactVersion'), "title": Type.Union([Type.Ref('ArtifactTitle'), Type.Null()]), "mime": Type.Union([Type.Ref('ArtifactMediaType'), Type.Null()]), "size": Type.Union([Type.Ref('UInt53'), Type.Null()]), "status": Type.Literal('failed') }, { additionalProperties: false }),
  "ArtifactRevokedView": Type.Object({ "artifactId": Type.Ref('Id'), "version": Type.Ref('ArtifactVersion'), "title": Type.Union([Type.Ref('ArtifactTitle'), Type.Null()]), "mime": Type.Union([Type.Ref('ArtifactMediaType'), Type.Null()]), "size": Type.Union([Type.Ref('UInt53'), Type.Null()]), "status": Type.Literal('revoked') }, { additionalProperties: false }),
  "ArtifactViewRef": Type.Union([Type.Ref('ArtifactReservedView'), Type.Ref('ArtifactPendingPublishView'), Type.Ref('ArtifactReadyView'), Type.Ref('ArtifactFailedView'), Type.Ref('ArtifactRevokedView')]),
  "ViewAction": Type.Union([Type.Object({ "actionKey": Type.String(), "label": Type.String(), "requiredFeatures": Type.Array(Type.String(), { maxItems: 10000 }), "availability": Type.Union([Type.Literal('enabled'), Type.Literal('disabled')]), "disabledReason": Type.Union([Type.String(), Type.Null()]), "kind": Type.Literal('command'), "command": Type.String(), "inputSchema": Type.Ref('SchemaRef') }, { additionalProperties: false }), Type.Object({ "actionKey": Type.String(), "label": Type.String(), "requiredFeatures": Type.Array(Type.String(), { maxItems: 10000 }), "availability": Type.Union([Type.Literal('enabled'), Type.Literal('disabled')]), "disabledReason": Type.Union([Type.String(), Type.Null()]), "kind": Type.Literal('interaction'), "interactionId": Type.String(), "version": Type.Number() }, { additionalProperties: false }), Type.Object({ "actionKey": Type.String(), "label": Type.String(), "requiredFeatures": Type.Array(Type.String(), { maxItems: 10000 }), "availability": Type.Union([Type.Literal('enabled'), Type.Literal('disabled')]), "disabledReason": Type.Union([Type.String(), Type.Null()]), "kind": Type.Literal('download'), "artifactId": Type.String(), "version": Type.Number() }, { additionalProperties: false }), Type.Object({ "actionKey": Type.String(), "label": Type.String(), "requiredFeatures": Type.Array(Type.String(), { maxItems: 10000 }), "availability": Type.Union([Type.Literal('enabled'), Type.Literal('disabled')]), "disabledReason": Type.Union([Type.String(), Type.Null()]), "kind": Type.Literal('open-form'), "interactionId": Type.String(), "version": Type.Number() }, { additionalProperties: false })]),
  "DomainView": Type.Object({ "kind": Type.Literal('domain'), "viewId": Type.String(), "revision": Type.Number(), "domainType": Type.String(), "viewSchema": Type.Ref('SchemaRef'), "renderKey": Type.String(), "scope": Type.Ref('AuthorizedViewScope'), "source": Type.Object({ "eventIds": Type.Array(Type.String(), { maxItems: 10000 }), "projectionRevision": Type.Number() }, { additionalProperties: false }), "phase": Type.Union([Type.Literal('provisional'), Type.Literal('finalized'), Type.Literal('interrupted')]), "stream": Type.Optional(Type.Object({ "streamId": Type.String(), "generation": Type.Number(), "revision": Type.Number() }, { additionalProperties: false })), "fallbackText": Object.assign(Type.String({ maxLength: 4096 }), {"x-max-utf8-bytes":4096}), "data": JsonValue, "resources": Type.Array(Type.Ref('ArtifactViewRef'), { maxItems: 32 }), "actions": Type.Array(Type.Ref('ViewAction'), { maxItems: 32 }) }, { additionalProperties: false }),
  "DomainQuery": Type.Object({ "domainType": Type.String(), "query": Type.Ref('DataRef'), "scope": Type.Ref('ScopeRef'), "cursor": Type.Union([Type.String(), Type.Null()]), "limit": Type.Integer({ minimum: 1, maximum: 500 }) }, { additionalProperties: false }),
  "RoutingSelectResult": Type.Object({ "route": Type.Ref('ModelRouteSnapshot'), "reason": Type.String() }, { additionalProperties: false }),
  "EffectPortsInvokeRequest": Type.Object({ "operation": Type.String(), "input": Type.Ref('DataRef') }, { additionalProperties: false }),
  "EffectPortsStreamRequest": Type.Object({ "operation": Type.String(), "input": Type.Ref('DataRef') }, { additionalProperties: false }),
  "EffectStreamHandleCancelRequest": Type.String(),
  "StreamHandleCancelRequest": Type.String(),
  "StateStoreControlReadServiceCommandRequest": Type.Object({ "commandId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "extensionId": Type.Ref('Id'), "serviceName": Type.String() }, { additionalProperties: false }),
  "StateStoreControlReadServiceCommandResult": Type.Union([Type.Ref('ServiceCommandRecord'), Type.Null()]),
  "StateStoreControlProbeConversationImportResult": Type.Union([Type.Ref('ConversationImportResult'), Type.Null()]),
  "StateStoreControlAdmitInvocationResult": Type.Object({ "prepareId": Type.Ref('Id'), "invocationId": Type.Ref('Id'), "queryGrantId": Type.Ref('Id'), "grantedQueries": Type.Ref('UInt53'), "remainingQueries": Type.Ref('UInt53') }, { additionalProperties: false }),
  "StateStoreControlAdmitQueryResult": Type.Object({ "queryTicketId": Type.Ref('Id'), "remainingQueries": Type.Ref('UInt53') }, { additionalProperties: false }),
  "StateStoreControlCloseInvocationRequest": Type.Object({ "requestId": Type.Ref('Id'), "invocationId": Type.Ref('Id'), "state": Type.Union([Type.Literal('prepared'), Type.Literal('closed'), Type.Literal('faulted')]), "readGuards": Type.Array(Type.Ref('ReadGuard'), { maxItems: 10000 }), "domainReads": Type.Array(Type.Ref('DomainReference'), { maxItems: 10000 }), "unresolvedInflightIds": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "observedQueryCount": Type.Ref('UInt53') }, { additionalProperties: false }),
  "StateStoreControlCloseInvocationResult": Type.Object({ "invocationId": Type.Ref('Id'), "state": Type.Union([Type.Literal('prepared'), Type.Literal('closed'), Type.Literal('faulted')]) }, { additionalProperties: false }),
  "StateStoreControlPruneRecordVersionsRequest": Type.Object({ "requestId": Type.Ref('Id'), "authority": Type.Ref('StateAuthorityRef'), "retentionPolicyRef": Type.Ref('Id'), "versions": Type.Array(Type.Object({ "recordId": Type.Ref('Id'), "recordRevision": Type.Ref('UInt53') }, { additionalProperties: false }), { maxItems: 10000 }) }, { additionalProperties: false }),
  "StateStoreControlPruneRecordVersionsResult": Type.Object({ "pruneId": Type.Ref('Id'), "proofCommitId": Type.Ref('Id'), "pruned": Type.Array(Type.Object({ "recordId": Type.Ref('Id'), "recordRevision": Type.Ref('UInt53') }, { additionalProperties: false }), { maxItems: 10000 }), "retained": Type.Array(Type.Object({ "recordId": Type.Ref('Id'), "recordRevision": Type.Ref('UInt53') }, { additionalProperties: false }), { maxItems: 10000 }) }, { additionalProperties: false }),
  "StateStoreControlCommitControlRequest": Type.Object({ "commitId": Type.Ref('Id'), "guard": Type.Ref('CommitGuard'), "command": Type.Ref('RuntimeControlCommand') }, { additionalProperties: false }),
  "StateStoreControlCancelPreparedActionAdmissionRequest": Type.Object({ "requestId": Type.Ref('Id'), "runId": Type.Ref('Id'), "parentActionId": Type.Union([Type.Ref('Id'), Type.Null()]), "key": Type.String(), "acceptanceId": Type.Ref('Id'), "acceptanceFingerprint": Type.Ref('Digest') }, { additionalProperties: false }),
  "StateStoreControlProbePreparedActionAdmissionRequest": Type.Object({ "runId": Type.Ref('Id'), "parentActionId": Type.Union([Type.Ref('Id'), Type.Null()]), "key": Type.String() }, { additionalProperties: false }),
  "StateStoreControlReadSessionControlRequest": Type.Object({ "sessionId": Type.Ref('Id') }, { additionalProperties: false }),
  "StateStoreControlSessionControlStatusRequest": Type.Object({ "sessionId": Type.Ref('Id'), "requestId": Type.Ref('Id') }, { additionalProperties: false }),
  "StateStoreControlSessionControlStatusResult": Type.Union([Type.Ref('SessionControlResult'), Type.Null()]),
  "StateStoreControlFireTimerRequest": Type.Object({ "requestId": Type.Ref('Id'), "timerId": Type.Ref('Id'), "expectedRecordRevision": Type.Ref('UInt53') }, { additionalProperties: false }),
  "StateStoreControlRegisterStreamResult": Type.Object({ "streamId": Type.Ref('Id') }, { additionalProperties: false }),
  "StateStoreControlAppendStreamRequest": Type.Object({ "requestId": Type.Ref('Id'), "streamId": Type.Ref('Id'), "expectedLastSeq": Type.Ref('UInt53'), "chunks": Type.Array(Type.Ref('StreamChunkInput'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "StateStoreControlAppendStreamResult": Type.Object({ "streamId": Type.Ref('Id'), "firstSeq": Type.Ref('UInt53'), "lastSeq": Type.Ref('UInt53') }, { additionalProperties: false }),
  "StateStoreControlClaimOutboxRequest": Type.Object({ "requestId": Type.Ref('Id'), "destination": Type.Ref('Id'), "ownerId": Type.Ref('Id'), "limit": Type.Ref('UInt53'), "leaseMs": Type.Ref('UInt53') }, { additionalProperties: false }),
  "StateStoreControlClaimOutboxResult": Type.Array(Type.Object({ "claim": Type.Ref('OutboxClaim'), "event": Type.Ref('OutboxRecord') }, { additionalProperties: false }), { maxItems: 10000 }),
  "StateStoreControlAckOutboxRequest": Type.Object({ "requestId": Type.Ref('Id'), "claim": Type.Ref('OutboxClaim'), "acknowledgement": Type.Ref('DataRef') }, { additionalProperties: false }),
  "StateStoreControlAckOutboxResult": Type.Object({ "eventId": Type.Ref('Id'), "state": Type.Literal('acked') }, { additionalProperties: false }),
  "StateStoreControlFailOutboxRequest": Type.Object({ "requestId": Type.Ref('Id'), "claim": Type.Ref('OutboxClaim'), "error": Type.Ref('RuntimeError') }, { additionalProperties: false }),
  "StateStoreControlFailOutboxResult": Type.Object({ "eventId": Type.Ref('Id'), "state": Type.Union([Type.Literal('pending'), Type.Literal('dead')]), "nextAttemptAt": Type.Ref('Timestamp') }, { additionalProperties: false }),
  "StateStoreControlBeginReconciliationRequest": Type.Object({ "requestId": Type.Ref('Id'), "checkId": Type.Ref('Id'), "actionId": Type.Ref('Id'), "expectedActionRevision": Type.Ref('UInt53'), "bindingId": Type.Ref('Id'), "invocationId": Type.Ref('Id'), "lookupMethod": Type.String(), "input": Type.Ref('DataRef'), "deadline": Type.Ref('Timestamp') }, { additionalProperties: false }),
  "StateStoreControlCompleteReconciliationRequest": Type.Object({ "requestId": Type.Ref('Id'), "checkId": Type.Ref('Id'), "result": Type.Ref('ReconcileResult'), "evidence": Type.Array(Type.Ref('DataRef'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "StateStoreControlAdvanceRunRequest": Type.Object({ "commitId": Type.Ref('Id'), "guard": Type.Ref('CommitGuard'), "transition": Type.Ref('LoopTransition') }, { additionalProperties: false }),
  "StateStoreControlAdvanceProviderRequest": Type.Object({ "commitId": Type.Ref('Id'), "guard": Type.Ref('CommitGuard'), "actionId": Type.Ref('Id'), "expectedProviderRevision": Type.Ref('UInt53'), "transition": Type.Ref('ProviderTransition') }, { additionalProperties: false }),
  "StateStoreControlIntakeReceiptResult": Type.Object({ "intakeId": Type.Ref('Id'), "state": Type.Union([Type.Literal('accepted'), Type.Literal('duplicate'), Type.Literal('conflicting')]) }, { additionalProperties: false }),
  "StateStoreControlPublishActionResultResult": Type.Object({ "state": Type.Literal('ready'), "viewId": Type.Ref('Id'), "commitId": Type.Ref('Id') }, { additionalProperties: false }),
  "StateStoreControlProbeActionResultRequest": Type.Object({ "actionId": Type.Ref('Id'), "sourceReceiptId": Type.Ref('Id') }, { additionalProperties: false }),
  "StateStoreControlProbeActionResultResult": Type.Union([Type.Ref('ActionVisibilityValue'), Type.Null()]),
  "StateStoreControlAcceptBridgeChildResult": Type.Object({ "actionId": Type.Ref('Id'), "providerRevision": Type.Ref('UInt53'), "requestFingerprint": Type.Ref('Digest') }, { additionalProperties: false }),
  "StateStoreControlProbeBridgeChildRequest": Type.Object({ "bridgeId": Type.Ref('Id'), "requestId": Type.Ref('Id') }, { additionalProperties: false }),
  "StateStoreControlProbeBridgeChildResult": Type.Union([Type.Object({ "actionId": Type.Ref('Id'), "providerRevision": Type.Ref('UInt53'), "requestFingerprint": Type.Ref('Digest') }, { additionalProperties: false }), Type.Null()]),
  "StateStoreControlBeginMigrationRequest": Type.Object({ "upgradeId": Type.Ref('Id'), "guard": Type.Ref('CommitGuard') }, { additionalProperties: false }),
  "StateStoreControlCommitMigratedRunRequest": Type.Object({ "commitId": Type.Ref('Id'), "token": Type.Ref('MigrationToken'), "toBindingId": Type.Ref('Id'), "candidateContinuation": Type.Ref('VersionedState'), "migrationEvidence": Type.Ref('DataRef') }, { additionalProperties: false }),
  "StateStoreControlAbortMigrationRequest": Type.Object({ "commitId": Type.Ref('Id'), "token": Type.Ref('MigrationToken'), "reason": Type.String() }, { additionalProperties: false }),
  "MaintenanceStoreCommitRequest": Type.Object({ "transactionId": Type.Ref('Id'), "authority": Type.Ref('StateAuthorityRef'), "expectedWriterEpoch": Type.Ref('UInt53'), "mutations": Type.Array(Type.Ref('MaintenanceMutation'), { maxItems: 10000 }), "outbox": Type.Array(Type.Ref('OutboxRecord'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "MaintenanceStoreCommitResult": Type.Object({ "transactionId": Type.Ref('Id'), "revisions": Type.Array(Type.Object({ "recordId": Type.Ref('Id'), "revision": Type.Ref('UInt53') }, { additionalProperties: false }), { maxItems: 10000 }) }, { additionalProperties: false }),
  "AuthorityTransferControlFenceRequest": Type.Object({ "upgradeId": Type.Ref('Id'), "expected": Type.Ref('StateAuthorityRef'), "cohortDigest": Type.Ref('Digest') }, { additionalProperties: false }),
  "AuthorityTransferControlExportRequest": Type.Object({ "upgradeId": Type.Ref('Id'), "fenceId": Type.Ref('Id') }, { additionalProperties: false }),
  "AuthorityTransferControlExportPageRequest": Type.Object({ "upgradeId": Type.Ref('Id'), "fenceId": Type.Ref('Id'), "manifestDigest": Type.Ref('Digest'), "cursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "limit": Type.Ref('UInt53') }, { additionalProperties: false }),
  "PageAuthorityExportPart": Type.Object({ "items": Type.Array(Type.Ref('AuthorityExportPart'), { maxItems: 10000 }), "snapshot": Type.Ref('Id'), "nextCursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "complete": Type.Boolean() }, { additionalProperties: false }),
  "AuthorityTransferControlExportPageResult": Type.Ref('PageAuthorityExportPart'),
  "AuthorityTransferControlImportRequest": Type.Object({ "upgradeId": Type.Ref('Id'), "source": Type.Ref('AuthorityExport'), "targetLocationRef": Type.Ref('Id') }, { additionalProperties: false }),
  "AuthorityTransferControlImportResult": Type.Object({ "targetCheckpoint": Type.Ref('AuthorityCheckpoint'), "candidateRef": Type.Ref('DataRef') }, { additionalProperties: false }),
  "AuthorityTransferControlVerifyRequest": Type.Object({ "upgradeId": Type.Ref('Id'), "source": Type.Ref('AuthorityExport'), "candidateRef": Type.Ref('DataRef') }, { additionalProperties: false }),
  "AuthorityTransferControlActivateRequest": Type.Object({ "upgradeId": Type.Ref('Id'), "cutoverId": Type.Ref('Id'), "publishedRoute": Type.Ref('DataRef') }, { additionalProperties: false }),
  "AuthorityTransferControlAbortRequest": Type.Object({ "upgradeId": Type.Ref('Id'), "expectedFenceId": Type.Ref('Id'), "recoveryRoute": Type.Ref('DataRef') }, { additionalProperties: false }),
  "AuthorityTransferControlProbeRequest": Type.Object({ "upgradeId": Type.Ref('Id') }, { additionalProperties: false }),
  "DomainReducerReduceRequest": Type.Object({ "state": Type.Union([Type.Ref('DataRef'), Type.Null()]), "event": Type.Ref('DomainEvent') }, { additionalProperties: false }),
  "DomainSelectorSelectAuthorizedRequest": Type.Object({ "state": Type.Ref('DataRef'), "query": Type.Ref('DomainQuery'), "projectionRevision": Type.Number() }, { additionalProperties: false }),
  "DomainSelectorSelectAuthorizedResult": Type.Object({ "items": Type.Array(Type.Ref('DomainView'), { maxItems: 10000 }), "pageState": Type.Union([Type.Ref('DataRef'), Type.Null()]), "complete": Type.Boolean() }, { additionalProperties: false }),
  "LocaleClientFormatNumberRequest": Type.Number(),
  "LocaleClientFormatNumberResult": Type.String(),
  "LocaleClientFormatDateResult": Type.String(),
})

export const Id = RuntimePublic11.Import('Id')
export type Id = Static<typeof Id>
export const UInt53 = RuntimePublic11.Import('UInt53')
export type UInt53 = Static<typeof UInt53>
export const Timestamp = RuntimePublic11.Import('Timestamp')
export type Timestamp = Static<typeof Timestamp>
export const OutboxClaim = RuntimePublic11.Import('OutboxClaim')
export type OutboxClaim = Static<typeof OutboxClaim>
export const TypeId = RuntimePublic11.Import('TypeId')
export type TypeId = Static<typeof TypeId>
export const Digest = RuntimePublic11.Import('Digest')
export type Digest = Static<typeof Digest>
export const SchemaRef = RuntimePublic11.Import('SchemaRef')
export type SchemaRef = Static<typeof SchemaRef>
export const BlobRef = RuntimePublic11.Import('BlobRef')
export type BlobRef = Static<typeof BlobRef>
export const DataRef = RuntimePublic11.Import('DataRef')
export type DataRef = Static<typeof DataRef>
export const ActionRef = RuntimePublic11.Import('ActionRef')
export type ActionRef = Static<typeof ActionRef>
export const ActionDependency = RuntimePublic11.Import('ActionDependency')
export type ActionDependency = Static<typeof ActionDependency>
export const RuntimeErrorCode = RuntimePublic11.Import('RuntimeErrorCode')
export type RuntimeErrorCode = Static<typeof RuntimeErrorCode>
export const OwnerRef = RuntimePublic11.Import('OwnerRef')
export type OwnerRef = Static<typeof OwnerRef>
export const RetryAdvice = RuntimePublic11.Import('RetryAdvice')
export type RetryAdvice = Static<typeof RetryAdvice>
export const RuntimeError = RuntimePublic11.Import('RuntimeError')
export type RuntimeError = Static<typeof RuntimeError>
export const ExternalRequestRef = RuntimePublic11.Import('ExternalRequestRef')
export type ExternalRequestRef = Static<typeof ExternalRequestRef>
export const RetentionRef = RuntimePublic11.Import('RetentionRef')
export type RetentionRef = Static<typeof RetentionRef>
export const BindingRef = RuntimePublic11.Import('BindingRef')
export type BindingRef = Static<typeof BindingRef>
export const Provenance = RuntimePublic11.Import('Provenance')
export type Provenance = Static<typeof Provenance>
export const ActionResultView = RuntimePublic11.Import('ActionResultView')
export type ActionResultView = Static<typeof ActionResultView>
export const ActionVisibilityValue = RuntimePublic11.Import('ActionVisibilityValue')
export type ActionVisibilityValue = Static<typeof ActionVisibilityValue>
export const StateAuthorityRef = RuntimePublic11.Import('StateAuthorityRef')
export type StateAuthorityRef = Static<typeof StateAuthorityRef>
export const ReadGuard = RuntimePublic11.Import('ReadGuard')
export type ReadGuard = Static<typeof ReadGuard>
export const QueryUsageFlush = RuntimePublic11.Import('QueryUsageFlush')
export type QueryUsageFlush = Static<typeof QueryUsageFlush>
export const CommitGuard = RuntimePublic11.Import('CommitGuard')
export type CommitGuard = Static<typeof CommitGuard>
export const VersionedState = RuntimePublic11.Import('VersionedState')
export type VersionedState = Static<typeof VersionedState>
export const RetryPolicy = RuntimePublic11.Import('RetryPolicy')
export type RetryPolicy = Static<typeof RetryPolicy>
export const PreparedAction = RuntimePublic11.Import('PreparedAction')
export type PreparedAction = Static<typeof PreparedAction>
export const WaitClause = RuntimePublic11.Import('WaitClause')
export type WaitClause = Static<typeof WaitClause>
export const WaitCondition = RuntimePublic11.Import('WaitCondition')
export type WaitCondition = Static<typeof WaitCondition>
export const NextStep = RuntimePublic11.Import('NextStep')
export type NextStep = Static<typeof NextStep>
export const ProviderTransition = RuntimePublic11.Import('ProviderTransition')
export type ProviderTransition = Static<typeof ProviderTransition>
export const ConversationContribution = RuntimePublic11.Import('ConversationContribution')
export type ConversationContribution = Static<typeof ConversationContribution>
export const LoopTransition = RuntimePublic11.Import('LoopTransition')
export type LoopTransition = Static<typeof LoopTransition>
export const HookEventName = RuntimePublic11.Import('HookEventName')
export type HookEventName = Static<typeof HookEventName>
export const HookResultSet = RuntimePublic11.Import('HookResultSet')
export type HookResultSet = Static<typeof HookResultSet>
export const ScopeRef = RuntimePublic11.Import('ScopeRef')
export type ScopeRef = Static<typeof ScopeRef>
export const ApprovalRequest = RuntimePublic11.Import('ApprovalRequest')
export type ApprovalRequest = Static<typeof ApprovalRequest>
export const DomainReference = RuntimePublic11.Import('DomainReference')
export type DomainReference = Static<typeof DomainReference>
export const ApprovalTaintAck = RuntimePublic11.Import('ApprovalTaintAck')
export type ApprovalTaintAck = Static<typeof ApprovalTaintAck>
export const AuthorizationPreparation = RuntimePublic11.Import('AuthorizationPreparation')
export type AuthorizationPreparation = Static<typeof AuthorizationPreparation>
export const OutboxRecord = RuntimePublic11.Import('OutboxRecord')
export type OutboxRecord = Static<typeof OutboxRecord>
export const RequestIdentity = RuntimePublic11.Import('RequestIdentity')
export type RequestIdentity = Static<typeof RequestIdentity>
export const RuntimeControlCommand = RuntimePublic11.Import('RuntimeControlCommand')
export type RuntimeControlCommand = Static<typeof RuntimeControlCommand>
export const DomainEvent = RuntimePublic11.Import('DomainEvent')
export type DomainEvent = Static<typeof DomainEvent>
export const UsageFact = RuntimePublic11.Import('UsageFact')
export type UsageFact = Static<typeof UsageFact>
export const ArtifactVersion = RuntimePublic11.Import('ArtifactVersion')
export type ArtifactVersion = Static<typeof ArtifactVersion>
export const Revision = RuntimePublic11.Import('Revision')
export type Revision = Static<typeof Revision>
export const ModelFeatures = RuntimePublic11.Import('ModelFeatures')
export type ModelFeatures = Static<typeof ModelFeatures>
export const SecretConsumerBinding = RuntimePublic11.Import('SecretConsumerBinding')
export type SecretConsumerBinding = Static<typeof SecretConsumerBinding>
export const ModelRouteSnapshot = RuntimePublic11.Import('ModelRouteSnapshot')
export type ModelRouteSnapshot = Static<typeof ModelRouteSnapshot>
export const SessionControlBoundary = RuntimePublic11.Import('SessionControlBoundary')
export type SessionControlBoundary = Static<typeof SessionControlBoundary>
export const CompactOutcome = RuntimePublic11.Import('CompactOutcome')
export type CompactOutcome = Static<typeof CompactOutcome>
export const SessionControlResult = RuntimePublic11.Import('SessionControlResult')
export type SessionControlResult = Static<typeof SessionControlResult>
export const ServiceCommandRecord = RuntimePublic11.Import('ServiceCommandRecord')
export type ServiceCommandRecord = Static<typeof ServiceCommandRecord>
export const ConversationImportResult = RuntimePublic11.Import('ConversationImportResult')
export type ConversationImportResult = Static<typeof ConversationImportResult>
export const Cursor = RuntimePublic11.Import('Cursor')
export type Cursor = Static<typeof Cursor>
export const EffectResult = RuntimePublic11.Import('EffectResult')
export type EffectResult = Static<typeof EffectResult>
export const ReconcileResult = RuntimePublic11.Import('ReconcileResult')
export type ReconcileResult = Static<typeof ReconcileResult>
export const StreamChunkInput = RuntimePublic11.Import('StreamChunkInput')
export type StreamChunkInput = Static<typeof StreamChunkInput>
export const MigrationToken = RuntimePublic11.Import('MigrationToken')
export type MigrationToken = Static<typeof MigrationToken>
export const MaintenanceEnvelopeJsonValue = RuntimePublic11.Import('MaintenanceEnvelopeJsonValue')
export type MaintenanceEnvelopeJsonValue = Static<typeof MaintenanceEnvelopeJsonValue>
export const MaintenanceMutation = RuntimePublic11.Import('MaintenanceMutation')
export type MaintenanceMutation = Static<typeof MaintenanceMutation>
export const AuthorityCheckpoint = RuntimePublic11.Import('AuthorityCheckpoint')
export type AuthorityCheckpoint = Static<typeof AuthorityCheckpoint>
export const AuthorityExport = RuntimePublic11.Import('AuthorityExport')
export type AuthorityExport = Static<typeof AuthorityExport>
export const AuthorityExportPart = RuntimePublic11.Import('AuthorityExportPart')
export type AuthorityExportPart = Static<typeof AuthorityExportPart>
export const AuthorizedViewScope = RuntimePublic11.Import('AuthorizedViewScope')
export type AuthorizedViewScope = Static<typeof AuthorizedViewScope>
export const ArtifactTitle = RuntimePublic11.Import('ArtifactTitle')
export type ArtifactTitle = Static<typeof ArtifactTitle>
export const ArtifactMediaType = RuntimePublic11.Import('ArtifactMediaType')
export type ArtifactMediaType = Static<typeof ArtifactMediaType>
export const ArtifactReservedView = RuntimePublic11.Import('ArtifactReservedView')
export type ArtifactReservedView = Static<typeof ArtifactReservedView>
export const ArtifactPendingPublishView = RuntimePublic11.Import('ArtifactPendingPublishView')
export type ArtifactPendingPublishView = Static<typeof ArtifactPendingPublishView>
export const ArtifactReadyView = RuntimePublic11.Import('ArtifactReadyView')
export type ArtifactReadyView = Static<typeof ArtifactReadyView>
export const ArtifactFailedView = RuntimePublic11.Import('ArtifactFailedView')
export type ArtifactFailedView = Static<typeof ArtifactFailedView>
export const ArtifactRevokedView = RuntimePublic11.Import('ArtifactRevokedView')
export type ArtifactRevokedView = Static<typeof ArtifactRevokedView>
export const ArtifactViewRef = RuntimePublic11.Import('ArtifactViewRef')
export type ArtifactViewRef = Static<typeof ArtifactViewRef>
export const ViewAction = RuntimePublic11.Import('ViewAction')
export type ViewAction = Static<typeof ViewAction>
export const DomainView = RuntimePublic11.Import('DomainView')
export type DomainView = Static<typeof DomainView>
export const DomainQuery = RuntimePublic11.Import('DomainQuery')
export type DomainQuery = Static<typeof DomainQuery>
export const RoutingSelectResult = RuntimePublic11.Import('RoutingSelectResult')
export type RoutingSelectResult = Static<typeof RoutingSelectResult>
export const EffectPortsInvokeRequest = RuntimePublic11.Import('EffectPortsInvokeRequest')
export type EffectPortsInvokeRequest = Static<typeof EffectPortsInvokeRequest>
export const EffectPortsStreamRequest = RuntimePublic11.Import('EffectPortsStreamRequest')
export type EffectPortsStreamRequest = Static<typeof EffectPortsStreamRequest>
export const EffectStreamHandleCancelRequest = RuntimePublic11.Import('EffectStreamHandleCancelRequest')
export type EffectStreamHandleCancelRequest = Static<typeof EffectStreamHandleCancelRequest>
export const StreamHandleCancelRequest = RuntimePublic11.Import('StreamHandleCancelRequest')
export type StreamHandleCancelRequest = Static<typeof StreamHandleCancelRequest>
export const StateStoreControlReadServiceCommandRequest = RuntimePublic11.Import('StateStoreControlReadServiceCommandRequest')
export type StateStoreControlReadServiceCommandRequest = Static<typeof StateStoreControlReadServiceCommandRequest>
export const StateStoreControlReadServiceCommandResult = RuntimePublic11.Import('StateStoreControlReadServiceCommandResult')
export type StateStoreControlReadServiceCommandResult = Static<typeof StateStoreControlReadServiceCommandResult>
export const StateStoreControlProbeConversationImportResult = RuntimePublic11.Import('StateStoreControlProbeConversationImportResult')
export type StateStoreControlProbeConversationImportResult = Static<typeof StateStoreControlProbeConversationImportResult>
export const StateStoreControlAdmitInvocationResult = RuntimePublic11.Import('StateStoreControlAdmitInvocationResult')
export type StateStoreControlAdmitInvocationResult = Static<typeof StateStoreControlAdmitInvocationResult>
export const StateStoreControlAdmitQueryResult = RuntimePublic11.Import('StateStoreControlAdmitQueryResult')
export type StateStoreControlAdmitQueryResult = Static<typeof StateStoreControlAdmitQueryResult>
export const StateStoreControlCloseInvocationRequest = RuntimePublic11.Import('StateStoreControlCloseInvocationRequest')
export type StateStoreControlCloseInvocationRequest = Static<typeof StateStoreControlCloseInvocationRequest>
export const StateStoreControlCloseInvocationResult = RuntimePublic11.Import('StateStoreControlCloseInvocationResult')
export type StateStoreControlCloseInvocationResult = Static<typeof StateStoreControlCloseInvocationResult>
export const StateStoreControlPruneRecordVersionsRequest = RuntimePublic11.Import('StateStoreControlPruneRecordVersionsRequest')
export type StateStoreControlPruneRecordVersionsRequest = Static<typeof StateStoreControlPruneRecordVersionsRequest>
export const StateStoreControlPruneRecordVersionsResult = RuntimePublic11.Import('StateStoreControlPruneRecordVersionsResult')
export type StateStoreControlPruneRecordVersionsResult = Static<typeof StateStoreControlPruneRecordVersionsResult>
export const StateStoreControlCommitControlRequest = RuntimePublic11.Import('StateStoreControlCommitControlRequest')
export type StateStoreControlCommitControlRequest = Static<typeof StateStoreControlCommitControlRequest>
export const StateStoreControlCancelPreparedActionAdmissionRequest = RuntimePublic11.Import('StateStoreControlCancelPreparedActionAdmissionRequest')
export type StateStoreControlCancelPreparedActionAdmissionRequest = Static<typeof StateStoreControlCancelPreparedActionAdmissionRequest>
export const StateStoreControlProbePreparedActionAdmissionRequest = RuntimePublic11.Import('StateStoreControlProbePreparedActionAdmissionRequest')
export type StateStoreControlProbePreparedActionAdmissionRequest = Static<typeof StateStoreControlProbePreparedActionAdmissionRequest>
export const StateStoreControlReadSessionControlRequest = RuntimePublic11.Import('StateStoreControlReadSessionControlRequest')
export type StateStoreControlReadSessionControlRequest = Static<typeof StateStoreControlReadSessionControlRequest>
export const StateStoreControlSessionControlStatusRequest = RuntimePublic11.Import('StateStoreControlSessionControlStatusRequest')
export type StateStoreControlSessionControlStatusRequest = Static<typeof StateStoreControlSessionControlStatusRequest>
export const StateStoreControlSessionControlStatusResult = RuntimePublic11.Import('StateStoreControlSessionControlStatusResult')
export type StateStoreControlSessionControlStatusResult = Static<typeof StateStoreControlSessionControlStatusResult>
export const StateStoreControlFireTimerRequest = RuntimePublic11.Import('StateStoreControlFireTimerRequest')
export type StateStoreControlFireTimerRequest = Static<typeof StateStoreControlFireTimerRequest>
export const StateStoreControlRegisterStreamResult = RuntimePublic11.Import('StateStoreControlRegisterStreamResult')
export type StateStoreControlRegisterStreamResult = Static<typeof StateStoreControlRegisterStreamResult>
export const StateStoreControlAppendStreamRequest = RuntimePublic11.Import('StateStoreControlAppendStreamRequest')
export type StateStoreControlAppendStreamRequest = Static<typeof StateStoreControlAppendStreamRequest>
export const StateStoreControlAppendStreamResult = RuntimePublic11.Import('StateStoreControlAppendStreamResult')
export type StateStoreControlAppendStreamResult = Static<typeof StateStoreControlAppendStreamResult>
export const StateStoreControlClaimOutboxRequest = RuntimePublic11.Import('StateStoreControlClaimOutboxRequest')
export type StateStoreControlClaimOutboxRequest = Static<typeof StateStoreControlClaimOutboxRequest>
export const StateStoreControlClaimOutboxResult = RuntimePublic11.Import('StateStoreControlClaimOutboxResult')
export type StateStoreControlClaimOutboxResult = Static<typeof StateStoreControlClaimOutboxResult>
export const StateStoreControlAckOutboxRequest = RuntimePublic11.Import('StateStoreControlAckOutboxRequest')
export type StateStoreControlAckOutboxRequest = Static<typeof StateStoreControlAckOutboxRequest>
export const StateStoreControlAckOutboxResult = RuntimePublic11.Import('StateStoreControlAckOutboxResult')
export type StateStoreControlAckOutboxResult = Static<typeof StateStoreControlAckOutboxResult>
export const StateStoreControlFailOutboxRequest = RuntimePublic11.Import('StateStoreControlFailOutboxRequest')
export type StateStoreControlFailOutboxRequest = Static<typeof StateStoreControlFailOutboxRequest>
export const StateStoreControlFailOutboxResult = RuntimePublic11.Import('StateStoreControlFailOutboxResult')
export type StateStoreControlFailOutboxResult = Static<typeof StateStoreControlFailOutboxResult>
export const StateStoreControlBeginReconciliationRequest = RuntimePublic11.Import('StateStoreControlBeginReconciliationRequest')
export type StateStoreControlBeginReconciliationRequest = Static<typeof StateStoreControlBeginReconciliationRequest>
export const StateStoreControlCompleteReconciliationRequest = RuntimePublic11.Import('StateStoreControlCompleteReconciliationRequest')
export type StateStoreControlCompleteReconciliationRequest = Static<typeof StateStoreControlCompleteReconciliationRequest>
export const StateStoreControlAdvanceRunRequest = RuntimePublic11.Import('StateStoreControlAdvanceRunRequest')
export type StateStoreControlAdvanceRunRequest = Static<typeof StateStoreControlAdvanceRunRequest>
export const StateStoreControlAdvanceProviderRequest = RuntimePublic11.Import('StateStoreControlAdvanceProviderRequest')
export type StateStoreControlAdvanceProviderRequest = Static<typeof StateStoreControlAdvanceProviderRequest>
export const StateStoreControlIntakeReceiptResult = RuntimePublic11.Import('StateStoreControlIntakeReceiptResult')
export type StateStoreControlIntakeReceiptResult = Static<typeof StateStoreControlIntakeReceiptResult>
export const StateStoreControlPublishActionResultResult = RuntimePublic11.Import('StateStoreControlPublishActionResultResult')
export type StateStoreControlPublishActionResultResult = Static<typeof StateStoreControlPublishActionResultResult>
export const StateStoreControlProbeActionResultRequest = RuntimePublic11.Import('StateStoreControlProbeActionResultRequest')
export type StateStoreControlProbeActionResultRequest = Static<typeof StateStoreControlProbeActionResultRequest>
export const StateStoreControlProbeActionResultResult = RuntimePublic11.Import('StateStoreControlProbeActionResultResult')
export type StateStoreControlProbeActionResultResult = Static<typeof StateStoreControlProbeActionResultResult>
export const StateStoreControlAcceptBridgeChildResult = RuntimePublic11.Import('StateStoreControlAcceptBridgeChildResult')
export type StateStoreControlAcceptBridgeChildResult = Static<typeof StateStoreControlAcceptBridgeChildResult>
export const StateStoreControlProbeBridgeChildRequest = RuntimePublic11.Import('StateStoreControlProbeBridgeChildRequest')
export type StateStoreControlProbeBridgeChildRequest = Static<typeof StateStoreControlProbeBridgeChildRequest>
export const StateStoreControlProbeBridgeChildResult = RuntimePublic11.Import('StateStoreControlProbeBridgeChildResult')
export type StateStoreControlProbeBridgeChildResult = Static<typeof StateStoreControlProbeBridgeChildResult>
export const StateStoreControlBeginMigrationRequest = RuntimePublic11.Import('StateStoreControlBeginMigrationRequest')
export type StateStoreControlBeginMigrationRequest = Static<typeof StateStoreControlBeginMigrationRequest>
export const StateStoreControlCommitMigratedRunRequest = RuntimePublic11.Import('StateStoreControlCommitMigratedRunRequest')
export type StateStoreControlCommitMigratedRunRequest = Static<typeof StateStoreControlCommitMigratedRunRequest>
export const StateStoreControlAbortMigrationRequest = RuntimePublic11.Import('StateStoreControlAbortMigrationRequest')
export type StateStoreControlAbortMigrationRequest = Static<typeof StateStoreControlAbortMigrationRequest>
export const MaintenanceStoreCommitRequest = RuntimePublic11.Import('MaintenanceStoreCommitRequest')
export type MaintenanceStoreCommitRequest = Static<typeof MaintenanceStoreCommitRequest>
export const MaintenanceStoreCommitResult = RuntimePublic11.Import('MaintenanceStoreCommitResult')
export type MaintenanceStoreCommitResult = Static<typeof MaintenanceStoreCommitResult>
export const AuthorityTransferControlFenceRequest = RuntimePublic11.Import('AuthorityTransferControlFenceRequest')
export type AuthorityTransferControlFenceRequest = Static<typeof AuthorityTransferControlFenceRequest>
export const AuthorityTransferControlExportRequest = RuntimePublic11.Import('AuthorityTransferControlExportRequest')
export type AuthorityTransferControlExportRequest = Static<typeof AuthorityTransferControlExportRequest>
export const AuthorityTransferControlExportPageRequest = RuntimePublic11.Import('AuthorityTransferControlExportPageRequest')
export type AuthorityTransferControlExportPageRequest = Static<typeof AuthorityTransferControlExportPageRequest>
export const PageAuthorityExportPart = RuntimePublic11.Import('PageAuthorityExportPart')
export type PageAuthorityExportPart = Page<AuthorityExportPart>
export const AuthorityTransferControlExportPageResult = RuntimePublic11.Import('AuthorityTransferControlExportPageResult')
export type AuthorityTransferControlExportPageResult = PageAuthorityExportPart
export const AuthorityTransferControlImportRequest = RuntimePublic11.Import('AuthorityTransferControlImportRequest')
export type AuthorityTransferControlImportRequest = Static<typeof AuthorityTransferControlImportRequest>
export const AuthorityTransferControlImportResult = RuntimePublic11.Import('AuthorityTransferControlImportResult')
export type AuthorityTransferControlImportResult = Static<typeof AuthorityTransferControlImportResult>
export const AuthorityTransferControlVerifyRequest = RuntimePublic11.Import('AuthorityTransferControlVerifyRequest')
export type AuthorityTransferControlVerifyRequest = Static<typeof AuthorityTransferControlVerifyRequest>
export const AuthorityTransferControlActivateRequest = RuntimePublic11.Import('AuthorityTransferControlActivateRequest')
export type AuthorityTransferControlActivateRequest = Static<typeof AuthorityTransferControlActivateRequest>
export const AuthorityTransferControlAbortRequest = RuntimePublic11.Import('AuthorityTransferControlAbortRequest')
export type AuthorityTransferControlAbortRequest = Static<typeof AuthorityTransferControlAbortRequest>
export const AuthorityTransferControlProbeRequest = RuntimePublic11.Import('AuthorityTransferControlProbeRequest')
export type AuthorityTransferControlProbeRequest = Static<typeof AuthorityTransferControlProbeRequest>
export const DomainReducerReduceRequest = RuntimePublic11.Import('DomainReducerReduceRequest')
export type DomainReducerReduceRequest = Static<typeof DomainReducerReduceRequest>
export const DomainSelectorSelectAuthorizedRequest = RuntimePublic11.Import('DomainSelectorSelectAuthorizedRequest')
export type DomainSelectorSelectAuthorizedRequest = Static<typeof DomainSelectorSelectAuthorizedRequest>
export const DomainSelectorSelectAuthorizedResult = RuntimePublic11.Import('DomainSelectorSelectAuthorizedResult')
export type DomainSelectorSelectAuthorizedResult = Static<typeof DomainSelectorSelectAuthorizedResult>
export const LocaleClientFormatNumberRequest = RuntimePublic11.Import('LocaleClientFormatNumberRequest')
export type LocaleClientFormatNumberRequest = Static<typeof LocaleClientFormatNumberRequest>
export const LocaleClientFormatNumberResult = RuntimePublic11.Import('LocaleClientFormatNumberResult')
export type LocaleClientFormatNumberResult = Static<typeof LocaleClientFormatNumberResult>
export const LocaleClientFormatDateResult = RuntimePublic11.Import('LocaleClientFormatDateResult')
export type LocaleClientFormatDateResult = Static<typeof LocaleClientFormatDateResult>
