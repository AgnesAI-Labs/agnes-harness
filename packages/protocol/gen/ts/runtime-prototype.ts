// generated from schema by tools/gen.ts — do not edit
import { Type, type Static } from '@sinclair/typebox'
import { FormatRegistry } from '@sinclair/typebox'

if (!FormatRegistry.Has('date-time')) FormatRegistry.Set('date-time', (value) => { const parts = value.split(/t/i); if (parts.length !== 2) return false; const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(parts[0] ?? ''); const time = /^(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)(z|([+-])(\d{2}):(\d{2}))$/i.exec(parts[1] ?? ''); if (!date || !time) return false; const year = Number(date[1]), month = Number(date[2]), day = Number(date[3]); const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0); const days = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; if (month < 1 || month > 12 || day < 1 || day > (days[month] ?? 0)) return false; const hour = Number(time[1]), minute = Number(time[2]), second = Number(time[3]); const offsetHour = Number(time[6] || 0), offsetMinute = Number(time[7] || 0); if (hour > 23 || minute > 59 || offsetHour > 23 || offsetMinute > 59) return false; if (second < 60) return true; const sign = time[5] === '-' ? -1 : 1; const utcMinute = minute - offsetMinute * sign; const utcHour = hour - offsetHour * sign - (utcMinute < 0 ? 1 : 0); return (utcHour === 23 || utcHour === -1) && (utcMinute === 59 || utcMinute === -1) && second < 61; })

export const JsonValue = Type.Recursive((This) => Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String(), Type.Array(This, { minItems: 0, maxItems: 10000 }), Type.Record(Type.String(), This)]))
export type JsonValue = Static<typeof JsonValue>

export const RuntimePrototype = Type.Module({
  "AckOutboxRequest": Type.Object({ "requestId": Type.Ref('Id'), "claim": Type.Ref('OutboxClaim'), "acknowledgement": Type.Ref('DataRef') }, { additionalProperties: false }),
  "AckOutboxResult": Type.Object({ "eventId": Type.Ref('Id'), "state": Type.Literal('acked') }, { additionalProperties: false }),
  "ActionDependency": Type.Object({ "action": Type.Ref('ActionRef'), "onDependencyFailure": Type.Union([Type.Literal('cancel'), Type.Literal('run_with_receipt')]) }, { additionalProperties: false }),
  "ActionRef": Type.Union([Type.Object({ "existingActionId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "localKey": Type.String() }, { additionalProperties: false })]),
  "ActionResultView": Type.Object({ "receiptId": Type.Ref('Id'), "actionId": Type.Ref('Id'), "attemptId": Type.Ref('Id'), "bindingId": Type.Ref('Id'), "inputDigest": Type.Ref('Digest'), "outcome": Type.Union([Type.Literal('succeeded'), Type.Literal('failed'), Type.Literal('cancelled'), Type.Literal('unknown_effect')]), "result": Type.Optional(Type.Ref('DataRef')), "error": Type.Optional(Type.Ref('RuntimeError')), "externalRequests": Type.Array(Type.Ref('ExternalRequestRef'), { maxItems: 10000 }), "usageRefs": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "references": Type.Array(Type.Ref('RetentionRef'), { maxItems: 10000 }), "provenance": Type.Ref('Provenance'), "completedAt": Type.Ref('Timestamp'), "visibility": Type.Literal('ready'), "viewId": Type.Ref('Id'), "sourceReceiptId": Type.Ref('Id'), "hookResultSetRef": Type.Union([Type.Ref('DataRef'), Type.Null()]) }, { additionalProperties: false }),
  "ActionVisibilityValue": Type.Union([Type.Object({ "actionId": Type.Ref('Id'), "sourceReceiptId": Type.Ref('Id'), "revision": Type.Ref('UInt53'), "state": Type.Literal('pending'), "stageActionId": Type.Union([Type.Ref('Id'), Type.Null()]), "registrationDigest": Type.Union([Type.Ref('Digest'), Type.Null()]), "result": Type.Null(), "uiResult": Type.Union([Type.Ref('DataRef'), Type.Null()]), "publishedByCommitId": Type.Null() }, { additionalProperties: false }), Type.Object({ "actionId": Type.Ref('Id'), "sourceReceiptId": Type.Ref('Id'), "revision": Type.Ref('UInt53'), "state": Type.Literal('ready'), "stageActionId": Type.Union([Type.Ref('Id'), Type.Null()]), "registrationDigest": Type.Union([Type.Ref('Digest'), Type.Null()]), "result": Type.Ref('ActionResultView'), "uiResult": Type.Union([Type.Ref('DataRef'), Type.Null()]), "publishedByCommitId": Type.Ref('Id') }, { additionalProperties: false })]),
  "AdmissionProbe": Type.Union([Type.Object({ "state": Type.Literal('absent') }, { additionalProperties: false }), Type.Object({ "state": Type.Literal('created'), "runId": Type.Ref('Id'), "commit": Type.Ref('StateCommitReceipt') }, { additionalProperties: false }), Type.Object({ "state": Type.Literal('cancelled'), "tombstoneId": Type.Ref('Id') }, { additionalProperties: false })]),
  "AdmitInvocationResult": Type.Object({ "prepareId": Type.Ref('Id'), "invocationId": Type.Ref('Id'), "queryGrantId": Type.Ref('Id'), "grantedQueries": Type.Ref('UInt53'), "remainingQueries": Type.Ref('UInt53') }, { additionalProperties: false }),
  "AdmitQueryResult": Type.Object({ "queryTicketId": Type.Ref('Id'), "remainingQueries": Type.Ref('UInt53') }, { additionalProperties: false }),
  "AdvanceProviderRequest": Type.Object({ "commitId": Type.Ref('Id'), "guard": Type.Ref('CommitGuard'), "actionId": Type.Ref('Id'), "expectedProviderRevision": Type.Ref('UInt53'), "transition": Type.Ref('ProviderTransition') }, { additionalProperties: false }),
  "AdvanceRunRequest": Type.Object({ "commitId": Type.Ref('Id'), "guard": Type.Ref('CommitGuard'), "transition": Type.Ref('LoopTransition') }, { additionalProperties: false }),
  "ApprovalRequest": Type.Object({ "kind": Type.Literal('approval'), "title": Type.String(), "body": Type.String(), "approvalHookResults": Type.Optional(Type.Ref('HookResultSet')), "allowedGrantScopes": Type.Optional(Type.Array(Type.Union([Type.Literal('once'), Type.Literal('session'), Type.Literal('permanent')]), { maxItems: 10000 })), "actionRef": Type.String(), "inputDigest": Type.Ref('Digest'), "policyDecisionRef": Type.String(), "scope": Type.Ref('ScopeRef'), "allowedResponders": Type.Array(Type.String(), { maxItems: 10000 }), "expiresAt": Type.Ref('Timestamp'), "idempotencyKey": Type.String() }, { additionalProperties: false }),
  "ApprovalTaintAck": Type.Object({ "interaction": Type.Ref('DomainReference'), "responseId": Type.Ref('Id') }, { additionalProperties: false }),
  "AuthorizationPreparation": Type.Object({ "preparationId": Type.Ref('Id'), "actionId": Type.Ref('Id'), "inputDigest": Type.Ref('Digest'), "toolCallResults": Type.Union([Type.Ref('HookResultSet'), Type.Null()]), "approvalRequest": Type.Ref('ApprovalRequest'), "policyFactsRef": Type.Ref('DataRef'), "fingerprint": Type.Ref('Digest') }, { additionalProperties: false }),
  "BindingRef": Type.Object({ "bindingId": Type.Ref('Id'), "contract": Type.String(), "logicalName": Type.String(), "providerId": Type.Ref('Id') }, { additionalProperties: false }),
  "BlobRef": Type.Object({ "authorityId": Type.Ref('Id'), "blobId": Type.Ref('Id'), "digest": Type.Ref('Digest'), "bytes": Type.Ref('UInt53'), "mediaType": Type.String(), "pinId": Type.Ref('Id') }, { additionalProperties: false }),
  "CallContextWire": Type.Object({ "principalRef": Type.Ref('Id'), "scope": Type.Ref('ScopeRef'), "bindingId": Type.Ref('Id'), "invocationId": Type.Ref('Id'), "deadline": Type.Ref('Timestamp'), "traceRef": Type.Ref('Id'), "authorizationRef": Type.Ref('Id') }, { additionalProperties: false }),
  "ClaimOutboxRequest": Type.Object({ "requestId": Type.Ref('Id'), "destination": Type.Ref('Id'), "ownerId": Type.Ref('Id'), "limit": Type.Ref('UInt53'), "leaseMs": Type.Ref('UInt53') }, { additionalProperties: false }),
  "ClaimOutboxResult": Type.Array(Type.Object({ "claim": Type.Ref('OutboxClaim'), "event": Type.Ref('OutboxRecord') }, { additionalProperties: false }), { maxItems: 10000 }),
  "CloseInvocationRequest": Type.Object({ "requestId": Type.Ref('Id'), "invocationId": Type.Ref('Id'), "state": Type.Union([Type.Literal('prepared'), Type.Literal('closed'), Type.Literal('faulted')]), "readGuards": Type.Array(Type.Ref('ReadGuard'), { maxItems: 10000 }), "domainReads": Type.Array(Type.Ref('DomainReference'), { maxItems: 10000 }), "unresolvedInflightIds": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "observedQueryCount": Type.Ref('UInt53') }, { additionalProperties: false }),
  "CloseInvocationResult": Type.Object({ "invocationId": Type.Ref('Id'), "state": Type.Union([Type.Literal('prepared'), Type.Literal('closed'), Type.Literal('faulted')]) }, { additionalProperties: false }),
  "CommitControlRequest": Type.Object({ "commitId": Type.Ref('Id'), "guard": Type.Ref('CommitGuard'), "command": Type.Ref('RuntimeControlCommand') }, { additionalProperties: false }),
  "CommitGuard": Type.Object({ "authority": Type.Ref('StateAuthorityRef'), "sessionId": Type.Ref('Id'), "runId": Type.Ref('Id'), "writerId": Type.Ref('Id'), "writerEpoch": Type.Ref('UInt53'), "expectedRunRevision": Type.Ref('UInt53'), "bindingId": Type.Ref('Id'), "invocationId": Type.Ref('Id'), "readGuards": Type.Array(Type.Ref('ReadGuard'), { maxItems: 10000 }), "queryUsage": Type.Union([Type.Ref('QueryUsageFlush'), Type.Null()]) }, { additionalProperties: false }),
  "ConversationAdmission": Type.Object({ "turnId": Type.Ref('Id'), "inputMessageId": Type.Ref('Id'), "inputRef": Type.Ref('DataRef'), "kind": Type.Union([Type.Literal('prompt'), Type.Literal('follow-up')]) }, { additionalProperties: false }),
  "ConversationContribution": Type.Union([Type.Object({ "key": Type.Ref('Id'), "kind": Type.Literal('assistant-message'), "content": Type.Ref('DataRef'), "sourceResultId": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false }), Type.Object({ "key": Type.Ref('Id'), "kind": Type.Literal('plan-update'), "content": Type.Ref('DataRef'), "sourceResultId": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false })]),
  "DataRef": Type.Union([Type.Object({ "kind": Type.Literal('inline'), "schema": Type.Ref('SchemaRef'), "value": JsonValue, "digest": Type.Ref('Digest'), "bytes": Type.Ref('UInt53') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('blob'), "schema": Type.Ref('SchemaRef'), "blob": Type.Ref('BlobRef') }, { additionalProperties: false })]),
  "Digest": Type.String({ pattern: "^[a-f0-9]{64}$" }),
  "DispatchAdmissionProbe": Type.Union([Type.Object({ "state": Type.Literal('absent') }, { additionalProperties: false }), Type.Object({ "state": Type.Literal('decided'), "admissionId": Type.Ref('Id'), "requestFingerprint": Type.Ref('Digest'), "result": Type.Ref('DispatchAdmissionResult') }, { additionalProperties: false })]),
  "DispatchAdmissionRequest": Type.Object({ "admissionId": Type.Ref('Id'), "commitId": Type.Ref('Id'), "guard": Type.Ref('CommitGuard'), "atomicDomain": Type.Ref('DispatchAtomicDomain'), "actionId": Type.Ref('Id'), "expectedActionRevision": Type.Ref('UInt53'), "decisionRef": Type.Ref('DataRef'), "attemptId": Type.Ref('Id'), "requestIdentity": Type.Ref('RequestIdentity'), "hookResults": Type.Optional(Type.Array(Type.Ref('HookResultSet'), { maxItems: 10000 })), "budget": Type.Ref('DispatchBudgetPlan'), "deadline": Type.Ref('Timestamp'), "approvalTaintAck": Type.Optional(Type.Ref('ApprovalTaintAck')) }, { additionalProperties: false }),
  "DispatchAdmissionResult": Type.Union([Type.Object({ "state": Type.Literal('admitted'), "commitId": Type.Ref('Id'), "authorizationId": Type.Ref('Id'), "attemptId": Type.Ref('Id'), "budgetReservationRefs": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "quotaReservationRefs": Type.Array(Type.Ref('Id'), { maxItems: 10000 }) }, { additionalProperties: false }), Type.Object({ "state": Type.Literal('rejected'), "commitId": Type.Ref('Id'), "reason": Type.Union([Type.Literal('denied'), Type.Literal('quota'), Type.Literal('expired'), Type.Literal('cancelled')]), "error": Type.Ref('RuntimeError') }, { additionalProperties: false })]),
  "DispatchAtomicDomain": Type.Object({ "domainId": Type.Ref('Id'), "revision": Type.Ref('UInt53'), "stateAuthority": Type.Ref('StateAuthorityRef'), "budgetAuthority": Type.Ref('StateAuthorityRef'), "stateBinding": Type.Ref('BindingRef'), "budgetBinding": Type.Ref('BindingRef') }, { additionalProperties: false }),
  "DispatchBudgetPlan": Type.Object({ "reservation": Type.Union([Type.Null(), Type.Object({ "accountRef": Type.Ref('DomainReference'), "parentReservationRef": Type.Union([Type.Ref('DomainReference'), Type.Null()]), "unitsByKind": Type.Array(Type.Object({ "unit": Type.String(), "value": Type.String() }, { additionalProperties: false }), { maxItems: 10000 }), "amount": Type.Union([Type.Null(), Type.Object({ "maxCost": Type.Ref('Money'), "priceVersion": Type.Ref('Id') }, { additionalProperties: false })]) }, { additionalProperties: false })]), "quota": Type.Array(Type.Object({ "name": Type.Union([Type.Literal('parallel-action'), Type.Literal('live-agent')]), "amount": Type.Ref('UInt53') }, { additionalProperties: false }), { maxItems: 10000 }) }, { additionalProperties: false }),
  "DomainEvent": Type.Object({ "eventId": Type.Ref('Id'), "typeId": Type.Ref('TypeId'), "schema": Type.Ref('SchemaRef'), "source": Type.Ref('BindingRef'), "scope": Type.Ref('ScopeRef'), "occurredAt": Type.Ref('Timestamp'), "payload": Type.Ref('DataRef'), "idempotencyKey": Type.String(), "causation": Type.Object({ "runId": Type.Optional(Type.Ref('Id')), "actionId": Type.Optional(Type.Ref('Id')), "attemptId": Type.Optional(Type.Ref('Id')), "commandId": Type.Optional(Type.Ref('Id')) }, { additionalProperties: false }) }, { additionalProperties: false }),
  "DomainReference": Type.Object({ "authorityId": Type.Ref('Id'), "recordId": Type.Ref('Id'), "recordRevision": Type.Ref('UInt53'), "schema": Type.Ref('SchemaRef'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "ExternalRequestRef": Type.Object({ "system": Type.String(), "requestId": Type.Ref('Id'), "idempotencyKey": Type.Optional(Type.String()), "requestDigest": Type.Ref('Digest') }, { additionalProperties: false }),
  "FailOutboxRequest": Type.Object({ "requestId": Type.Ref('Id'), "claim": Type.Ref('OutboxClaim'), "error": Type.Ref('RuntimeError') }, { additionalProperties: false }),
  "FailOutboxResult": Type.Object({ "eventId": Type.Ref('Id'), "state": Type.Union([Type.Literal('pending'), Type.Literal('dead')]), "nextAttemptAt": Type.Ref('Timestamp') }, { additionalProperties: false }),
  "HookEventName": Type.Union([Type.Literal('tool_call'), Type.Literal('approval_request'), Type.Literal('tool_result'), Type.Literal('context'), Type.Literal('before_request'), Type.Literal('request_error'), Type.Literal('format_deviation'), Type.Literal('before_compact'), Type.Literal('compact'), Type.Literal('session_start'), Type.Literal('shutdown'), Type.Literal('subagent_start'), Type.Literal('subagent_end'), Type.Literal('resources_discover'), Type.Literal('before_step'), Type.Literal('turn_stopping')]),
  "HookRegistrationSnapshot": Type.Object({ "registrationId": Type.Ref('Id'), "provider": Type.Ref('BindingRef'), "codeDigest": Type.Ref('Digest'), "ordinal": Type.Ref('UInt53'), "mode": Type.Union([Type.Literal('parallel'), Type.Literal('waterfall'), Type.Literal('serial'), Type.Literal('emit')]), "category": Type.Union([Type.Literal('observe'), Type.Literal('transform'), Type.Literal('directive')]), "failPolicy": Type.Union([Type.Literal('open'), Type.Literal('closed')]), "replayOnResume": Type.Boolean(), "timeoutMs": Type.Ref('UInt53') }, { additionalProperties: false }),
  "HookResultSet": Type.Object({ "stageId": Type.Ref('Id'), "event": Type.Ref('HookEventName'), "registrationDigest": Type.Ref('Digest'), "inputDigest": Type.Ref('Digest'), "entries": Type.Array(Type.Object({ "registrationId": Type.Ref('Id'), "ordinal": Type.Ref('UInt53'), "outcome": Type.Union([Type.Literal('applied'), Type.Literal('failed-open'), Type.Literal('denied')]), "output": Type.Union([Type.Ref('DataRef'), Type.Null()]), "diagnosticId": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false }), { maxItems: 10000 }), "output": Type.Ref('DataRef'), "digest": Type.Ref('Digest'), "sourceActionId": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false }),
  "HookStageRequest": Type.Object({ "stageId": Type.Ref('Id'), "event": Type.Ref('HookEventName'), "owner": Type.Object({ "runId": Type.Ref('Id'), "actionId": Type.Union([Type.Ref('Id'), Type.Null()]), "requestId": Type.Ref('Id') }, { additionalProperties: false }), "registrationDigest": Type.Ref('Digest'), "input": Type.Ref('DataRef'), "inputDigest": Type.Ref('Digest') }, { additionalProperties: false }),
  "Id": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }),
  "InlineResultHookEvaluation": Type.Object({ "source": Type.Ref('InlineResultHookSource'), "request": Type.Object({ "stageId": Type.Ref('Id'), "event": Type.Literal('tool_result'), "owner": Type.Object({ "runId": Type.Ref('Id'), "actionId": Type.Ref('Id'), "requestId": Type.Ref('Id') }, { additionalProperties: false }), "registrationDigest": Type.Ref('Digest'), "input": Type.Ref('DataRef'), "inputDigest": Type.Ref('Digest') }, { additionalProperties: false }), "hookResultSet": Type.Object({ "stageId": Type.Ref('Id'), "event": Type.Literal('tool_result'), "registrationDigest": Type.Ref('Digest'), "inputDigest": Type.Ref('Digest'), "entries": Type.Array(Type.Object({ "registrationId": Type.Ref('Id'), "ordinal": Type.Ref('UInt53'), "outcome": Type.Union([Type.Literal('applied'), Type.Literal('failed-open'), Type.Literal('denied')]), "output": Type.Union([Type.Ref('DataRef'), Type.Null()]), "diagnosticId": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false }), { maxItems: 10000 }), "output": Type.Ref('DataRef'), "digest": Type.Ref('Digest'), "sourceActionId": Type.Null() }, { additionalProperties: false }) }, { additionalProperties: false }),
  "InlineResultHookSource": Type.Object({ "sourceReceiptId": Type.Ref('Id'), "sourceReceiptDigest": Type.Ref('Digest'), "evaluator": Type.Ref('BindingRef'), "authorizationRef": Type.Ref('Id') }, { additionalProperties: false }),
  "InvocationAdmission": Type.Object({ "requestId": Type.Ref('Id'), "runId": Type.Ref('Id'), "targetActionId": Type.Union([Type.Ref('Id'), Type.Null()]), "baseRevision": Type.Ref('UInt53'), "bindingId": Type.Ref('Id'), "writerEpoch": Type.Ref('UInt53'), "invocationId": Type.Ref('Id'), "deadline": Type.Ref('Timestamp'), "queryAllowance": Type.Ref('UInt53') }, { additionalProperties: false }),
  "LoopTransition": Type.Object({ "expectedRevision": Type.Ref('UInt53'), "continuation": Type.Ref('VersionedState'), "consumeSignals": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "actions": Type.Array(Type.Ref('PreparedAction'), { maxItems: 10000 }), "next": Type.Ref('NextStep'), "conversation": Type.Optional(Type.Array(Type.Ref('ConversationContribution'), { maxItems: 10000 })) }, { additionalProperties: false }),
  "Money": Type.Object({ "currency": Type.String(), "scale": Type.Literal(6), "units": Type.String() }, { additionalProperties: false }),
  "NextStep": Type.Union([Type.Object({ "kind": Type.Literal('continue') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('wait'), "condition": Type.Ref('WaitCondition') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('complete'), "output": Type.Ref('DataRef'), "references": Type.Array(Type.Ref('RetentionRef'), { maxItems: 10000 }) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('fail'), "error": Type.Ref('RuntimeError') }, { additionalProperties: false })]),
  "OutboxClaim": Type.Object({ "eventId": Type.Ref('Id'), "ownerId": Type.Ref('Id'), "epoch": Type.Ref('UInt53'), "until": Type.Ref('Timestamp') }, { additionalProperties: false }),
  "OutboxRecord": Type.Object({ "eventId": Type.Ref('Id'), "sourceAuthorityId": Type.Ref('Id'), "sourceCommitId": Type.Ref('Id'), "destination": Type.Ref('Id'), "typeId": Type.Ref('TypeId'), "payload": Type.Ref('DataRef'), "fingerprint": Type.Ref('Digest'), "delivery": Type.Union([Type.Literal('pending'), Type.Literal('claimed'), Type.Literal('acked'), Type.Literal('dead')]), "attempts": Type.Ref('UInt53'), "nextAttemptAt": Type.Ref('Timestamp'), "claim": Type.Union([Type.Object({ "ownerId": Type.Ref('Id'), "epoch": Type.Ref('UInt53'), "until": Type.Ref('Timestamp') }, { additionalProperties: false }), Type.Null()]), "ackRef": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false }),
  "OwnerRef": Type.Object({ "kind": Type.Union([Type.Literal('run'), Type.Literal('action'), Type.Literal('job'), Type.Literal('reconciliation')]), "id": Type.Ref('Id') }, { additionalProperties: false }),
  "PreparedAction": Type.Union([Type.Object({ "key": Type.String(), "target": Type.Ref('BindingRef'), "method": Type.String(), "input": Type.Ref('DataRef'), "dependencies": Type.Array(Type.Ref('ActionDependency'), { maxItems: 10000 }), "retry": Type.Ref('RetryPolicy'), "obligation": Type.Literal('mandatory'), "deadline": Type.Ref('Timestamp'), "resultSchema": Type.Ref('SchemaRef'), "references": Type.Array(Type.Ref('RetentionRef'), { maxItems: 10000 }), "presentation": Type.Optional(Type.Object({ "audience": Type.Literal('conversation'), "turnId": Type.Ref('Id'), "kind": Type.Union([Type.Literal('tool'), Type.Literal('assistant-stream')]) }, { additionalProperties: false })), "intentFingerprint": Type.Ref('Digest') }, { additionalProperties: false }), Type.Object({ "key": Type.String(), "target": Type.Ref('BindingRef'), "method": Type.String(), "input": Type.Ref('DataRef'), "dependencies": Type.Array(Type.Ref('ActionDependency'), { maxItems: 10000 }), "retry": Type.Ref('RetryPolicy'), "obligation": Type.Literal('detached'), "deadline": Type.Ref('Timestamp'), "resultSchema": Type.Ref('SchemaRef'), "references": Type.Array(Type.Ref('RetentionRef'), { maxItems: 10000 }), "detachedOwner": Type.Object({ "jobId": Type.Ref('Id'), "authorityId": Type.Ref('Id'), "acceptanceRef": Type.Ref('DataRef') }, { additionalProperties: false }), "presentation": Type.Optional(Type.Object({ "audience": Type.Literal('conversation'), "turnId": Type.Ref('Id'), "kind": Type.Union([Type.Literal('tool'), Type.Literal('assistant-stream')]) }, { additionalProperties: false })), "intentFingerprint": Type.Ref('Digest') }, { additionalProperties: false })]),
  "ProbeActionResultRequest": Type.Object({ "actionId": Type.Ref('Id'), "sourceReceiptId": Type.Ref('Id') }, { additionalProperties: false }),
  "ProbeActionResultResult": Type.Union([Type.Ref('ActionVisibilityValue'), Type.Null()]),
  "Provenance": Type.Object({ "sourceRefs": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "producer": Type.Ref('BindingRef'), "trustLabels": Type.Array(Type.String(), { maxItems: 10000 }) }, { additionalProperties: false }),
  "ProviderTransition": Type.Object({ "expectedProviderRevision": Type.Ref('UInt53'), "continuation": Type.Ref('VersionedState'), "consumeSignals": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "children": Type.Array(Type.Ref('PreparedAction'), { maxItems: 10000 }), "next": Type.Ref('NextStep') }, { additionalProperties: false }),
  "PruneRecordVersionsRequest": Type.Object({ "requestId": Type.Ref('Id'), "authority": Type.Ref('StateAuthorityRef'), "retentionPolicyRef": Type.Ref('Id'), "versions": Type.Array(Type.Object({ "recordId": Type.Ref('Id'), "recordRevision": Type.Ref('UInt53') }, { additionalProperties: false }), { maxItems: 10000 }) }, { additionalProperties: false }),
  "PruneRecordVersionsResult": Type.Object({ "pruneId": Type.Ref('Id'), "proofCommitId": Type.Ref('Id'), "pruned": Type.Array(Type.Object({ "recordId": Type.Ref('Id'), "recordRevision": Type.Ref('UInt53') }, { additionalProperties: false }), { maxItems: 10000 }), "retained": Type.Array(Type.Object({ "recordId": Type.Ref('Id'), "recordRevision": Type.Ref('UInt53') }, { additionalProperties: false }), { maxItems: 10000 }) }, { additionalProperties: false }),
  "PublishActionResultResult": Type.Object({ "state": Type.Literal('ready'), "viewId": Type.Ref('Id'), "commitId": Type.Ref('Id') }, { additionalProperties: false }),
  "QueryAdmission": Type.Object({ "requestId": Type.Ref('Id'), "invocationId": Type.Ref('Id'), "queryFingerprint": Type.Ref('Digest') }, { additionalProperties: false }),
  "QueryUsageFlush": Type.Object({ "grantId": Type.Ref('Id'), "invocationId": Type.Ref('Id'), "writerEpoch": Type.Ref('UInt53'), "cumulativeCount": Type.Ref('UInt53') }, { additionalProperties: false }),
  "ReadGuard": Type.Object({ "recordId": Type.Ref('Id'), "expectedRecordRevision": Type.Union([Type.Ref('UInt53'), Type.Null()]) }, { additionalProperties: false }),
  "Receipt": Type.Object({ "receiptId": Type.Ref('Id'), "actionId": Type.Ref('Id'), "attemptId": Type.Ref('Id'), "bindingId": Type.Ref('Id'), "inputDigest": Type.Ref('Digest'), "outcome": Type.Union([Type.Literal('succeeded'), Type.Literal('failed'), Type.Literal('cancelled'), Type.Literal('unknown_effect')]), "result": Type.Optional(Type.Ref('DataRef')), "error": Type.Optional(Type.Ref('RuntimeError')), "externalRequests": Type.Array(Type.Ref('ExternalRequestRef'), { maxItems: 10000 }), "usageRefs": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "references": Type.Array(Type.Ref('RetentionRef'), { maxItems: 10000 }), "provenance": Type.Ref('Provenance'), "completedAt": Type.Ref('Timestamp') }, { additionalProperties: false }),
  "ReceiptIntakeRequest": Type.Object({ "intakeId": Type.Ref('Id'), "receipt": Type.Ref('Receipt'), "usage": Type.Array(Type.Ref('UsageFact'), { maxItems: 10000 }), "evidence": Type.Array(Type.Ref('DataRef'), { maxItems: 10000 }), "sourceAuthorizationRef": Type.Ref('Id'), "queryUsage": Type.Union([Type.Ref('QueryUsageFlush'), Type.Null()]), "resultHandling": Type.Ref('ReceiptResultHandling') }, { additionalProperties: false }),
  "ReceiptIntakeResult": Type.Object({ "intakeId": Type.Ref('Id'), "state": Type.Union([Type.Literal('accepted'), Type.Literal('duplicate'), Type.Literal('conflicting')]) }, { additionalProperties: false }),
  "ReceiptResultHandling": Type.Union([Type.Object({ "kind": Type.Literal('no-hook') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('inline-pure'), "evaluation": Type.Ref('InlineResultHookEvaluation') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('staged') }, { additionalProperties: false })]),
  "RequestIdentity": Type.Object({ "system": Type.String(), "aghRequestId": Type.Ref('Id'), "idempotencyKey": Type.Union([Type.String(), Type.Null()]), "requestDigest": Type.Ref('Digest') }, { additionalProperties: false }),
  "ResultHookPlan": Type.Object({ "event": Type.Literal('tool_result'), "registrationDigest": Type.Ref('Digest'), "registrations": Type.Array(Type.Ref('HookRegistrationSnapshot'), { minItems: 1, maxItems: 10000 }), "inlinePureAllowed": Type.Boolean() }, { additionalProperties: false }),
  "ResultVisibilityCommit": Type.Object({ "commitId": Type.Ref('Id'), "sourceReceiptId": Type.Ref('Id'), "expectedVisibilityRevision": Type.Ref('UInt53'), "stageActionId": Type.Ref('Id'), "hookResultSet": Type.Ref('HookResultSet') }, { additionalProperties: false }),
  "RetentionRef": Type.Object({ "kind": Type.Union([Type.Literal('blob'), Type.Literal('artifact'), Type.Literal('domain-record'), Type.Literal('package'), Type.Literal('schema'), Type.Literal('codec')]), "authorityId": Type.Ref('Id'), "resourceId": Type.Ref('Id'), "version": Type.String(), "digest": Type.Ref('Digest'), "pinId": Type.Ref('Id') }, { additionalProperties: false }),
  "RetryAdvice": Type.Union([Type.Object({ "kind": Type.Literal('never') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('retry_read'), "notBefore": Type.Optional(Type.Ref('Timestamp')) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('retry_same_action'), "notBefore": Type.Optional(Type.Ref('Timestamp')) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('reconcile'), "ownerRef": Type.Ref('OwnerRef') }, { additionalProperties: false })]),
  "RetryPolicy": Type.Object({ "mode": Type.Union([Type.Literal('never'), Type.Literal('before_dispatch'), Type.Literal('idempotent'), Type.Literal('reconcile_first')]), "maxAttempts": Type.Ref('UInt53'), "backoffMs": Type.Array(Type.Ref('UInt53'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "RunAdmission": Type.Object({ "ticketId": Type.Ref('Id'), "fingerprint": Type.Ref('Digest'), "releaseSetId": Type.Ref('Id'), "bindingId": Type.Ref('Id'), "packagePinReceipt": Type.Ref('DataRef'), "runId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "lane": Type.String(), "workspaceId": Type.Ref('Id'), "input": Type.Ref('DataRef'), "admittedAt": Type.Ref('Timestamp'), "deadline": Type.Ref('Timestamp'), "conversation": Type.Union([Type.Ref('ConversationAdmission'), Type.Null()]) }, { additionalProperties: false }),
  "RuntimeControlCommand": Type.Union([Type.Object({ "kind": Type.Literal('prepare_authorization'), "actionId": Type.Ref('Id'), "expectedActionRevision": Type.Ref('UInt53'), "preparation": Type.Ref('AuthorizationPreparation') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('authorize_action'), "actionId": Type.Ref('Id'), "expectedActionRevision": Type.Ref('UInt53'), "decision": Type.Literal('allow'), "decisionRef": Type.Ref('DataRef'), "interactionId": Type.Union([Type.Ref('Id'), Type.Null()]), "validUntil": Type.Ref('Timestamp'), "hookResults": Type.Optional(Type.Array(Type.Ref('HookResultSet'), { maxItems: 10000 })), "approvalTaintAck": Type.Optional(Type.Ref('ApprovalTaintAck')) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('authorize_action'), "actionId": Type.Ref('Id'), "expectedActionRevision": Type.Ref('UInt53'), "decision": Type.Union([Type.Literal('ask'), Type.Literal('deny')]), "decisionRef": Type.Ref('DataRef'), "interactionId": Type.Union([Type.Ref('Id'), Type.Null()]), "validUntil": Type.Ref('Timestamp'), "hookResults": Type.Optional(Type.Array(Type.Ref('HookResultSet'), { maxItems: 10000 })) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('allocate_attempt'), "actionId": Type.Ref('Id'), "expectedActionRevision": Type.Ref('UInt53'), "attemptId": Type.Ref('Id'), "requestIdentity": Type.Ref('RequestIdentity'), "authorizationRef": Type.Ref('Id'), "reservationRefs": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "deadline": Type.Ref('Timestamp') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('start_composite'), "actionId": Type.Ref('Id'), "expectedActionRevision": Type.Ref('UInt53'), "attemptId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('settle_undispatched'), "actionId": Type.Ref('Id'), "expectedActionRevision": Type.Ref('UInt53'), "outcome": Type.Union([Type.Literal('failed'), Type.Literal('cancelled')]), "error": Type.Ref('RuntimeError') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('begin_drain'), "target": Type.Object({ "runId": Type.Ref('Id'), "actionId": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false }), "reason": Type.Ref('RuntimeError') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('finalize_composite'), "actionId": Type.Ref('Id'), "expectedProviderRevision": Type.Ref('UInt53'), "outcome": Type.Union([Type.Literal('failed'), Type.Literal('cancelled')]), "error": Type.Ref('RuntimeError'), "ownerRefs": Type.Array(Type.Ref('OwnerRef'), { maxItems: 10000 }) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('mark_running'), "attemptId": Type.Ref('Id'), "expectedAttemptRevision": Type.Ref('UInt53'), "externalRequests": Type.Array(Type.Ref('ExternalRequestRef'), { maxItems: 10000 }) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('mark_unknown'), "attemptId": Type.Ref('Id'), "expectedAttemptRevision": Type.Ref('UInt53'), "evidence": Type.Array(Type.Ref('DataRef'), { maxItems: 10000 }), "reconciliationOwnerRef": Type.Ref('OwnerRef'), "reason": Type.String() }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('resolve_action'), "actionId": Type.Ref('Id'), "expectedActionRevision": Type.Ref('UInt53'), "selectedReceiptId": Type.Union([Type.Ref('Id'), Type.Null()]), "evidence": Type.Array(Type.Ref('DataRef'), { maxItems: 10000 }), "state": Type.Union([Type.Literal('unresolved'), Type.Literal('resolved'), Type.Literal('conflicting')]), "ownerRef": Type.Ref('OwnerRef'), "nextCheckAt": Type.Union([Type.Ref('Timestamp'), Type.Null()]) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('cancel_run'), "runId": Type.Ref('Id'), "reason": Type.String(), "requestedBy": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('finalize_run'), "runId": Type.Ref('Id'), "expectedRunRevision": Type.Ref('UInt53'), "outcome": Type.Union([Type.Literal('failed'), Type.Literal('cancelled')]), "unknownActionIds": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "ownerRefs": Type.Array(Type.Ref('OwnerRef'), { maxItems: 10000 }) }, { additionalProperties: false })]),
  "RuntimeError": Type.Object({ "code": Type.Ref('RuntimeErrorCode'), "detailCode": Type.String(), "message": Type.String(), "retryAdvice": Type.Ref('RetryAdvice'), "diagnosticId": Type.Ref('Id'), "safeDetail": Type.Optional(JsonValue) }, { additionalProperties: false }),
  "RuntimeErrorCode": Type.Union([Type.Literal('invalid_input'), Type.Literal('denied'), Type.Literal('incompatible'), Type.Literal('quota'), Type.Literal('cancelled'), Type.Literal('timeout'), Type.Literal('retryable'), Type.Literal('unknown_effect'), Type.Literal('conflict'), Type.Literal('internal')]),
  "SchemaRef": Type.Object({ "typeId": Type.Ref('TypeId'), "revision": Type.Ref('UInt53'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "ScopeRef": Type.Union([Type.Object({ "installationId": Type.Ref('Id'), "kind": Type.Literal('installation') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "kind": Type.Literal('runtime') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "kind": Type.Literal('workspace') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "kind": Type.Literal('session') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "runId": Type.Ref('Id'), "kind": Type.Literal('run') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "runId": Type.Ref('Id'), "kind": Type.Literal('action'), "actionId": Type.Ref('Id') }, { additionalProperties: false })]),
  "SignalDelivery": Type.Object({ "intakeId": Type.Ref('Id'), "sourceAuthority": Type.Ref('StateAuthorityRef'), "sourceEventId": Type.Ref('Id'), "consumerId": Type.Ref('Id'), "fingerprint": Type.Ref('Digest'), "sourceAuthorizationRef": Type.Ref('Id'), "sourceKind": Type.Union([Type.Literal('domain'), Type.Literal('ingress'), Type.Literal('timer')]), "event": Type.Ref('DomainEvent'), "target": Type.Object({ "runId": Type.Ref('Id'), "targetActionId": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false }), "mappingRef": Type.Ref('Id') }, { additionalProperties: false }),
  "SignalIntakeReceipt": Type.Object({ "intakeId": Type.Ref('Id'), "state": Type.Union([Type.Literal('accepted'), Type.Literal('duplicate'), Type.Literal('conflicting')]), "appliedCommitId": Type.Ref('Id'), "signalIds": Type.Array(Type.Ref('Id'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "SnapshotRef": Type.Object({ "snapshotId": Type.Ref('Id'), "authority": Type.Ref('StateAuthorityRef'), "sessionId": Type.Ref('Id'), "throughSeq": Type.Ref('UInt53'), "headDigest": Type.Union([Type.Ref('Digest'), Type.Null()]), "expiresAt": Type.Ref('Timestamp') }, { additionalProperties: false }),
  "StateAuthorityRef": Type.Object({ "authorityId": Type.Ref('Id'), "tenantId": Type.Ref('Id'), "authorityEpoch": Type.Ref('UInt53') }, { additionalProperties: false }),
  "StateCommitReceipt": Type.Object({ "commitId": Type.Ref('Id'), "transactionFingerprint": Type.Ref('Digest'), "sessionId": Type.Ref('Id'), "firstSeq": Type.Ref('UInt53'), "lastSeq": Type.Ref('UInt53'), "headDigest": Type.Ref('Digest'), "runRevision": Type.Ref('UInt53'), "actionIds": Type.Array(Type.Object({ "key": Type.String(), "actionId": Type.Ref('Id') }, { additionalProperties: false }), { maxItems: 10000 }) }, { additionalProperties: false }),
  "StateLeaseRequest": Type.Object({ "requestId": Type.Ref('Id'), "authority": Type.Ref('StateAuthorityRef'), "sessionId": Type.Ref('Id'), "writerId": Type.Ref('Id'), "operation": Type.Union([Type.Literal('acquire'), Type.Literal('renew'), Type.Literal('release'), Type.Literal('reclaim')]), "expectedWriterEpoch": Type.Union([Type.Ref('UInt53'), Type.Null()]), "expectedLastSeq": Type.Ref('UInt53'), "ttlMs": Type.Ref('UInt53') }, { additionalProperties: false }),
  "StateLeaseResult": Type.Object({ "claim": Type.Union([Type.Ref('WriterClaim'), Type.Null()]), "lastWriterEpoch": Type.Ref('UInt53') }, { additionalProperties: false }),
  "StateOpenRequest": Type.Union([Type.Object({ "requestId": Type.Ref('Id'), "authority": Type.Ref('StateAuthorityRef'), "sessionId": Type.Ref('Id'), "mode": Type.Literal('read'), "writerId": Type.Null(), "ttlMs": Type.Null() }, { additionalProperties: false }), Type.Object({ "requestId": Type.Ref('Id'), "authority": Type.Ref('StateAuthorityRef'), "sessionId": Type.Ref('Id'), "mode": Type.Literal('write'), "writerId": Type.Ref('Id'), "ttlMs": Type.Ref('UInt53') }, { additionalProperties: false })]),
  "StateOpenResult": Type.Object({ "snapshot": Type.Ref('SnapshotRef'), "formatVersion": Type.Ref('UInt53'), "minReader": Type.Ref('UInt53'), "claim": Type.Union([Type.Ref('WriterClaim'), Type.Null()]), "parent": Type.Union([Type.Object({ "sessionId": Type.Ref('Id'), "boundarySeq": Type.Ref('UInt53'), "boundaryDigest": Type.Union([Type.Ref('Digest'), Type.Null()]) }, { additionalProperties: false }), Type.Null()]) }, { additionalProperties: false }),
  "Timestamp": Type.String({ pattern: "Z$", format: "date-time" }),
  "TypeId": Type.String({ minLength: 1, maxLength: 256, pattern: "^[a-z][a-z0-9.-]*/[a-zA-Z0-9._/-]+@[1-9][0-9]*$" }),
  "UInt53": Type.Integer({ minimum: 0, maximum: 9007199254740991 }),
  "UsageFact": Type.Object({ "usageId": Type.Ref('Id'), "originKey": Type.String(), "actionId": Type.Ref('Id'), "attemptId": Type.Ref('Id'), "source": Type.Ref('BindingRef'), "dimensions": Type.Ref('DataRef'), "externalRequest": Type.Ref('ExternalRequestRef'), "observedAt": Type.Ref('Timestamp'), "certainty": Type.Union([Type.Literal('measured'), Type.Literal('estimated'), Type.Literal('unknown')]) }, { additionalProperties: false }),
  "VersionedState": Type.Object({ "namespace": Type.String(), "codecVersion": Type.String(), "data": Type.Ref('DataRef'), "provenance": Type.Ref('Provenance'), "createdAt": Type.Ref('Timestamp'), "references": Type.Array(Type.Ref('RetentionRef'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "WaitClause": Type.Union([Type.Object({ "kind": Type.Literal('actions'), "mode": Type.Union([Type.Literal('any'), Type.Literal('all')]), "actions": Type.Array(Type.Ref('ActionRef'), { minItems: 1, maxItems: 10000 }), "readyWhen": Type.Union([Type.Literal('receipt'), Type.Literal('resolved')]) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('interaction'), "interactionId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('signals'), "typeIds": Type.Array(Type.Ref('TypeId'), { minItems: 1, maxItems: 10000 }), "afterSeq": Type.Ref('UInt53') }, { additionalProperties: false })]),
  "WaitCondition": Type.Union([Type.Object({ "anyOf": Type.Array(Type.Ref('WaitClause'), { minItems: 1, maxItems: 10000 }), "deadline": Type.Optional(Type.Ref('Timestamp')) }, { additionalProperties: false }), Type.Object({ "anyOf": Type.Array(Type.Ref('WaitClause'), { minItems: 0, maxItems: 10000 }), "deadline": Type.Ref('Timestamp') }, { additionalProperties: false })]),
  "WriterClaim": Type.Object({ "scopeId": Type.Ref('Id'), "writerId": Type.Ref('Id'), "writerEpoch": Type.Ref('UInt53'), "leaseUntil": Type.Ref('Timestamp'), "authorityEpoch": Type.Ref('UInt53') }, { additionalProperties: false }),
})

export const AckOutboxRequest = RuntimePrototype.Import('AckOutboxRequest')
export type AckOutboxRequest = Static<typeof AckOutboxRequest>
export const AckOutboxResult = RuntimePrototype.Import('AckOutboxResult')
export type AckOutboxResult = Static<typeof AckOutboxResult>
export const ActionDependency = RuntimePrototype.Import('ActionDependency')
export type ActionDependency = Static<typeof ActionDependency>
export const ActionRef = RuntimePrototype.Import('ActionRef')
export type ActionRef = Static<typeof ActionRef>
export const ActionResultView = RuntimePrototype.Import('ActionResultView')
export type ActionResultView = Static<typeof ActionResultView>
export const ActionVisibilityValue = RuntimePrototype.Import('ActionVisibilityValue')
export type ActionVisibilityValue = Static<typeof ActionVisibilityValue>
export const AdmissionProbe = RuntimePrototype.Import('AdmissionProbe')
export type AdmissionProbe = Static<typeof AdmissionProbe>
export const AdmitInvocationResult = RuntimePrototype.Import('AdmitInvocationResult')
export type AdmitInvocationResult = Static<typeof AdmitInvocationResult>
export const AdmitQueryResult = RuntimePrototype.Import('AdmitQueryResult')
export type AdmitQueryResult = Static<typeof AdmitQueryResult>
export const AdvanceProviderRequest = RuntimePrototype.Import('AdvanceProviderRequest')
export type AdvanceProviderRequest = Static<typeof AdvanceProviderRequest>
export const AdvanceRunRequest = RuntimePrototype.Import('AdvanceRunRequest')
export type AdvanceRunRequest = Static<typeof AdvanceRunRequest>
export const ApprovalRequest = RuntimePrototype.Import('ApprovalRequest')
export type ApprovalRequest = Static<typeof ApprovalRequest>
export const ApprovalTaintAck = RuntimePrototype.Import('ApprovalTaintAck')
export type ApprovalTaintAck = Static<typeof ApprovalTaintAck>
export const AuthorizationPreparation = RuntimePrototype.Import('AuthorizationPreparation')
export type AuthorizationPreparation = Static<typeof AuthorizationPreparation>
export const BindingRef = RuntimePrototype.Import('BindingRef')
export type BindingRef = Static<typeof BindingRef>
export const BlobRef = RuntimePrototype.Import('BlobRef')
export type BlobRef = Static<typeof BlobRef>
export const CallContextWire = RuntimePrototype.Import('CallContextWire')
export type CallContextWire = Static<typeof CallContextWire>
export const ClaimOutboxRequest = RuntimePrototype.Import('ClaimOutboxRequest')
export type ClaimOutboxRequest = Static<typeof ClaimOutboxRequest>
export const ClaimOutboxResult = RuntimePrototype.Import('ClaimOutboxResult')
export type ClaimOutboxResult = Static<typeof ClaimOutboxResult>
export const CloseInvocationRequest = RuntimePrototype.Import('CloseInvocationRequest')
export type CloseInvocationRequest = Static<typeof CloseInvocationRequest>
export const CloseInvocationResult = RuntimePrototype.Import('CloseInvocationResult')
export type CloseInvocationResult = Static<typeof CloseInvocationResult>
export const CommitControlRequest = RuntimePrototype.Import('CommitControlRequest')
export type CommitControlRequest = Static<typeof CommitControlRequest>
export const CommitGuard = RuntimePrototype.Import('CommitGuard')
export type CommitGuard = Static<typeof CommitGuard>
export const ConversationAdmission = RuntimePrototype.Import('ConversationAdmission')
export type ConversationAdmission = Static<typeof ConversationAdmission>
export const ConversationContribution = RuntimePrototype.Import('ConversationContribution')
export type ConversationContribution = Static<typeof ConversationContribution>
export const DataRef = RuntimePrototype.Import('DataRef')
export type DataRef = Static<typeof DataRef>
export const Digest = RuntimePrototype.Import('Digest')
export type Digest = Static<typeof Digest>
export const DispatchAdmissionProbe = RuntimePrototype.Import('DispatchAdmissionProbe')
export type DispatchAdmissionProbe = Static<typeof DispatchAdmissionProbe>
export const DispatchAdmissionRequest = RuntimePrototype.Import('DispatchAdmissionRequest')
export type DispatchAdmissionRequest = Static<typeof DispatchAdmissionRequest>
export const DispatchAdmissionResult = RuntimePrototype.Import('DispatchAdmissionResult')
export type DispatchAdmissionResult = Static<typeof DispatchAdmissionResult>
export const DispatchAtomicDomain = RuntimePrototype.Import('DispatchAtomicDomain')
export type DispatchAtomicDomain = Static<typeof DispatchAtomicDomain>
export const DispatchBudgetPlan = RuntimePrototype.Import('DispatchBudgetPlan')
export type DispatchBudgetPlan = Static<typeof DispatchBudgetPlan>
export const DomainEvent = RuntimePrototype.Import('DomainEvent')
export type DomainEvent = Static<typeof DomainEvent>
export const DomainReference = RuntimePrototype.Import('DomainReference')
export type DomainReference = Static<typeof DomainReference>
export const ExternalRequestRef = RuntimePrototype.Import('ExternalRequestRef')
export type ExternalRequestRef = Static<typeof ExternalRequestRef>
export const FailOutboxRequest = RuntimePrototype.Import('FailOutboxRequest')
export type FailOutboxRequest = Static<typeof FailOutboxRequest>
export const FailOutboxResult = RuntimePrototype.Import('FailOutboxResult')
export type FailOutboxResult = Static<typeof FailOutboxResult>
export const HookEventName = RuntimePrototype.Import('HookEventName')
export type HookEventName = Static<typeof HookEventName>
export const HookRegistrationSnapshot = RuntimePrototype.Import('HookRegistrationSnapshot')
export type HookRegistrationSnapshot = Static<typeof HookRegistrationSnapshot>
export const HookResultSet = RuntimePrototype.Import('HookResultSet')
export type HookResultSet = Static<typeof HookResultSet>
export const HookStageRequest = RuntimePrototype.Import('HookStageRequest')
export type HookStageRequest = Static<typeof HookStageRequest>
export const Id = RuntimePrototype.Import('Id')
export type Id = Static<typeof Id>
export const InlineResultHookEvaluation = RuntimePrototype.Import('InlineResultHookEvaluation')
export type InlineResultHookEvaluation = Static<typeof InlineResultHookEvaluation>
export const InlineResultHookSource = RuntimePrototype.Import('InlineResultHookSource')
export type InlineResultHookSource = Static<typeof InlineResultHookSource>
export const InvocationAdmission = RuntimePrototype.Import('InvocationAdmission')
export type InvocationAdmission = Static<typeof InvocationAdmission>
export const LoopTransition = RuntimePrototype.Import('LoopTransition')
export type LoopTransition = Static<typeof LoopTransition>
export const Money = RuntimePrototype.Import('Money')
export type Money = Static<typeof Money>
export const NextStep = RuntimePrototype.Import('NextStep')
export type NextStep = Static<typeof NextStep>
export const OutboxClaim = RuntimePrototype.Import('OutboxClaim')
export type OutboxClaim = Static<typeof OutboxClaim>
export const OutboxRecord = RuntimePrototype.Import('OutboxRecord')
export type OutboxRecord = Static<typeof OutboxRecord>
export const OwnerRef = RuntimePrototype.Import('OwnerRef')
export type OwnerRef = Static<typeof OwnerRef>
export const PreparedAction = RuntimePrototype.Import('PreparedAction')
export type PreparedAction = Static<typeof PreparedAction>
export const ProbeActionResultRequest = RuntimePrototype.Import('ProbeActionResultRequest')
export type ProbeActionResultRequest = Static<typeof ProbeActionResultRequest>
export const ProbeActionResultResult = RuntimePrototype.Import('ProbeActionResultResult')
export type ProbeActionResultResult = Static<typeof ProbeActionResultResult>
export const Provenance = RuntimePrototype.Import('Provenance')
export type Provenance = Static<typeof Provenance>
export const ProviderTransition = RuntimePrototype.Import('ProviderTransition')
export type ProviderTransition = Static<typeof ProviderTransition>
export const PruneRecordVersionsRequest = RuntimePrototype.Import('PruneRecordVersionsRequest')
export type PruneRecordVersionsRequest = Static<typeof PruneRecordVersionsRequest>
export const PruneRecordVersionsResult = RuntimePrototype.Import('PruneRecordVersionsResult')
export type PruneRecordVersionsResult = Static<typeof PruneRecordVersionsResult>
export const PublishActionResultResult = RuntimePrototype.Import('PublishActionResultResult')
export type PublishActionResultResult = Static<typeof PublishActionResultResult>
export const QueryAdmission = RuntimePrototype.Import('QueryAdmission')
export type QueryAdmission = Static<typeof QueryAdmission>
export const QueryUsageFlush = RuntimePrototype.Import('QueryUsageFlush')
export type QueryUsageFlush = Static<typeof QueryUsageFlush>
export const ReadGuard = RuntimePrototype.Import('ReadGuard')
export type ReadGuard = Static<typeof ReadGuard>
export const Receipt = RuntimePrototype.Import('Receipt')
export type Receipt = Static<typeof Receipt>
export const ReceiptIntakeRequest = RuntimePrototype.Import('ReceiptIntakeRequest')
export type ReceiptIntakeRequest = Static<typeof ReceiptIntakeRequest>
export const ReceiptIntakeResult = RuntimePrototype.Import('ReceiptIntakeResult')
export type ReceiptIntakeResult = Static<typeof ReceiptIntakeResult>
export const ReceiptResultHandling = RuntimePrototype.Import('ReceiptResultHandling')
export type ReceiptResultHandling = Static<typeof ReceiptResultHandling>
export const RequestIdentity = RuntimePrototype.Import('RequestIdentity')
export type RequestIdentity = Static<typeof RequestIdentity>
export const ResultHookPlan = RuntimePrototype.Import('ResultHookPlan')
export type ResultHookPlan = Static<typeof ResultHookPlan>
export const ResultVisibilityCommit = RuntimePrototype.Import('ResultVisibilityCommit')
export type ResultVisibilityCommit = Static<typeof ResultVisibilityCommit>
export const RetentionRef = RuntimePrototype.Import('RetentionRef')
export type RetentionRef = Static<typeof RetentionRef>
export const RetryAdvice = RuntimePrototype.Import('RetryAdvice')
export type RetryAdvice = Static<typeof RetryAdvice>
export const RetryPolicy = RuntimePrototype.Import('RetryPolicy')
export type RetryPolicy = Static<typeof RetryPolicy>
export const RunAdmission = RuntimePrototype.Import('RunAdmission')
export type RunAdmission = Static<typeof RunAdmission>
export const RuntimeControlCommand = RuntimePrototype.Import('RuntimeControlCommand')
export type RuntimeControlCommand = Static<typeof RuntimeControlCommand>
export const RuntimeError = RuntimePrototype.Import('RuntimeError')
export type RuntimeError = Static<typeof RuntimeError>
export const RuntimeErrorCode = RuntimePrototype.Import('RuntimeErrorCode')
export type RuntimeErrorCode = Static<typeof RuntimeErrorCode>
export const SchemaRef = RuntimePrototype.Import('SchemaRef')
export type SchemaRef = Static<typeof SchemaRef>
export const ScopeRef = RuntimePrototype.Import('ScopeRef')
export type ScopeRef = Static<typeof ScopeRef>
export const SignalDelivery = RuntimePrototype.Import('SignalDelivery')
export type SignalDelivery = Static<typeof SignalDelivery>
export const SignalIntakeReceipt = RuntimePrototype.Import('SignalIntakeReceipt')
export type SignalIntakeReceipt = Static<typeof SignalIntakeReceipt>
export const SnapshotRef = RuntimePrototype.Import('SnapshotRef')
export type SnapshotRef = Static<typeof SnapshotRef>
export const StateAuthorityRef = RuntimePrototype.Import('StateAuthorityRef')
export type StateAuthorityRef = Static<typeof StateAuthorityRef>
export const StateCommitReceipt = RuntimePrototype.Import('StateCommitReceipt')
export type StateCommitReceipt = Static<typeof StateCommitReceipt>
export const StateLeaseRequest = RuntimePrototype.Import('StateLeaseRequest')
export type StateLeaseRequest = Static<typeof StateLeaseRequest>
export const StateLeaseResult = RuntimePrototype.Import('StateLeaseResult')
export type StateLeaseResult = Static<typeof StateLeaseResult>
export const StateOpenRequest = RuntimePrototype.Import('StateOpenRequest')
export type StateOpenRequest = Static<typeof StateOpenRequest>
export const StateOpenResult = RuntimePrototype.Import('StateOpenResult')
export type StateOpenResult = Static<typeof StateOpenResult>
export const Timestamp = RuntimePrototype.Import('Timestamp')
export type Timestamp = Static<typeof Timestamp>
export const TypeId = RuntimePrototype.Import('TypeId')
export type TypeId = Static<typeof TypeId>
export const UInt53 = RuntimePrototype.Import('UInt53')
export type UInt53 = Static<typeof UInt53>
export const UsageFact = RuntimePrototype.Import('UsageFact')
export type UsageFact = Static<typeof UsageFact>
export const VersionedState = RuntimePrototype.Import('VersionedState')
export type VersionedState = Static<typeof VersionedState>
export const WaitClause = RuntimePrototype.Import('WaitClause')
export type WaitClause = Static<typeof WaitClause>
export const WaitCondition = RuntimePrototype.Import('WaitCondition')
export type WaitCondition = Static<typeof WaitCondition>
export const WriterClaim = RuntimePrototype.Import('WriterClaim')
export type WriterClaim = Static<typeof WriterClaim>
