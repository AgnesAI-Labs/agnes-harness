// generated from schema by tools/gen.ts — do not edit
import { Type, type Static } from '@sinclair/typebox'
import { FormatRegistry } from '@sinclair/typebox'

if (!FormatRegistry.Has('date-time')) FormatRegistry.Set('date-time', (value) => { const parts = value.split(/t/i); if (parts.length !== 2) return false; const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(parts[0] ?? ''); const time = /^(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)(z|([+-])(\d{2}):(\d{2}))$/i.exec(parts[1] ?? ''); if (!date || !time) return false; const year = Number(date[1]), month = Number(date[2]), day = Number(date[3]); const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0); const days = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; if (month < 1 || month > 12 || day < 1 || day > (days[month] ?? 0)) return false; const hour = Number(time[1]), minute = Number(time[2]), second = Number(time[3]); const offsetHour = Number(time[6] || 0), offsetMinute = Number(time[7] || 0); if (hour > 23 || minute > 59 || offsetHour > 23 || offsetMinute > 59) return false; if (second < 60) return true; const sign = time[5] === '-' ? -1 : 1; const utcMinute = minute - offsetMinute * sign; const utcHour = hour - offsetHour * sign - (utcMinute < 0 ? 1 : 0); return (utcHour === 23 || utcHour === -1) && (utcMinute === 59 || utcMinute === -1) && second < 61; })

export const JsonValue = Type.Recursive((This) => Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String(), Type.Array(This, { minItems: 0, maxItems: 10000 }), Type.Record(Type.String(), This)]))
export type JsonValue = Static<typeof JsonValue>

export const RuntimePublic7 = Type.Module({
  "Id": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }),
  "UInt53": Type.Integer({ minimum: 0, maximum: 9007199254740991 }),
  "Timestamp": Type.String({ pattern: "Z$", format: "date-time" }),
  "TypeId": Type.String({ minLength: 1, maxLength: 256, pattern: "^[a-z][a-z0-9.-]*/[a-zA-Z0-9._/-]+@[1-9][0-9]*$" }),
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
  "StateCommitReceipt": Type.Object({ "commitId": Type.Ref('Id'), "transactionFingerprint": Type.Ref('Digest'), "sessionId": Type.Ref('Id'), "firstSeq": Type.Ref('UInt53'), "lastSeq": Type.Ref('UInt53'), "headDigest": Type.Ref('Digest'), "runRevision": Type.Ref('UInt53'), "actionIds": Type.Array(Type.Object({ "key": Type.String(), "actionId": Type.Ref('Id') }, { additionalProperties: false }), { maxItems: 10000 }) }, { additionalProperties: false }),
  "StateAuthorityRef": Type.Object({ "authorityId": Type.Ref('Id'), "tenantId": Type.Ref('Id'), "authorityEpoch": Type.Ref('UInt53') }, { additionalProperties: false }),
  "ReadGuard": Type.Object({ "recordId": Type.Ref('Id'), "expectedRecordRevision": Type.Union([Type.Ref('UInt53'), Type.Null()]) }, { additionalProperties: false }),
  "VersionedState": Type.Object({ "namespace": Type.String(), "codecVersion": Type.String(), "data": Type.Ref('DataRef'), "provenance": Type.Ref('Provenance'), "createdAt": Type.Ref('Timestamp'), "references": Type.Array(Type.Ref('RetentionRef'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "RetryPolicy": Type.Object({ "mode": Type.Union([Type.Literal('never'), Type.Literal('before_dispatch'), Type.Literal('idempotent'), Type.Literal('reconcile_first')]), "maxAttempts": Type.Ref('UInt53'), "backoffMs": Type.Array(Type.Ref('UInt53'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "PreparedAction": Type.Union([Type.Object({ "key": Type.String(), "target": Type.Ref('BindingRef'), "method": Type.String(), "input": Type.Ref('DataRef'), "dependencies": Type.Array(Type.Ref('ActionDependency'), { maxItems: 10000 }), "retry": Type.Ref('RetryPolicy'), "obligation": Type.Literal('mandatory'), "deadline": Type.Ref('Timestamp'), "resultSchema": Type.Ref('SchemaRef'), "references": Type.Array(Type.Ref('RetentionRef'), { maxItems: 10000 }), "presentation": Type.Optional(Type.Object({ "audience": Type.Literal('conversation'), "turnId": Type.Ref('Id'), "kind": Type.Union([Type.Literal('tool'), Type.Literal('assistant-stream')]) }, { additionalProperties: false })), "intentFingerprint": Type.Ref('Digest') }, { additionalProperties: false }), Type.Object({ "key": Type.String(), "target": Type.Ref('BindingRef'), "method": Type.String(), "input": Type.Ref('DataRef'), "dependencies": Type.Array(Type.Ref('ActionDependency'), { maxItems: 10000 }), "retry": Type.Ref('RetryPolicy'), "obligation": Type.Literal('detached'), "deadline": Type.Ref('Timestamp'), "resultSchema": Type.Ref('SchemaRef'), "references": Type.Array(Type.Ref('RetentionRef'), { maxItems: 10000 }), "detachedOwner": Type.Object({ "jobId": Type.Ref('Id'), "authorityId": Type.Ref('Id'), "acceptanceRef": Type.Ref('DataRef') }, { additionalProperties: false }), "presentation": Type.Optional(Type.Object({ "audience": Type.Literal('conversation'), "turnId": Type.Ref('Id'), "kind": Type.Union([Type.Literal('tool'), Type.Literal('assistant-stream')]) }, { additionalProperties: false })), "intentFingerprint": Type.Ref('Digest') }, { additionalProperties: false })]),
  "WaitClause": Type.Union([Type.Object({ "kind": Type.Literal('actions'), "mode": Type.Union([Type.Literal('any'), Type.Literal('all')]), "actions": Type.Array(Type.Ref('ActionRef'), { minItems: 1, maxItems: 10000 }), "readyWhen": Type.Union([Type.Literal('receipt'), Type.Literal('resolved')]) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('interaction'), "interactionId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('signals'), "typeIds": Type.Array(Type.Ref('TypeId'), { minItems: 1, maxItems: 10000 }), "afterSeq": Type.Ref('UInt53') }, { additionalProperties: false })]),
  "WaitCondition": Type.Union([Type.Object({ "anyOf": Type.Array(Type.Ref('WaitClause'), { minItems: 1, maxItems: 10000 }), "deadline": Type.Optional(Type.Ref('Timestamp')) }, { additionalProperties: false }), Type.Object({ "anyOf": Type.Array(Type.Ref('WaitClause'), { minItems: 0, maxItems: 10000 }), "deadline": Type.Ref('Timestamp') }, { additionalProperties: false })]),
  "ScopeRef": Type.Union([Type.Object({ "installationId": Type.Ref('Id'), "kind": Type.Literal('installation') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "kind": Type.Literal('runtime') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "kind": Type.Literal('workspace') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "kind": Type.Literal('session') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "runId": Type.Ref('Id'), "kind": Type.Literal('run') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "runId": Type.Ref('Id'), "kind": Type.Literal('action'), "actionId": Type.Ref('Id') }, { additionalProperties: false })]),
  "DomainReference": Type.Object({ "authorityId": Type.Ref('Id'), "recordId": Type.Ref('Id'), "recordRevision": Type.Ref('UInt53'), "schema": Type.Ref('SchemaRef'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "CallContextWire": Type.Object({ "principalRef": Type.Ref('Id'), "scope": Type.Ref('ScopeRef'), "bindingId": Type.Ref('Id'), "invocationId": Type.Ref('Id'), "deadline": Type.Ref('Timestamp'), "traceRef": Type.Ref('Id'), "authorizationRef": Type.Ref('Id') }, { additionalProperties: false }),
  "RequestIdentity": Type.Object({ "system": Type.String(), "aghRequestId": Type.Ref('Id'), "idempotencyKey": Type.Union([Type.String(), Type.Null()]), "requestDigest": Type.Ref('Digest') }, { additionalProperties: false }),
  "ConversationAdmission": Type.Object({ "turnId": Type.Ref('Id'), "inputMessageId": Type.Ref('Id'), "inputRef": Type.Ref('DataRef'), "kind": Type.Union([Type.Literal('prompt'), Type.Literal('follow-up')]) }, { additionalProperties: false }),
  "DispatchAdmissionResult": Type.Union([Type.Object({ "state": Type.Literal('admitted'), "commitId": Type.Ref('Id'), "authorizationId": Type.Ref('Id'), "attemptId": Type.Ref('Id'), "budgetReservationRefs": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "quotaReservationRefs": Type.Array(Type.Ref('Id'), { maxItems: 10000 }) }, { additionalProperties: false }), Type.Object({ "state": Type.Literal('rejected'), "commitId": Type.Ref('Id'), "reason": Type.Union([Type.Literal('denied'), Type.Literal('quota'), Type.Literal('expired'), Type.Literal('cancelled')]), "error": Type.Ref('RuntimeError') }, { additionalProperties: false })]),
  "HookRegistrationSnapshot": Type.Object({ "registrationId": Type.Ref('Id'), "provider": Type.Ref('BindingRef'), "codeDigest": Type.Ref('Digest'), "ordinal": Type.Ref('UInt53'), "mode": Type.Union([Type.Literal('parallel'), Type.Literal('waterfall'), Type.Literal('serial'), Type.Literal('emit')]), "category": Type.Union([Type.Literal('observe'), Type.Literal('transform'), Type.Literal('directive')]), "failPolicy": Type.Union([Type.Literal('open'), Type.Literal('closed')]), "replayOnResume": Type.Boolean(), "timeoutMs": Type.Ref('UInt53') }, { additionalProperties: false }),
  "Receipt": Type.Object({ "receiptId": Type.Ref('Id'), "actionId": Type.Ref('Id'), "attemptId": Type.Ref('Id'), "bindingId": Type.Ref('Id'), "inputDigest": Type.Ref('Digest'), "outcome": Type.Union([Type.Literal('succeeded'), Type.Literal('failed'), Type.Literal('cancelled'), Type.Literal('unknown_effect')]), "result": Type.Optional(Type.Ref('DataRef')), "error": Type.Optional(Type.Ref('RuntimeError')), "externalRequests": Type.Array(Type.Ref('ExternalRequestRef'), { maxItems: 10000 }), "usageRefs": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "references": Type.Array(Type.Ref('RetentionRef'), { maxItems: 10000 }), "provenance": Type.Ref('Provenance'), "completedAt": Type.Ref('Timestamp') }, { additionalProperties: false }),
  "UsageFact": Type.Object({ "usageId": Type.Ref('Id'), "originKey": Type.String(), "actionId": Type.Ref('Id'), "attemptId": Type.Ref('Id'), "source": Type.Ref('BindingRef'), "dimensions": Type.Ref('DataRef'), "externalRequest": Type.Ref('ExternalRequestRef'), "observedAt": Type.Ref('Timestamp'), "certainty": Type.Union([Type.Literal('measured'), Type.Literal('estimated'), Type.Literal('unknown')]) }, { additionalProperties: false }),
  "ResultHookPlan": Type.Object({ "event": Type.Literal('tool_result'), "registrationDigest": Type.Ref('Digest'), "registrations": Type.Array(Type.Ref('HookRegistrationSnapshot'), { minItems: 1, maxItems: 10000 }), "inlinePureAllowed": Type.Boolean() }, { additionalProperties: false }),
  "SnapshotRef": Type.Object({ "snapshotId": Type.Ref('Id'), "authority": Type.Ref('StateAuthorityRef'), "sessionId": Type.Ref('Id'), "throughSeq": Type.Ref('UInt53'), "headDigest": Type.Union([Type.Ref('Digest'), Type.Null()]), "expiresAt": Type.Ref('Timestamp') }, { additionalProperties: false }),
  "ConfigValue": Type.Object({ "schema": Type.Ref('SchemaRef'), "value": JsonValue }, { additionalProperties: false }),
  "TaintSnapshot": Type.Object({ "recordRevision": Type.Integer({ minimum: 1, maximum: 9007199254740991 }), "sourceSeq": Type.Ref('UInt53'), "clearedThroughSeq": Type.Ref('UInt53') }, { additionalProperties: false }),
  "SessionControlBoundary": Type.Object({ "kind": Type.Union([Type.Literal('immediate'), Type.Literal('next-request'), Type.Literal('next-turn'), Type.Literal('quiet-step'), Type.Literal('quiet-turn'), Type.Literal('next-run')]), "revision": Type.Ref('UInt53'), "runId": Type.Union([Type.Ref('Id'), Type.Null()]), "afterRequestId": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false }),
  "SessionParameterRevision": Type.Object({ "sessionId": Type.Ref('Id'), "revision": Type.Ref('UInt53'), "previousRevision": Type.Union([Type.Ref('UInt53'), Type.Null()]), "sourceRequestId": Type.Ref('Id'), "presetId": Type.Ref('Id'), "presetDigest": Type.Ref('Digest'), "parameters": Type.Ref('ConfigValue'), "effective": Type.Ref('SessionControlBoundary'), "committedAt": Type.Ref('Timestamp') }, { additionalProperties: false }),
  "RunState": Type.Union([Type.Literal('admitted'), Type.Literal('runnable'), Type.Literal('waiting'), Type.Literal('failing'), Type.Literal('cancelling'), Type.Literal('draining'), Type.Literal('succeeded'), Type.Literal('failed'), Type.Literal('cancelled'), Type.Literal('frozen'), Type.Literal('migrating'), Type.Literal('blocked_incompatible'), Type.Literal('blocked_integrity')]),
  "Cursor": Type.String(),
  "Signal": Type.Object({ "signalId": Type.Ref('Id'), "runId": Type.Ref('Id'), "targetActionId": Type.Union([Type.Ref('Id'), Type.Null()]), "seq": Type.Ref('UInt53'), "typeId": Type.Ref('TypeId'), "schema": Type.Ref('SchemaRef'), "source": Type.Ref('BindingRef'), "payload": Type.Ref('DataRef'), "createdAt": Type.Ref('Timestamp'), "causation": Type.Object({ "actionId": Type.Optional(Type.Ref('Id')), "attemptId": Type.Optional(Type.Ref('Id')), "interactionId": Type.Optional(Type.Ref('Id')), "externalEventId": Type.Optional(Type.Ref('Id')) }, { additionalProperties: false }) }, { additionalProperties: false }),
  "ReceiptRef": Type.Object({ "actionId": Type.Ref('Id'), "receiptId": Type.Ref('Id'), "outcome": Type.Union([Type.Literal('succeeded'), Type.Literal('failed'), Type.Literal('cancelled'), Type.Literal('unknown_effect')]) }, { additionalProperties: false }),
  "ActionTimebox": Type.Object({ "defaultTimeoutMs": Type.Ref('UInt53'), "maxDeadline": Type.Ref('Timestamp') }, { additionalProperties: false }),
  "PageSignal": Type.Object({ "items": Type.Array(Type.Ref('Signal'), { maxItems: 10000 }), "snapshot": Type.Ref('Id'), "nextCursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "complete": Type.Boolean() }, { additionalProperties: false }),
  "PageReceiptRef": Type.Object({ "items": Type.Array(Type.Ref('ReceiptRef'), { maxItems: 10000 }), "snapshot": Type.Ref('Id'), "nextCursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "complete": Type.Boolean() }, { additionalProperties: false }),
  "RunFrame": Type.Object({ "apiMajor": Type.Literal(1), "runId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "bindingId": Type.Ref('Id'), "revision": Type.Ref('UInt53'), "invocationId": Type.Ref('Id'), "writerEpoch": Type.Ref('UInt53'), "reason": Type.Union([Type.Literal('start'), Type.Literal('signal'), Type.Literal('continue'), Type.Literal('recovery'), Type.Literal('cancel')]), "input": Type.Ref('DataRef'), "continuation": Type.Union([Type.Ref('VersionedState'), Type.Null()]), "conversation": Type.Union([Type.Ref('ConversationAdmission'), Type.Null()]), "sessionParameters": Type.Object({ "value": Type.Ref('SessionParameterRevision'), "reference": Type.Ref('DomainReference') }, { additionalProperties: false }), "signals": Type.Ref('PageSignal'), "receipts": Type.Ref('PageReceiptRef'), "signalHighWater": Type.Ref('UInt53'), "snapshot": Type.Ref('Id'), "observedAt": Type.Ref('Timestamp'), "context": Type.Ref('CallContextWire'), "actionTimebox": Type.Ref('ActionTimebox') }, { additionalProperties: false }),
  "ActionFrame": Type.Object({ "actionId": Type.Ref('Id'), "parentActionId": Type.Union([Type.Ref('Id'), Type.Null()]), "runId": Type.Ref('Id'), "bindingId": Type.Ref('Id'), "method": Type.String(), "input": Type.Ref('DataRef'), "inputDigest": Type.Ref('Digest'), "attemptId": Type.Ref('Id'), "attemptNumber": Type.Ref('UInt53'), "invocationId": Type.Ref('Id'), "requestIdentity": Type.Union([Type.Ref('RequestIdentity'), Type.Null()]), "providerRevision": Type.Ref('UInt53'), "continuation": Type.Union([Type.Ref('VersionedState'), Type.Null()]), "signals": Type.Ref('PageSignal'), "receipts": Type.Ref('PageReceiptRef'), "signalHighWater": Type.Ref('UInt53'), "snapshot": Type.Ref('Id'), "observedAt": Type.Ref('Timestamp'), "context": Type.Ref('CallContextWire'), "actionTimebox": Type.Ref('ActionTimebox') }, { additionalProperties: false }),
  "EffectResult": Type.Object({ "outcome": Type.Union([Type.Literal('succeeded'), Type.Literal('failed'), Type.Literal('cancelled'), Type.Literal('unknown_effect')]), "result": Type.Optional(Type.Ref('DataRef')), "error": Type.Optional(Type.Ref('RuntimeError')), "externalRequests": Type.Array(Type.Ref('ExternalRequestRef'), { maxItems: 10000 }), "usage": Type.Array(Type.Ref('UsageFact'), { maxItems: 10000 }), "references": Type.Array(Type.Ref('RetentionRef'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "ReconcileResult": Type.Union([Type.Object({ "kind": Type.Literal('resolved'), "evidence": Type.Ref('DataRef'), "result": Type.Ref('EffectResult') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('not_found'), "evidence": Type.Ref('DataRef'), "safeToRetry": Type.Boolean() }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('unknown'), "evidence": Type.Ref('DataRef'), "reason": Type.String() }, { additionalProperties: false })]),
  "StreamChunkInput": Type.Object({ "typeId": Type.Ref('TypeId'), "payload": Type.Ref('DataRef') }, { additionalProperties: false }),
  "StreamChunk": Type.Object({ "typeId": Type.Ref('TypeId'), "payload": Type.Ref('DataRef'), "streamId": Type.Ref('Id'), "actionId": Type.Ref('Id'), "attemptId": Type.Ref('Id'), "seq": Type.Ref('UInt53'), "createdAt": Type.Ref('Timestamp') }, { additionalProperties: false }),
  "StreamEnd": Type.Object({ "streamId": Type.Ref('Id'), "lastSeq": Type.Ref('UInt53'), "receiptId": Type.Ref('Id'), "outcome": Type.Union([Type.Literal('succeeded'), Type.Literal('failed'), Type.Literal('cancelled'), Type.Literal('unknown_effect')]), "finalOutput": Type.Optional(Type.Ref('DataRef')) }, { additionalProperties: false }),
  "TransportEnd": Type.Object({ "streamId": Type.Ref('Id'), "lastSeq": Type.Ref('UInt53'), "status": Type.Union([Type.Literal('completed'), Type.Literal('failed'), Type.Literal('cancelled'), Type.Literal('unknown')]), "output": Type.Optional(Type.Ref('DataRef')), "error": Type.Optional(Type.Ref('RuntimeError')), "externalRequests": Type.Array(Type.Ref('ExternalRequestRef'), { maxItems: 10000 }), "usage": Type.Array(Type.Ref('UsageFact'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "RecordMeta": Type.Object({ "recordId": Type.Ref('Id'), "schema": Type.Ref('SchemaRef'), "minReader": Type.Ref('UInt53'), "recordRevision": Type.Ref('UInt53'), "lastCommitId": Type.Ref('Id'), "createdAt": Type.Ref('Timestamp'), "updatedAt": Type.Ref('Timestamp') }, { additionalProperties: false }),
  "RecordOwner": Type.Object({ "authority": Type.Ref('StateAuthorityRef'), "scope": Type.Ref('ScopeRef'), "ownerBinding": Type.Ref('BindingRef') }, { additionalProperties: false }),
  "RecordVersionRef": Type.Object({ "recordId": Type.Ref('Id'), "recordRevision": Type.Ref('UInt53'), "schema": Type.Ref('SchemaRef'), "commitId": Type.Ref('Id'), "digest": Type.Ref('Digest'), "body": Type.Union([Type.Object({ "state": Type.Literal('available'), "ref": Type.Ref('DataRef') }, { additionalProperties: false }), Type.Object({ "state": Type.Literal('pruned'), "pruneId": Type.Ref('Id'), "proofCommitId": Type.Ref('Id') }, { additionalProperties: false })]) }, { additionalProperties: false }),
  "CommitMutationManifest": Type.Object({ "commitId": Type.Ref('Id'), "recordId": Type.Ref('Id'), "previousRevision": Type.Union([Type.Ref('UInt53'), Type.Null()]), "next": Type.Union([Type.Null(), Type.Object({ "recordRevision": Type.Ref('UInt53'), "schema": Type.Ref('SchemaRef'), "digest": Type.Ref('Digest') }, { additionalProperties: false })]) }, { additionalProperties: false }),
  "CommitSideEntry": Type.Union([Type.Object({ "commitId": Type.Ref('Id'), "kind": Type.Literal('action-created'), "actionId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "commitId": Type.Ref('Id'), "kind": Type.Literal('signal-consumed'), "signalId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "commitId": Type.Ref('Id'), "kind": Type.Literal('outbox-created'), "eventId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "commitId": Type.Ref('Id'), "kind": Type.Literal('receipt-created'), "receiptId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "commitId": Type.Ref('Id'), "kind": Type.Literal('usage-origin'), "sourceAuthorityId": Type.Ref('Id'), "originKey": Type.String() }, { additionalProperties: false })]),
  "RecordPruneProof": Type.Object({ "pruneId": Type.Ref('Id'), "policyRef": Type.Ref('Id'), "checkedAt": Type.Ref('Timestamp'), "versions": Type.Array(Type.Object({ "recordId": Type.Ref('Id'), "recordRevision": Type.Ref('UInt53'), "digest": Type.Ref('Digest') }, { additionalProperties: false }), { maxItems: 10000 }) }, { additionalProperties: false }),
  "ActionState": Type.Union([Type.Literal('prepared'), Type.Literal('awaiting-approval'), Type.Literal('authorized'), Type.Literal('dispatching'), Type.Literal('running'), Type.Literal('unknown'), Type.Literal('reconciling'), Type.Literal('settled')]),
  "AttemptState": Type.Union([Type.Literal('allocated'), Type.Literal('dispatching'), Type.Literal('running'), Type.Literal('unknown'), Type.Literal('settled')]),
  "InvocationState": Type.Union([Type.Literal('active'), Type.Literal('draining'), Type.Literal('prepared'), Type.Literal('committed'), Type.Literal('closed'), Type.Literal('faulted')]),
  "RunTermination": Type.Object({ "outcome": Type.Union([Type.Literal('succeeded'), Type.Literal('failed'), Type.Literal('cancelled')]), "output": Type.Union([Type.Ref('DataRef'), Type.Null()]), "references": Type.Array(Type.Ref('RetentionRef'), { maxItems: 10000 }), "error": Type.Union([Type.Ref('RuntimeError'), Type.Null()]), "unknownActionIds": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "detachedOwnerRefs": Type.Array(Type.Ref('OwnerRef'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "RunRecordValue": Type.Object({ "runId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "lane": Type.String(), "admissionTicketId": Type.Ref('Id'), "bindingId": Type.Ref('Id'), "input": Type.Ref('DataRef'), "deadline": Type.Ref('Timestamp'), "conversation": Type.Union([Type.Ref('ConversationAdmission'), Type.Null()]), "revision": Type.Ref('UInt53'), "state": Type.Ref('RunState'), "continuation": Type.Union([Type.Ref('VersionedState'), Type.Null()]), "writerEpoch": Type.Ref('UInt53'), "waitId": Type.Union([Type.Ref('Id'), Type.Null()]), "cancellation": Type.Union([Type.Null(), Type.Object({ "reason": Type.String(), "requestedAt": Type.Ref('Timestamp'), "by": Type.Ref('Id') }, { additionalProperties: false })]), "terminal": Type.Union([Type.Ref('RunTermination'), Type.Null()]), "suspension": Type.Union([Type.Null(), Type.Object({ "reason": Type.String(), "previousState": Type.Ref('RunState'), "migrationId": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false })]) }, { additionalProperties: false }),
  "ActionRecordValue": Type.Object({ "actionId": Type.Ref('Id'), "runId": Type.Ref('Id'), "parentActionId": Type.Union([Type.Ref('Id'), Type.Null()]), "key": Type.String(), "intent": Type.Ref('PreparedAction'), "intentFingerprint": Type.Ref('Digest'), "state": Type.Ref('ActionState'), "currentAttemptId": Type.Union([Type.Ref('Id'), Type.Null()]), "providerStateId": Type.Union([Type.Ref('Id'), Type.Null()]), "firstReceiptId": Type.Union([Type.Ref('Id'), Type.Null()]), "resolvedReceiptId": Type.Union([Type.Ref('Id'), Type.Null()]), "resolutionId": Type.Union([Type.Ref('Id'), Type.Null()]), "ownerRef": Type.Ref('OwnerRef'), "createdByCommitId": Type.Ref('Id'), "resultHookPlan": Type.Union([Type.Ref('ResultHookPlan'), Type.Null()]), "taintSnapshot": Type.Ref('TaintSnapshot'), "authorizationTaintSnapshot": Type.Union([Type.Ref('TaintSnapshot'), Type.Null()]) }, { additionalProperties: false }),
  "ActionAdmissionTombstoneValue": Type.Object({ "runId": Type.Ref('Id'), "parentActionId": Type.Union([Type.Ref('Id'), Type.Null()]), "key": Type.String(), "acceptanceId": Type.Ref('Id'), "acceptanceFingerprint": Type.Ref('Digest'), "cancelledBy": Type.Ref('Id'), "createdAt": Type.Ref('Timestamp') }, { additionalProperties: false }),
  "AttemptRecordValue": Type.Object({ "attemptId": Type.Ref('Id'), "actionId": Type.Ref('Id'), "number": Type.Ref('UInt53'), "kind": Type.Union([Type.Literal('leaf'), Type.Literal('composite'), Type.Literal('control')]), "bindingId": Type.Ref('Id'), "inputDigest": Type.Ref('Digest'), "state": Type.Ref('AttemptState'), "requestIdentity": Type.Union([Type.Ref('RequestIdentity'), Type.Null()]), "externalRequests": Type.Array(Type.Ref('ExternalRequestRef'), { maxItems: 10000 }), "authorizationRef": Type.Union([Type.Ref('Id'), Type.Null()]), "budgetReservationRefs": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "streamIds": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "startedAt": Type.Union([Type.Ref('Timestamp'), Type.Null()]), "executeDeadline": Type.Union([Type.Ref('Timestamp'), Type.Null()]), "finishedAt": Type.Union([Type.Ref('Timestamp'), Type.Null()]), "receiptIds": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "writerEpoch": Type.Ref('UInt53') }, { additionalProperties: false }),
  "ProviderStateValue": Type.Object({ "actionId": Type.Ref('Id'), "providerRevision": Type.Ref('UInt53'), "state": Type.Union([Type.Literal('runnable'), Type.Literal('waiting'), Type.Literal('draining'), Type.Literal('completed'), Type.Literal('failed')]), "continuation": Type.Union([Type.Ref('VersionedState'), Type.Null()]), "waitId": Type.Union([Type.Ref('Id'), Type.Null()]), "writerEpoch": Type.Ref('UInt53'), "termination": Type.Union([Type.Null(), Type.Object({ "outcome": Type.Union([Type.Literal('failed'), Type.Literal('cancelled')]), "error": Type.Ref('RuntimeError') }, { additionalProperties: false })]) }, { additionalProperties: false }),
  "SignalRecordValue": Type.Object({ "signal": Type.Ref('Signal'), "targetRevisionAtCreation": Type.Ref('UInt53'), "consumedByCommitId": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false }),
  "WaitRecordValue": Type.Object({ "waitId": Type.Ref('Id'), "runId": Type.Ref('Id'), "targetActionId": Type.Union([Type.Ref('Id'), Type.Null()]), "condition": Type.Ref('WaitCondition'), "registeredByCommitId": Type.Ref('Id'), "state": Type.Union([Type.Literal('waiting'), Type.Literal('ready'), Type.Literal('cancelled')]), "matchedSignalIds": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "deadlineSignalId": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false }),
  "TimerRecordValue": Type.Object({ "timerId": Type.Ref('Id'), "runId": Type.Ref('Id'), "targetActionId": Type.Union([Type.Ref('Id'), Type.Null()]), "waitId": Type.Ref('Id'), "dueAt": Type.Ref('Timestamp'), "state": Type.Union([Type.Literal('scheduled'), Type.Literal('fired'), Type.Literal('cancelled')]), "signalId": Type.Ref('Id'), "registeredByCommitId": Type.Ref('Id'), "firedByCommitId": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false }),
  "SessionIdentityValue": Type.Object({ "sessionId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "formatVersion": Type.Literal(2), "runtimeSchemaMajor": Type.Literal(1), "minReader": Type.Ref('UInt53'), "parent": Type.Union([Type.Null(), Type.Object({ "sessionId": Type.Ref('Id'), "boundarySeq": Type.Ref('UInt53'), "boundaryDigest": Type.Union([Type.Ref('Digest'), Type.Null()]) }, { additionalProperties: false })]) }, { additionalProperties: false }),
  "RunQuotaValue": Type.Object({ "runId": Type.Ref('Id'), "limitPolicyRef": Type.Ref('Id'), "totalTransitions": Type.Ref('UInt53'), "noProgressTransitions": Type.Ref('UInt53'), "lastProgressRef": Type.Union([Type.Ref('Id'), Type.Null()]), "submittedActions": Type.Ref('UInt53'), "totalQueries": Type.Ref('UInt53'), "reservedQueries": Type.Ref('UInt53'), "invocationStarts": Type.Ref('UInt53'), "failedInvocations": Type.Ref('UInt53'), "activeQuotaReservationRefs": Type.Array(Type.Ref('Id'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "InvocationValue": Type.Object({ "invocationId": Type.Ref('Id'), "prepareId": Type.Ref('Id'), "runId": Type.Ref('Id'), "targetActionId": Type.Union([Type.Ref('Id'), Type.Null()]), "baseRevision": Type.Ref('UInt53'), "bindingId": Type.Ref('Id'), "writerEpoch": Type.Ref('UInt53'), "state": Type.Ref('InvocationState'), "queryGrantId": Type.Ref('Id'), "queryCount": Type.Ref('UInt53'), "readGuards": Type.Array(Type.Ref('ReadGuard'), { maxItems: 10000 }), "domainReads": Type.Array(Type.Ref('DomainReference'), { maxItems: 10000 }), "startedAt": Type.Ref('Timestamp'), "deadline": Type.Ref('Timestamp'), "closedAt": Type.Union([Type.Ref('Timestamp'), Type.Null()]), "inflightIds": Type.Array(Type.Ref('Id'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "PrepareQueryQuotaValue": Type.Object({ "prepareId": Type.Ref('Id'), "runId": Type.Ref('Id'), "targetActionId": Type.Union([Type.Ref('Id'), Type.Null()]), "baseRevision": Type.Ref('UInt53'), "totalQueries": Type.Ref('UInt53'), "reservedQueries": Type.Ref('UInt53'), "closed": Type.Boolean() }, { additionalProperties: false }),
  "QueryGrantValue": Type.Object({ "grantId": Type.Ref('Id'), "invocationId": Type.Ref('Id'), "prepareId": Type.Ref('Id'), "runId": Type.Ref('Id'), "writerEpoch": Type.Ref('UInt53'), "capacity": Type.Ref('UInt53'), "flushedCount": Type.Ref('UInt53'), "state": Type.Union([Type.Literal('active'), Type.Literal('settled')]), "settledCount": Type.Union([Type.Ref('UInt53'), Type.Null()]) }, { additionalProperties: false }),
  "DispatchAdmissionRecordValue": Type.Object({ "admissionId": Type.Ref('Id'), "requestFingerprint": Type.Ref('Digest'), "result": Type.Ref('DispatchAdmissionResult') }, { additionalProperties: false }),
  "ReceiptRecordValue": Type.Object({ "receipt": Type.Ref('Receipt'), "evidenceRefs": Type.Array(Type.Ref('DataRef'), { maxItems: 10000 }), "acceptedBy": Type.Ref('Id'), "acceptedAt": Type.Ref('Timestamp') }, { additionalProperties: false }),
  "ResolutionRecordValue": Type.Object({ "resolutionId": Type.Ref('Id'), "actionId": Type.Ref('Id'), "previousReceiptIds": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "selectedReceiptId": Type.Union([Type.Ref('Id'), Type.Null()]), "evidenceRefs": Type.Array(Type.Ref('DataRef'), { maxItems: 10000 }), "state": Type.Union([Type.Literal('unresolved'), Type.Literal('resolved'), Type.Literal('conflicting')]), "ownerRef": Type.Ref('OwnerRef'), "nextCheckAt": Type.Union([Type.Ref('Timestamp'), Type.Null()]), "reason": Type.String() }, { additionalProperties: false }),
  "ReconciliationCheckValue": Type.Object({ "checkId": Type.Ref('Id'), "actionId": Type.Ref('Id'), "bindingId": Type.Ref('Id'), "invocationId": Type.Ref('Id'), "lookupMethod": Type.String(), "input": Type.Ref('DataRef'), "state": Type.Union([Type.Literal('admitted'), Type.Literal('running'), Type.Literal('completed'), Type.Literal('unknown')]), "deadline": Type.Ref('Timestamp'), "result": Type.Union([Type.Ref('ReconcileResult'), Type.Null()]), "evidenceRefs": Type.Array(Type.Ref('DataRef'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "UsageMirrorValue": Type.Object({ "usage": Type.Ref('UsageFact'), "sourceAuthorityRef": Type.Ref('StateAuthorityRef'), "sourceEventId": Type.Ref('Id'), "settlementRef": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false }),
  "StreamRecordValue": Type.Object({ "streamId": Type.Ref('Id'), "actionId": Type.Ref('Id'), "attemptId": Type.Ref('Id'), "durability": Type.Union([Type.Literal('ephemeral'), Type.Literal('durable')]), "state": Type.Union([Type.Literal('open'), Type.Literal('ended')]), "lastSeq": Type.Ref('UInt53'), "receiptId": Type.Union([Type.Ref('Id'), Type.Null()]), "retentionUntil": Type.Ref('Timestamp') }, { additionalProperties: false }),
  "ReferenceTarget": Type.Union([Type.Object({ "kind": Type.Literal('retained'), "retention": Type.Ref('RetentionRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('binding'), "bindingId": Type.Ref('Id') }, { additionalProperties: false })]),
  "ReferenceRecordValue": Type.Object({ "referenceId": Type.Ref('Id'), "sourceRecordId": Type.Ref('Id'), "target": Type.Ref('ReferenceTarget'), "status": Type.Union([Type.Literal('pending'), Type.Literal('confirmed'), Type.Literal('releasing'), Type.Literal('released')]), "releaseReason": Type.Union([Type.String(), Type.Null()]) }, { additionalProperties: false }),
  "QuotaReservationMirrorValue": Type.Object({ "source": Type.Ref('DomainReference'), "reservationId": Type.Ref('Id'), "ownerRef": Type.Ref('OwnerRef'), "scopeIds": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "kind": Type.Union([Type.Literal('parallel-action'), Type.Literal('live-agent')]), "quantity": Type.Ref('UInt53'), "status": Type.Union([Type.Literal('held'), Type.Literal('released')]), "requestFingerprint": Type.Ref('Digest'), "createdAt": Type.Ref('Timestamp'), "releasedAt": Type.Union([Type.Ref('Timestamp'), Type.Null()]) }, { additionalProperties: false }),
  "PreparedActionAdmissionProbe": Type.Union([Type.Object({ "state": Type.Literal('absent') }, { additionalProperties: false }), Type.Object({ "state": Type.Literal('committed'), "actionId": Type.Ref('Id'), "acceptanceId": Type.Ref('Id'), "commitId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "state": Type.Literal('cancelled'), "acceptanceId": Type.Ref('Id'), "tombstoneId": Type.Ref('Id'), "commitId": Type.Ref('Id') }, { additionalProperties: false })]),
  "MigrationToken": Type.Object({ "upgradeId": Type.Ref('Id'), "runId": Type.Ref('Id'), "fromBindingId": Type.Ref('Id'), "frozenRevision": Type.Ref('UInt53'), "frozenWriterEpoch": Type.Ref('UInt53'), "authorityEpoch": Type.Ref('UInt53'), "fingerprint": Type.Ref('Digest') }, { additionalProperties: false }),
  "MigrationProbe": Type.Union([Type.Object({ "state": Type.Literal('absent') }, { additionalProperties: false }), Type.Object({ "state": Type.Literal('frozen'), "token": Type.Ref('MigrationToken') }, { additionalProperties: false }), Type.Object({ "state": Type.Literal('committed'), "token": Type.Ref('MigrationToken'), "commit": Type.Ref('StateCommitReceipt'), "toBindingId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "state": Type.Literal('aborted'), "token": Type.Ref('MigrationToken'), "commit": Type.Ref('StateCommitReceipt'), "reason": Type.String() }, { additionalProperties: false })]),
  "StateScanRequest": Type.Object({ "snapshot": Type.Ref('SnapshotRef'), "collection": Type.Union([Type.Literal('events'), Type.Literal('integrity'), Type.Literal('records'), Type.Literal('actions'), Type.Literal('signals'), Type.Literal('outbox'), Type.Literal('record-versions'), Type.Literal('mutation-manifests'), Type.Literal('commit-side-entries')]), "filter": Type.Object({ "runId": Type.Optional(Type.Ref('Id')), "parentActionId": Type.Optional(Type.Union([Type.Ref('Id'), Type.Null()])), "targetActionId": Type.Optional(Type.Union([Type.Ref('Id'), Type.Null()])), "typeIds": Type.Optional(Type.Array(Type.Ref('TypeId'), { maxItems: 10000 })), "commitId": Type.Optional(Type.Ref('Id')), "states": Type.Optional(Type.Array(Type.String(), { maxItems: 10000 })), "fromSeq": Type.Optional(Type.Ref('UInt53')), "toSeq": Type.Optional(Type.Ref('UInt53')) }, { additionalProperties: false }), "order": Type.Union([Type.Literal('asc'), Type.Literal('desc')]), "cursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "limit": Type.Ref('UInt53') }, { additionalProperties: false }),
  "ChildCreateRequest": Type.Object({ "creationId": Type.Ref('Id'), "fingerprint": Type.Ref('Digest'), "parentSnapshot": Type.Ref('SnapshotRef'), "boundarySeq": Type.Ref('UInt53'), "childSessionId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "ownerBinding": Type.Ref('BindingRef') }, { additionalProperties: false }),
  "StreamRegistration": Type.Object({ "requestId": Type.Ref('Id'), "streamId": Type.Ref('Id'), "actionId": Type.Ref('Id'), "attemptId": Type.Ref('Id'), "durability": Type.Union([Type.Literal('ephemeral'), Type.Literal('durable')]), "retentionUntil": Type.Ref('Timestamp') }, { additionalProperties: false }),
  "RuntimeFormatData": Type.Object({ "formatVersion": Type.Literal(2), "runtimeSchemaMajor": Type.Literal(1), "minReader": Type.Literal(1), "previousFormat": Type.Union([Type.Literal(1), Type.Literal(2)]), "legacyThroughSeq": Type.Ref('UInt53'), "sourceHeadDigest": Type.Union([Type.Ref('Digest'), Type.Null()]) }, { additionalProperties: false }),
  "RuntimeCommitData": Type.Object({ "commitId": Type.Ref('Id'), "transactionFingerprint": Type.Ref('Digest'), "runId": Type.Union([Type.Ref('Id'), Type.Null()]), "actionId": Type.Union([Type.Ref('Id'), Type.Null()]), "authorityEpoch": Type.Ref('UInt53'), "writerEpoch": Type.Ref('UInt53'), "previousCommitId": Type.Union([Type.Ref('Id'), Type.Null()]), "mutationsDigest": Type.Ref('Digest'), "mutationCount": Type.Ref('UInt53'), "sideListsDigest": Type.Ref('Digest'), "counts": Type.Object({ "createdActions": Type.Ref('UInt53'), "consumedSignals": Type.Ref('UInt53'), "outboxEvents": Type.Ref('UInt53'), "receipts": Type.Ref('UInt53'), "usageOrigins": Type.Ref('UInt53') }, { additionalProperties: false }) }, { additionalProperties: false }),
  "InboxRecord": Type.Object({ "sourceAuthorityId": Type.Ref('Id'), "eventId": Type.Ref('Id'), "consumerId": Type.Ref('Id'), "fingerprint": Type.Ref('Digest'), "receivedAt": Type.Ref('Timestamp'), "appliedCommitId": Type.Ref('Id'), "acknowledgement": Type.Ref('DataRef') }, { additionalProperties: false }),
  "MaintenanceEnvelopeJsonValue": Type.Object({ "recordId": Type.Ref('Id'), "revision": Type.Ref('UInt53'), "writerEpoch": Type.Ref('UInt53'), "createdAt": Type.Ref('Timestamp'), "updatedAt": Type.Ref('Timestamp'), "schema": Type.Ref('SchemaRef'), "payload": JsonValue, "fingerprint": Type.Ref('Digest') }, { additionalProperties: false }),
  "MaintenanceMutation": Type.Object({ "recordId": Type.Ref('Id'), "expectedRevision": Type.Union([Type.Ref('UInt53'), Type.Null()]), "next": Type.Ref('MaintenanceEnvelopeJsonValue') }, { additionalProperties: false }),
  "MigrationTarget": Type.Union([Type.Object({ "kind": Type.Literal('run-state'), "runId": Type.Ref('Id'), "sourceBindingId": Type.Ref('Id'), "targetBindingId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('state-authority'), "source": Type.Ref('StateAuthorityRef'), "targetProviderLock": Type.Ref('DataRef'), "targetLocationRef": Type.Ref('Id'), "cohortRef": Type.Ref('DataRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('directory'), "sourceLocatorRevision": Type.Ref('UInt53'), "targetProviderLock": Type.Ref('DataRef'), "targetLocationRef": Type.Ref('Id'), "externalJournalRef": Type.Ref('Id') }, { additionalProperties: false })]),
  "MigrationRequest": Type.Object({ "upgradeId": Type.Ref('Id'), "target": Type.Ref('MigrationTarget'), "policyRef": Type.Ref('Id'), "reason": Type.String(), "mode": Type.Union([Type.Literal('inspect-only'), Type.Literal('auto-compatible'), Type.Literal('explicit')]) }, { additionalProperties: false }),
  "AuthorityCheckpoint": Type.Object({ "authorityId": Type.Ref('Id'), "authorityEpoch": Type.Ref('UInt53'), "checkpointId": Type.Ref('Id'), "snapshotDigest": Type.Ref('Digest'), "recordCount": Type.Ref('UInt53'), "bridgeWatermarks": Type.Array(Type.Object({ "bridgeId": Type.Ref('Id'), "producedThrough": Type.Ref('UInt53'), "acceptedThrough": Type.Ref('UInt53') }, { additionalProperties: false }), { maxItems: 10000 }) }, { additionalProperties: false }),
  "UpgradeExpectedHeads": Type.Union([Type.Object({ "kind": Type.Literal('release'), "routeId": Type.Ref('Id'), "routeRevision": Type.Ref('UInt53'), "releaseSetId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('run-state'), "runId": Type.Ref('Id'), "runRevision": Type.Ref('UInt53'), "writerEpoch": Type.Ref('UInt53'), "bindingId": Type.Ref('Id'), "authority": Type.Ref('StateAuthorityRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('state-authority'), "authority": Type.Ref('StateAuthorityRef'), "routeRevision": Type.Ref('UInt53'), "cohortDigest": Type.Ref('Digest'), "checkpoints": Type.Array(Type.Ref('AuthorityCheckpoint'), { maxItems: 10000 }) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('directory'), "locatorId": Type.Ref('Id'), "locatorRevision": Type.Ref('UInt53'), "directoryEpoch": Type.Ref('UInt53') }, { additionalProperties: false })]),
  "MigrationInvariants": Type.Object({ "publicFacts": Type.Literal('identical'), "effectIdentity": Type.Literal('identical'), "accounting": Type.Literal('identical'), "pendingOwnership": Type.Literal('preserved-or-explicit-alias'), "unconsumedSignals": Type.Literal('preserved'), "deletionAndRevocation": Type.Literal('current'), "lineage": Type.Literal('identical'), "additionalChecks": Type.Array(Type.Object({ "checkId": Type.Ref('Id'), "schema": Type.Ref('SchemaRef'), "expected": Type.Ref('DataRef') }, { additionalProperties: false }), { maxItems: 10000 }) }, { additionalProperties: false }),
  "MigrationPlan": Type.Object({ "planId": Type.Ref('Id'), "upgradeId": Type.Ref('Id'), "request": Type.Ref('MigrationRequest'), "planFingerprint": Type.Ref('Digest'), "sourceHeads": Type.Ref('UpgradeExpectedHeads'), "migratorLock": Type.Ref('DataRef'), "validatorLocks": Type.Array(Type.Ref('DataRef'), { maxItems: 10000 }), "requiredPins": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "requiredCapabilities": Type.Array(Type.String(), { maxItems: 10000 }), "invariants": Type.Ref('MigrationInvariants'), "resourceBudgetRef": Type.Ref('Id'), "expiresAt": Type.Ref('Timestamp'), "eligibility": Type.Union([Type.Literal('eligible'), Type.Literal('retain-source'), Type.Literal('wait-safe-point'), Type.Literal('blocked')]), "reasonCodes": Type.Array(Type.String(), { maxItems: 10000 }) }, { additionalProperties: false }),
  "MigrationReceipt": Type.Object({ "upgradeId": Type.Ref('Id'), "state": Type.Union([Type.Literal('planned'), Type.Literal('preparing'), Type.Literal('verified'), Type.Literal('cutting-over'), Type.Literal('committed'), Type.Literal('draining'), Type.Literal('completed'), Type.Literal('aborted'), Type.Literal('blocked')]), "checkpointRevision": Type.Ref('UInt53'), "cutoverId": Type.Union([Type.Ref('Id'), Type.Null()]), "commitRef": Type.Union([Type.Ref('Id'), Type.Null()]), "diagnosticIds": Type.Array(Type.Ref('Id'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "UpgradeCheckpoint": Type.Object({ "key": Type.String(), "inputDigest": Type.Ref('Digest'), "evidence": Type.Array(Type.Ref('DataRef'), { maxItems: 10000 }), "completedAt": Type.Ref('Timestamp') }, { additionalProperties: false }),
  "MigrationCandidate": Type.Object({ "upgradeId": Type.Ref('Id'), "planFingerprint": Type.Ref('Digest'), "sourceHeads": Type.Ref('UpgradeExpectedHeads'), "sourceSnapshotDigest": Type.Ref('Digest'), "targetDigest": Type.Ref('Digest'), "conversion": Type.Union([Type.Null(), Type.Object({ "migratorBinding": Type.Ref('BindingRef'), "inputCodec": Type.Ref('SchemaRef'), "outputCodec": Type.Ref('SchemaRef') }, { additionalProperties: false })]), "content": Type.Ref('DataRef'), "requiredPins": Type.Array(Type.Ref('Id'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "MigrationValidation": Type.Object({ "upgradeId": Type.Ref('Id'), "planFingerprint": Type.Ref('Digest'), "candidateDigest": Type.Ref('Digest'), "sourceSnapshotDigest": Type.Ref('Digest'), "checkedAt": Type.Ref('Timestamp'), "checks": Type.Array(Type.Object({ "checkId": Type.Ref('Id'), "passed": Type.Boolean(), "evidence": Type.Ref('DataRef') }, { additionalProperties: false }), { maxItems: 10000 }), "validatorBindings": Type.Array(Type.Ref('BindingRef'), { maxItems: 10000 }), "accepted": Type.Boolean() }, { additionalProperties: false }),
  "AuthorityFence": Type.Object({ "upgradeId": Type.Ref('Id'), "source": Type.Ref('StateAuthorityRef'), "fenceId": Type.Ref('Id'), "fenceEpoch": Type.Ref('UInt53'), "checkpoint": Type.Ref('AuthorityCheckpoint'), "writerCredentialsRevoked": Type.Boolean() }, { additionalProperties: false }),
})

export const Id = RuntimePublic7.Import('Id')
export type Id = Static<typeof Id>
export const UInt53 = RuntimePublic7.Import('UInt53')
export type UInt53 = Static<typeof UInt53>
export const Timestamp = RuntimePublic7.Import('Timestamp')
export type Timestamp = Static<typeof Timestamp>
export const TypeId = RuntimePublic7.Import('TypeId')
export type TypeId = Static<typeof TypeId>
export const Digest = RuntimePublic7.Import('Digest')
export type Digest = Static<typeof Digest>
export const SchemaRef = RuntimePublic7.Import('SchemaRef')
export type SchemaRef = Static<typeof SchemaRef>
export const BlobRef = RuntimePublic7.Import('BlobRef')
export type BlobRef = Static<typeof BlobRef>
export const DataRef = RuntimePublic7.Import('DataRef')
export type DataRef = Static<typeof DataRef>
export const ActionRef = RuntimePublic7.Import('ActionRef')
export type ActionRef = Static<typeof ActionRef>
export const ActionDependency = RuntimePublic7.Import('ActionDependency')
export type ActionDependency = Static<typeof ActionDependency>
export const RuntimeErrorCode = RuntimePublic7.Import('RuntimeErrorCode')
export type RuntimeErrorCode = Static<typeof RuntimeErrorCode>
export const OwnerRef = RuntimePublic7.Import('OwnerRef')
export type OwnerRef = Static<typeof OwnerRef>
export const RetryAdvice = RuntimePublic7.Import('RetryAdvice')
export type RetryAdvice = Static<typeof RetryAdvice>
export const RuntimeError = RuntimePublic7.Import('RuntimeError')
export type RuntimeError = Static<typeof RuntimeError>
export const ExternalRequestRef = RuntimePublic7.Import('ExternalRequestRef')
export type ExternalRequestRef = Static<typeof ExternalRequestRef>
export const RetentionRef = RuntimePublic7.Import('RetentionRef')
export type RetentionRef = Static<typeof RetentionRef>
export const BindingRef = RuntimePublic7.Import('BindingRef')
export type BindingRef = Static<typeof BindingRef>
export const Provenance = RuntimePublic7.Import('Provenance')
export type Provenance = Static<typeof Provenance>
export const StateCommitReceipt = RuntimePublic7.Import('StateCommitReceipt')
export type StateCommitReceipt = Static<typeof StateCommitReceipt>
export const StateAuthorityRef = RuntimePublic7.Import('StateAuthorityRef')
export type StateAuthorityRef = Static<typeof StateAuthorityRef>
export const ReadGuard = RuntimePublic7.Import('ReadGuard')
export type ReadGuard = Static<typeof ReadGuard>
export const VersionedState = RuntimePublic7.Import('VersionedState')
export type VersionedState = Static<typeof VersionedState>
export const RetryPolicy = RuntimePublic7.Import('RetryPolicy')
export type RetryPolicy = Static<typeof RetryPolicy>
export const PreparedAction = RuntimePublic7.Import('PreparedAction')
export type PreparedAction = Static<typeof PreparedAction>
export const WaitClause = RuntimePublic7.Import('WaitClause')
export type WaitClause = Static<typeof WaitClause>
export const WaitCondition = RuntimePublic7.Import('WaitCondition')
export type WaitCondition = Static<typeof WaitCondition>
export const ScopeRef = RuntimePublic7.Import('ScopeRef')
export type ScopeRef = Static<typeof ScopeRef>
export const DomainReference = RuntimePublic7.Import('DomainReference')
export type DomainReference = Static<typeof DomainReference>
export const CallContextWire = RuntimePublic7.Import('CallContextWire')
export type CallContextWire = Static<typeof CallContextWire>
export const RequestIdentity = RuntimePublic7.Import('RequestIdentity')
export type RequestIdentity = Static<typeof RequestIdentity>
export const ConversationAdmission = RuntimePublic7.Import('ConversationAdmission')
export type ConversationAdmission = Static<typeof ConversationAdmission>
export const DispatchAdmissionResult = RuntimePublic7.Import('DispatchAdmissionResult')
export type DispatchAdmissionResult = Static<typeof DispatchAdmissionResult>
export const HookRegistrationSnapshot = RuntimePublic7.Import('HookRegistrationSnapshot')
export type HookRegistrationSnapshot = Static<typeof HookRegistrationSnapshot>
export const Receipt = RuntimePublic7.Import('Receipt')
export type Receipt = Static<typeof Receipt>
export const UsageFact = RuntimePublic7.Import('UsageFact')
export type UsageFact = Static<typeof UsageFact>
export const ResultHookPlan = RuntimePublic7.Import('ResultHookPlan')
export type ResultHookPlan = Static<typeof ResultHookPlan>
export const SnapshotRef = RuntimePublic7.Import('SnapshotRef')
export type SnapshotRef = Static<typeof SnapshotRef>
export const ConfigValue = RuntimePublic7.Import('ConfigValue')
export type ConfigValue = Static<typeof ConfigValue>
export const TaintSnapshot = RuntimePublic7.Import('TaintSnapshot')
export type TaintSnapshot = Static<typeof TaintSnapshot>
export const SessionControlBoundary = RuntimePublic7.Import('SessionControlBoundary')
export type SessionControlBoundary = Static<typeof SessionControlBoundary>
export const SessionParameterRevision = RuntimePublic7.Import('SessionParameterRevision')
export type SessionParameterRevision = Static<typeof SessionParameterRevision>
export const RunState = RuntimePublic7.Import('RunState')
export type RunState = Static<typeof RunState>
export const Cursor = RuntimePublic7.Import('Cursor')
export type Cursor = Static<typeof Cursor>
export const Signal = RuntimePublic7.Import('Signal')
export type Signal = Static<typeof Signal>
export const ReceiptRef = RuntimePublic7.Import('ReceiptRef')
export type ReceiptRef = Static<typeof ReceiptRef>
export const ActionTimebox = RuntimePublic7.Import('ActionTimebox')
export type ActionTimebox = Static<typeof ActionTimebox>
export const PageSignal = RuntimePublic7.Import('PageSignal')
export type PageSignal = Static<typeof PageSignal>
export const PageReceiptRef = RuntimePublic7.Import('PageReceiptRef')
export type PageReceiptRef = Static<typeof PageReceiptRef>
export const RunFrame = RuntimePublic7.Import('RunFrame')
export type RunFrame = Static<typeof RunFrame>
export const ActionFrame = RuntimePublic7.Import('ActionFrame')
export type ActionFrame = Static<typeof ActionFrame>
export const EffectResult = RuntimePublic7.Import('EffectResult')
export type EffectResult = Static<typeof EffectResult>
export const ReconcileResult = RuntimePublic7.Import('ReconcileResult')
export type ReconcileResult = Static<typeof ReconcileResult>
export const StreamChunkInput = RuntimePublic7.Import('StreamChunkInput')
export type StreamChunkInput = Static<typeof StreamChunkInput>
export const StreamChunk = RuntimePublic7.Import('StreamChunk')
export type StreamChunk = Static<typeof StreamChunk>
export const StreamEnd = RuntimePublic7.Import('StreamEnd')
export type StreamEnd = Static<typeof StreamEnd>
export const TransportEnd = RuntimePublic7.Import('TransportEnd')
export type TransportEnd = Static<typeof TransportEnd>
export const RecordMeta = RuntimePublic7.Import('RecordMeta')
export type RecordMeta = Static<typeof RecordMeta>
export const RecordOwner = RuntimePublic7.Import('RecordOwner')
export type RecordOwner = Static<typeof RecordOwner>
export const RecordVersionRef = RuntimePublic7.Import('RecordVersionRef')
export type RecordVersionRef = Static<typeof RecordVersionRef>
export const CommitMutationManifest = RuntimePublic7.Import('CommitMutationManifest')
export type CommitMutationManifest = Static<typeof CommitMutationManifest>
export const CommitSideEntry = RuntimePublic7.Import('CommitSideEntry')
export type CommitSideEntry = Static<typeof CommitSideEntry>
export const RecordPruneProof = RuntimePublic7.Import('RecordPruneProof')
export type RecordPruneProof = Static<typeof RecordPruneProof>
export const ActionState = RuntimePublic7.Import('ActionState')
export type ActionState = Static<typeof ActionState>
export const AttemptState = RuntimePublic7.Import('AttemptState')
export type AttemptState = Static<typeof AttemptState>
export const InvocationState = RuntimePublic7.Import('InvocationState')
export type InvocationState = Static<typeof InvocationState>
export const RunTermination = RuntimePublic7.Import('RunTermination')
export type RunTermination = Static<typeof RunTermination>
export const RunRecordValue = RuntimePublic7.Import('RunRecordValue')
export type RunRecordValue = Static<typeof RunRecordValue>
export const ActionRecordValue = RuntimePublic7.Import('ActionRecordValue')
export type ActionRecordValue = Static<typeof ActionRecordValue>
export const ActionAdmissionTombstoneValue = RuntimePublic7.Import('ActionAdmissionTombstoneValue')
export type ActionAdmissionTombstoneValue = Static<typeof ActionAdmissionTombstoneValue>
export const AttemptRecordValue = RuntimePublic7.Import('AttemptRecordValue')
export type AttemptRecordValue = Static<typeof AttemptRecordValue>
export const ProviderStateValue = RuntimePublic7.Import('ProviderStateValue')
export type ProviderStateValue = Static<typeof ProviderStateValue>
export const SignalRecordValue = RuntimePublic7.Import('SignalRecordValue')
export type SignalRecordValue = Static<typeof SignalRecordValue>
export const WaitRecordValue = RuntimePublic7.Import('WaitRecordValue')
export type WaitRecordValue = Static<typeof WaitRecordValue>
export const TimerRecordValue = RuntimePublic7.Import('TimerRecordValue')
export type TimerRecordValue = Static<typeof TimerRecordValue>
export const SessionIdentityValue = RuntimePublic7.Import('SessionIdentityValue')
export type SessionIdentityValue = Static<typeof SessionIdentityValue>
export const RunQuotaValue = RuntimePublic7.Import('RunQuotaValue')
export type RunQuotaValue = Static<typeof RunQuotaValue>
export const InvocationValue = RuntimePublic7.Import('InvocationValue')
export type InvocationValue = Static<typeof InvocationValue>
export const PrepareQueryQuotaValue = RuntimePublic7.Import('PrepareQueryQuotaValue')
export type PrepareQueryQuotaValue = Static<typeof PrepareQueryQuotaValue>
export const QueryGrantValue = RuntimePublic7.Import('QueryGrantValue')
export type QueryGrantValue = Static<typeof QueryGrantValue>
export const DispatchAdmissionRecordValue = RuntimePublic7.Import('DispatchAdmissionRecordValue')
export type DispatchAdmissionRecordValue = Static<typeof DispatchAdmissionRecordValue>
export const ReceiptRecordValue = RuntimePublic7.Import('ReceiptRecordValue')
export type ReceiptRecordValue = Static<typeof ReceiptRecordValue>
export const ResolutionRecordValue = RuntimePublic7.Import('ResolutionRecordValue')
export type ResolutionRecordValue = Static<typeof ResolutionRecordValue>
export const ReconciliationCheckValue = RuntimePublic7.Import('ReconciliationCheckValue')
export type ReconciliationCheckValue = Static<typeof ReconciliationCheckValue>
export const UsageMirrorValue = RuntimePublic7.Import('UsageMirrorValue')
export type UsageMirrorValue = Static<typeof UsageMirrorValue>
export const StreamRecordValue = RuntimePublic7.Import('StreamRecordValue')
export type StreamRecordValue = Static<typeof StreamRecordValue>
export const ReferenceTarget = RuntimePublic7.Import('ReferenceTarget')
export type ReferenceTarget = Static<typeof ReferenceTarget>
export const ReferenceRecordValue = RuntimePublic7.Import('ReferenceRecordValue')
export type ReferenceRecordValue = Static<typeof ReferenceRecordValue>
export const QuotaReservationMirrorValue = RuntimePublic7.Import('QuotaReservationMirrorValue')
export type QuotaReservationMirrorValue = Static<typeof QuotaReservationMirrorValue>
export const PreparedActionAdmissionProbe = RuntimePublic7.Import('PreparedActionAdmissionProbe')
export type PreparedActionAdmissionProbe = Static<typeof PreparedActionAdmissionProbe>
export const MigrationToken = RuntimePublic7.Import('MigrationToken')
export type MigrationToken = Static<typeof MigrationToken>
export const MigrationProbe = RuntimePublic7.Import('MigrationProbe')
export type MigrationProbe = Static<typeof MigrationProbe>
export const StateScanRequest = RuntimePublic7.Import('StateScanRequest')
export type StateScanRequest = Static<typeof StateScanRequest>
export const ChildCreateRequest = RuntimePublic7.Import('ChildCreateRequest')
export type ChildCreateRequest = Static<typeof ChildCreateRequest>
export const StreamRegistration = RuntimePublic7.Import('StreamRegistration')
export type StreamRegistration = Static<typeof StreamRegistration>
export const RuntimeFormatData = RuntimePublic7.Import('RuntimeFormatData')
export type RuntimeFormatData = Static<typeof RuntimeFormatData>
export const RuntimeCommitData = RuntimePublic7.Import('RuntimeCommitData')
export type RuntimeCommitData = Static<typeof RuntimeCommitData>
export const InboxRecord = RuntimePublic7.Import('InboxRecord')
export type InboxRecord = Static<typeof InboxRecord>
export const MaintenanceEnvelopeJsonValue = RuntimePublic7.Import('MaintenanceEnvelopeJsonValue')
export type MaintenanceEnvelopeJsonValue = Static<typeof MaintenanceEnvelopeJsonValue>
export const MaintenanceMutation = RuntimePublic7.Import('MaintenanceMutation')
export type MaintenanceMutation = Static<typeof MaintenanceMutation>
export const MigrationTarget = RuntimePublic7.Import('MigrationTarget')
export type MigrationTarget = Static<typeof MigrationTarget>
export const MigrationRequest = RuntimePublic7.Import('MigrationRequest')
export type MigrationRequest = Static<typeof MigrationRequest>
export const AuthorityCheckpoint = RuntimePublic7.Import('AuthorityCheckpoint')
export type AuthorityCheckpoint = Static<typeof AuthorityCheckpoint>
export const UpgradeExpectedHeads = RuntimePublic7.Import('UpgradeExpectedHeads')
export type UpgradeExpectedHeads = Static<typeof UpgradeExpectedHeads>
export const MigrationInvariants = RuntimePublic7.Import('MigrationInvariants')
export type MigrationInvariants = Static<typeof MigrationInvariants>
export const MigrationPlan = RuntimePublic7.Import('MigrationPlan')
export type MigrationPlan = Static<typeof MigrationPlan>
export const MigrationReceipt = RuntimePublic7.Import('MigrationReceipt')
export type MigrationReceipt = Static<typeof MigrationReceipt>
export const UpgradeCheckpoint = RuntimePublic7.Import('UpgradeCheckpoint')
export type UpgradeCheckpoint = Static<typeof UpgradeCheckpoint>
export const MigrationCandidate = RuntimePublic7.Import('MigrationCandidate')
export type MigrationCandidate = Static<typeof MigrationCandidate>
export const MigrationValidation = RuntimePublic7.Import('MigrationValidation')
export type MigrationValidation = Static<typeof MigrationValidation>
export const AuthorityFence = RuntimePublic7.Import('AuthorityFence')
export type AuthorityFence = Static<typeof AuthorityFence>
