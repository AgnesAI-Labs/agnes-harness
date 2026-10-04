import type { Page } from './runtime-public.js'
// generated from schema by tools/gen.ts — do not edit
import { Type, type Static } from '@sinclair/typebox'
import { FormatRegistry } from '@sinclair/typebox'

if (!FormatRegistry.Has('date-time')) FormatRegistry.Set('date-time', (value) => { const parts = value.split(/t/i); if (parts.length !== 2) return false; const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(parts[0] ?? ''); const time = /^(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)(z|([+-])(\d{2}):(\d{2}))$/i.exec(parts[1] ?? ''); if (!date || !time) return false; const year = Number(date[1]), month = Number(date[2]), day = Number(date[3]); const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0); const days = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; if (month < 1 || month > 12 || day < 1 || day > (days[month] ?? 0)) return false; const hour = Number(time[1]), minute = Number(time[2]), second = Number(time[3]); const offsetHour = Number(time[6] || 0), offsetMinute = Number(time[7] || 0); if (hour > 23 || minute > 59 || offsetHour > 23 || offsetMinute > 59) return false; if (second < 60) return true; const sign = time[5] === '-' ? -1 : 1; const utcMinute = minute - offsetMinute * sign; const utcHour = hour - offsetHour * sign - (utcMinute < 0 ? 1 : 0); return (utcHour === 23 || utcHour === -1) && (utcMinute === 59 || utcMinute === -1) && second < 61; })

export const JsonValue = Type.Recursive((This) => Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String(), Type.Array(This, { minItems: 0, maxItems: 10000 }), Type.Record(Type.String(), This)]))
export type JsonValue = Static<typeof JsonValue>

export const Externalsession_v1_JsonValue = Type.Recursive((This) => Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String(), Type.Array(This), Type.Record(Type.String(), This)]))
export type Externalsession_v1_JsonValue = Static<typeof Externalsession_v1_JsonValue>

export const RuntimePublic23 = Type.Module({
  "Id": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }),
  "UInt53": Type.Integer({ minimum: 0, maximum: 9007199254740991 }),
  "Timestamp": Type.String({ pattern: "Z$", format: "date-time" }),
  "TypeId": Type.String({ minLength: 1, maxLength: 256, pattern: "^(?:[a-z][a-z0-9.-]*|@[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*)/[a-zA-Z0-9._/-]+@[1-9][0-9]*$" }),
  "Digest": Type.String({ pattern: "^[a-f0-9]{64}$" }),
  "SchemaRef": Type.Object({ "typeId": Type.Ref('TypeId'), "revision": Type.Ref('UInt53'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "BlobRef": Type.Object({ "authorityId": Type.Ref('Id'), "blobId": Type.Ref('Id'), "digest": Type.Ref('Digest'), "bytes": Type.Ref('UInt53'), "mediaType": Type.String(), "pinId": Type.Ref('Id') }, { additionalProperties: false }),
  "DataRef": Type.Union([Type.Object({ "kind": Type.Literal('inline'), "schema": Type.Ref('SchemaRef'), "value": JsonValue, "digest": Type.Ref('Digest'), "bytes": Type.Ref('UInt53') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('blob'), "schema": Type.Ref('SchemaRef'), "blob": Type.Ref('BlobRef') }, { additionalProperties: false })]),
  "RuntimeErrorCode": Type.Union([Type.Literal('invalid_input'), Type.Literal('denied'), Type.Literal('incompatible'), Type.Literal('quota'), Type.Literal('cancelled'), Type.Literal('timeout'), Type.Literal('retryable'), Type.Literal('unknown_effect'), Type.Literal('conflict'), Type.Literal('internal')]),
  "OwnerRef": Type.Object({ "kind": Type.Union([Type.Literal('run'), Type.Literal('action'), Type.Literal('job'), Type.Literal('reconciliation')]), "id": Type.Ref('Id') }, { additionalProperties: false }),
  "RetryAdvice": Type.Union([Type.Object({ "kind": Type.Literal('never') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('retry_read'), "notBefore": Type.Optional(Type.Ref('Timestamp')) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('retry_same_action'), "notBefore": Type.Optional(Type.Ref('Timestamp')) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('reconcile'), "ownerRef": Type.Ref('OwnerRef') }, { additionalProperties: false })]),
  "RuntimeError": Type.Object({ "code": Type.Ref('RuntimeErrorCode'), "detailCode": Type.String(), "message": Type.String(), "retryAdvice": Type.Ref('RetryAdvice'), "diagnosticId": Type.Ref('Id'), "safeDetail": Type.Optional(JsonValue) }, { additionalProperties: false }),
  "BindingRef": Type.Object({ "bindingId": Type.Ref('Id'), "contract": Type.String(), "logicalName": Type.String(), "providerId": Type.Ref('Id') }, { additionalProperties: false }),
  "StateCommitReceipt": Type.Object({ "commitId": Type.Ref('Id'), "transactionFingerprint": Type.Ref('Digest'), "sessionId": Type.Ref('Id'), "firstSeq": Type.Ref('UInt53'), "lastSeq": Type.Ref('UInt53'), "headDigest": Type.Ref('Digest'), "runRevision": Type.Ref('UInt53'), "actionIds": Type.Array(Type.Object({ "key": Type.String(), "actionId": Type.Ref('Id') }, { additionalProperties: false }), { maxItems: 10000 }) }, { additionalProperties: false }),
  "StateAuthorityRef": Type.Object({ "authorityId": Type.Ref('Id'), "tenantId": Type.Ref('Id'), "authorityEpoch": Type.Ref('UInt53') }, { additionalProperties: false }),
  "ReadGuard": Type.Object({ "recordId": Type.Ref('Id'), "expectedRecordRevision": Type.Union([Type.Ref('UInt53'), Type.Null()]) }, { additionalProperties: false }),
  "ScopeRef": Type.Union([Type.Object({ "installationId": Type.Ref('Id'), "kind": Type.Literal('installation') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "kind": Type.Literal('runtime') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "kind": Type.Literal('workspace') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "kind": Type.Literal('session') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "runId": Type.Ref('Id'), "kind": Type.Literal('run') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "runId": Type.Ref('Id'), "kind": Type.Literal('action'), "actionId": Type.Ref('Id') }, { additionalProperties: false })]),
  "DomainReference": Type.Object({ "authorityId": Type.Ref('Id'), "recordId": Type.Ref('Id'), "recordRevision": Type.Ref('UInt53'), "schema": Type.Ref('SchemaRef'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "OutboxRecord": Type.Union([Type.Object({ "eventId": Type.Ref('Id'), "sourceAuthorityId": Type.Ref('Id'), "sourceCommitId": Type.Ref('Id'), "destination": Type.Ref('Id'), "typeId": Type.Ref('TypeId'), "payload": Type.Ref('DataRef'), "fingerprint": Type.Ref('Digest'), "delivery": Type.Union([Type.Literal('pending'), Type.Literal('claimed'), Type.Literal('acked')]), "attempts": Type.Ref('UInt53'), "nextAttemptAt": Type.Ref('Timestamp'), "claim": Type.Union([Type.Object({ "ownerId": Type.Ref('Id'), "epoch": Type.Ref('UInt53'), "until": Type.Ref('Timestamp') }, { additionalProperties: false }), Type.Null()]), "ackRef": Type.Union([Type.Ref('Id'), Type.Null()]), "consecutiveFailures": Type.Ref('UInt53'), "lastError": Type.Union([Type.Ref('RuntimeError'), Type.Null()]) }, { additionalProperties: false }), Type.Object({ "eventId": Type.Ref('Id'), "sourceAuthorityId": Type.Ref('Id'), "sourceCommitId": Type.Ref('Id'), "destination": Type.Ref('Id'), "typeId": Type.Ref('TypeId'), "payload": Type.Ref('DataRef'), "fingerprint": Type.Ref('Digest'), "delivery": Type.Literal('dead'), "attempts": Type.Ref('UInt53'), "nextAttemptAt": Type.Ref('Timestamp'), "claim": Type.Union([Type.Object({ "ownerId": Type.Ref('Id'), "epoch": Type.Ref('UInt53'), "until": Type.Ref('Timestamp') }, { additionalProperties: false }), Type.Null()]), "ackRef": Type.Union([Type.Ref('Id'), Type.Null()]), "consecutiveFailures": Type.Ref('UInt53'), "lastError": Type.Ref('RuntimeError') }, { additionalProperties: false })]),
  "StateLeaseRequest": Type.Object({ "requestId": Type.Ref('Id'), "authority": Type.Ref('StateAuthorityRef'), "sessionId": Type.Ref('Id'), "writerId": Type.Ref('Id'), "operation": Type.Union([Type.Literal('acquire'), Type.Literal('renew'), Type.Literal('release'), Type.Literal('reclaim')]), "expectedWriterEpoch": Type.Union([Type.Ref('UInt53'), Type.Null()]), "expectedLastSeq": Type.Ref('UInt53'), "ttlMs": Type.Ref('UInt53') }, { additionalProperties: false }),
  "WriterClaim": Type.Object({ "scopeId": Type.Ref('Id'), "writerId": Type.Ref('Id'), "writerEpoch": Type.Ref('UInt53'), "leaseUntil": Type.Ref('Timestamp'), "authorityEpoch": Type.Ref('UInt53') }, { additionalProperties: false }),
  "ArtifactVersion": Type.Integer({ minimum: 1, maximum: 9007199254740991 }),
  "ArtifactRef": Type.Object({ "artifactId": Type.Ref('Id'), "version": Type.Ref('ArtifactVersion') }, { additionalProperties: false }),
  "Revision": Type.Ref('UInt53'),
  "DomainObjectRef": Type.Object({ "authorityId": Type.Ref('Id'), "typeId": Type.Ref('TypeId'), "id": Type.Ref('Id'), "revision": Type.Ref('Revision') }, { additionalProperties: false }),
  "ReceiptPointer": Type.Object({ "authorityId": Type.Ref('Id'), "receiptId": Type.Ref('Id'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "ThinkingLevel": Type.Union([Type.Literal('off'), Type.Literal('minimal'), Type.Literal('low'), Type.Literal('medium'), Type.Literal('high'), Type.Literal('xhigh'), Type.Literal('max')]),
  "ContentBlock": Type.Union([Type.Object({ "type": Type.Literal('text'), "text": Type.String({ maxLength: 1048576 }) }, { additionalProperties: false }), Type.Object({ "type": Type.Literal('image'), "data": Type.String(), "mimeType": Type.String({ maxLength: 128 }) }, { additionalProperties: false }), Type.Object({ "type": Type.Literal('resource_link'), "uri": Type.String({ maxLength: 4096 }), "name": Type.Optional(Type.String({ maxLength: 256 })), "mimeType": Type.Optional(Type.String({ maxLength: 128 })) }, { additionalProperties: false })]),
  "SlotName": Type.Union([Type.Literal('primary'), Type.Literal('escalation'), Type.Literal('fast'), Type.Literal('compaction'), Type.Literal('verifier'), Type.Literal('image'), Type.Literal('video')]),
  "SessionControlCommand": Type.Union([Type.Object({ "kind": Type.Union([Type.Literal('prompt'), Type.Literal('steer'), Type.Literal('follow-up')]), "content": Type.Array(Type.Ref('ContentBlock'), { maxItems: 10000 }) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('compact'), "instructions": Type.Union([Type.String(), Type.Null()]) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('fork'), "atNativeSeq": Type.Ref('UInt53'), "childSessionId": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('set-preset'), "presetId": Type.Ref('Id'), "presetDigest": Type.Ref('Digest'), "apply": Type.Union([Type.Literal('next-request'), Type.Literal('next-run')]) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('set-model'), "slot": Type.Ref('SlotName'), "route": Type.String(), "model": Type.String(), "thinking": Type.Union([Type.Ref('ThinkingLevel'), Type.Null()]) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('set-yolo'), "enabled": Type.Boolean() }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('cancel'), "runId": Type.Ref('Id'), "reason": Type.String() }, { additionalProperties: false })]),
  "SessionControlRequest": Type.Object({ "sessionId": Type.Ref('Id'), "requestId": Type.Ref('Id'), "expectedRevision": Type.Union([Type.Ref('UInt53'), Type.Null()]), "command": Type.Ref('SessionControlCommand') }, { additionalProperties: false }),
  "ApprovalRespondRequest": Type.Union([Type.Object({ "interactionId": Type.Ref('Id'), "responseId": Type.Ref('Id'), "expectedVersion": Type.Ref('UInt53'), "decision": Type.Literal('approve'), "grantScope": Type.Optional(Type.Union([Type.Literal('once'), Type.Literal('session'), Type.Literal('permanent')])), "intentDigest": Type.Ref('Digest') }, { additionalProperties: false }), Type.Object({ "interactionId": Type.Ref('Id'), "responseId": Type.Ref('Id'), "expectedVersion": Type.Ref('UInt53'), "decision": Type.Literal('deny'), "intentDigest": Type.Ref('Digest') }, { additionalProperties: false })]),
  "Externalsession_v1_ContentBlock": Type.Union([Type.Object({ "type": Type.Literal('text'), "text": Type.String({ maxLength: 1048576 }) }, { additionalProperties: false }), Type.Object({ "type": Type.Literal('image'), "data": Type.String(), "mimeType": Type.String({ maxLength: 128 }) }, { additionalProperties: false }), Type.Object({ "type": Type.Literal('resource_link'), "uri": Type.String({ maxLength: 4096 }), "name": Type.Optional(Type.String({ maxLength: 256 })), "mimeType": Type.Optional(Type.String({ maxLength: 128 })) }, { additionalProperties: false })]),
  "Externalsession_v1_ArtifactRef": Type.Object({ "sha256": Type.String({ pattern: "^[0-9a-f]{64}$" }), "size": Type.Integer({ minimum: 0 }), "mime": Type.String({ maxLength: 128 }) }, { additionalProperties: false }),
  "Externaljobs_ContentBlock": Type.Ref('Externalsession_v1_ContentBlock'),
  "Externaljobs_JsonValue": Externalsession_v1_JsonValue,
  "Externaljobs_Schedule": Type.Union([Type.Object({ "kind": Type.Literal('once') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('at'), "at": Type.Integer({ minimum: 0 }) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('every'), "everyMs": Type.Integer({ minimum: 1000 }), "anchorMs": Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('cron'), "expr": Type.String({ maxLength: 128 }), "tz": Type.Optional(Type.String({ maxLength: 64 })), "staggerMs": Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false })]),
  "Externaljobs_JobSpec": Type.Object({ "idempotencyKey": Type.String({ maxLength: 256 }), "sessionKey": Type.String({ maxLength: 512 }), "payload": Type.Union([Type.Object({ "prompt": Type.Union([Type.String({ maxLength: 65536 }), Type.Array(Type.Ref('Externaljobs_ContentBlock'))]), "delivery": Type.Optional(Type.Union([Type.Literal('steer'), Type.Literal('follow_up')])) }, { additionalProperties: false }), Type.Object({ "command": Type.Object({ "method": Type.String({ pattern: "^(?:resume|_agnes/v1/[A-Za-z][A-Za-z0-9./_-]*)$" }), "params": Type.Ref('Externaljobs_JsonValue') }, { additionalProperties: false }) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('directory.sync'), "channel": Type.String({ minLength: 1, maxLength: 64 }) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('shell'), "command": Type.String({ maxLength: 65536 }), "cwd": Type.String({ maxLength: 4096 }) }, { additionalProperties: false })]), "schedule": Type.Ref('Externaljobs_Schedule'), "budget": Type.Optional(Type.Number({ minimum: 0 })), "protected": Type.Optional(Type.Boolean()), "maxAttempts": Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) }, { additionalProperties: false }),
  "Externalagnes_v1_JobSpec": Type.Ref('Externaljobs_JobSpec'),
  "JobSpec": Type.Ref('Externalagnes_v1_JobSpec'),
  "Cursor": Type.String(),
  "RecordOwner": Type.Object({ "authority": Type.Ref('StateAuthorityRef'), "scope": Type.Ref('ScopeRef'), "ownerBinding": Type.Ref('BindingRef') }, { additionalProperties: false }),
  "AuthorizedViewScope": Type.Union([Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "kind": Type.Literal('workspace') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "kind": Type.Literal('session') }, { additionalProperties: false })]),
  "ArtifactTitle": Object.assign(Type.String({ minLength: 1, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), {"x-max-utf8-bytes":1024}),
  "ArtifactMediaType": Object.assign(Type.String({ pattern: "^[a-z0-9][a-z0-9!#$&^_.+\\-]*/[a-z0-9][a-z0-9!#$&^_.+\\-]*$" }), {"x-max-utf8-bytes":255}),
  "ArtifactReadyView": Type.Object({ "artifactId": Type.Ref('Id'), "version": Type.Ref('ArtifactVersion'), "title": Type.Ref('ArtifactTitle'), "mime": Type.Ref('ArtifactMediaType'), "size": Type.Ref('UInt53'), "status": Type.Literal('ready') }, { additionalProperties: false }),
  "DomainQuery": Type.Object({ "domainType": Type.String(), "query": Type.Ref('DataRef'), "scope": Type.Ref('ScopeRef'), "cursor": Type.Union([Type.String(), Type.Null()]), "limit": Type.Integer({ minimum: 1, maximum: 500 }) }, { additionalProperties: false }),
  "DomainActionRef": Type.Object({ "viewId": Type.String(), "actionKey": Type.String(), "viewRevision": Type.Number() }, { additionalProperties: false }),
  "ApprovalGrantBindingInput": Type.Object({ "sessionId": Type.Ref('Id'), "toolId": Type.String(), "scope": Type.String(), "policyVersion": Type.String() }, { additionalProperties: false }),
  "JobTarget": Type.Union([Type.Object({ "kind": Type.Literal('pin'), "releaseSetId": Type.Ref('Id'), "bindingId": Type.Ref('Id'), "presetRef": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('follow'), "routeId": Type.Ref('Id'), "presetRef": Type.Ref('Id') }, { additionalProperties: false })]),
  "JobSchedule": Type.Union([Type.Object({ "kind": Type.Literal('once'), "at": Type.Ref('Timestamp') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('rrule'), "rrule": Type.String(), "timezone": Type.String(), "startsAt": Type.Ref('Timestamp'), "ambiguousLocalTime": Type.Union([Type.Literal('earlier'), Type.Literal('later')]), "nonexistentLocalTime": Type.Union([Type.Literal('skip'), Type.Literal('next-valid')]) }, { additionalProperties: false })]),
  "JobPolicy": Type.Object({ "missed": Type.Union([Type.Literal('skip'), Type.Literal('latest'), Type.Literal('catch-up')]), "maxCatchUp": Type.Ref('UInt53'), "concurrency": Type.Union([Type.Literal('forbid'), Type.Literal('queue'), Type.Literal('parallel')]), "maxConcurrent": Type.Ref('UInt53'), "maxAttempts": Type.Ref('UInt53'), "retryDelayMs": Type.Ref('UInt53'), "retryMaxDelayMs": Type.Ref('UInt53') }, { additionalProperties: false }),
  "JobEdit": Type.Object({ "schedule": Type.Optional(Type.Ref('JobSchedule')), "policy": Type.Optional(Type.Ref('JobPolicy')), "target": Type.Optional(Type.Ref('JobTarget')), "inputRef": Type.Optional(Type.Ref('DataRef')), "budgetAccount": Type.Optional(Type.Ref('DomainObjectRef')), "status": Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('paused')])) }, { additionalProperties: false }),
  "DomainCommandClientSubmitRequest": Type.Object({ "action": Type.Ref('DomainActionRef'), "input": Type.Ref('DataRef'), "requestId": Type.String(), "expectedRevision": Type.Number(), "commandSchema": Type.Ref('SchemaRef') }, { additionalProperties: false }),
  "DomainCommandClientCommandStatusRequest": Type.String(),
  "ShellConversationClientCreateRequest": Type.Object({ "workspaceId": Type.String(), "presetId": Type.String(), "requestId": Type.String() }, { additionalProperties: false }),
  "ShellConversationClientOpenRequest": Type.Object({ "sessionId": Type.String(), "limit": Type.Number() }, { additionalProperties: false }),
  "ShellConversationClientHistoryRequest": Type.Object({ "sessionId": Type.String(), "cursor": Type.String(), "limit": Type.Number() }, { additionalProperties: false }),
  "ShellConversationClientSubmitRequest": Type.Object({ "sessionId": Type.String(), "kind": Type.Union([Type.Literal('prompt'), Type.Literal('follow-up')]), "content": Type.Array(Type.Ref('ContentBlock'), { maxItems: 10000 }), "requestId": Type.String(), "expectedGeneration": Type.Number() }, { additionalProperties: false }),
  "ShellConversationClientCancelRequest": Type.Object({ "sessionId": Type.String(), "runId": Type.String(), "requestId": Type.String() }, { additionalProperties: false }),
  "ShellConversationClientStatusRequest": Type.String(),
  "SessionControlClientStatusRequest": Type.Object({ "sessionId": Type.Ref('Id'), "requestId": Type.Ref('Id') }, { additionalProperties: false }),
  "SessionBudgetClientReadRequest": Type.Object({ "sessionId": Type.Ref('Id') }, { additionalProperties: false }),
  "PermissionClientRevokeGrantRequest": Type.Object({ "sessionId": Type.Ref('Id'), "toolId": Type.String(), "scope": Type.String(), "policyVersion": Type.String(), "grantId": Type.Ref('Id'), "requestId": Type.Ref('Id') }, { additionalProperties: false }),
  "SessionJobsClientEnqueueRequest": Type.Object({ "requestId": Type.Ref('Id'), "spec": Type.Ref('JobSpec') }, { additionalProperties: false }),
  "SessionJobsClientPollRequest": Type.Object({ "jobId": Type.Ref('Id') }, { additionalProperties: false }),
  "SessionJobsClientCancelRequest": Type.Object({ "jobId": Type.Ref('Id'), "requestId": Type.Ref('Id') }, { additionalProperties: false }),
  "SessionJobsClientCreateRequest": Type.Object({ "requestId": Type.Ref('Id'), "schedule": Type.Ref('JobSchedule'), "policy": Type.Ref('JobPolicy'), "target": Type.Ref('JobTarget'), "inputRef": Type.Ref('DataRef'), "budgetAccount": Type.Ref('DomainObjectRef') }, { additionalProperties: false }),
  "SessionJobsClientUpdateRequest": Type.Object({ "requestId": Type.Ref('Id'), "id": Type.Ref('Id'), "expectedRevision": Type.Ref('Revision'), "changes": Type.Ref('JobEdit') }, { additionalProperties: false }),
  "SessionJobsClientInspectRequest": Type.Object({ "id": Type.Ref('Id'), "cursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "limit": Type.Ref('UInt53') }, { additionalProperties: false }),
  "SessionJobsClientCancelDefinitionRequest": Type.Object({ "requestId": Type.Ref('Id'), "id": Type.Ref('Id'), "expectedRevision": Type.Ref('Revision'), "reason": Type.String(), "cancelActive": Type.Boolean() }, { additionalProperties: false }),
  "InteractionClientPendingRequest": Type.Object({ "scope": Type.Ref('AuthorizedViewScope'), "cursor": Type.Optional(Type.Ref('Cursor')), "limit": Type.Optional(Type.Ref('UInt53')) }, { additionalProperties: false }),
  "InteractionClientRespondRequest": Type.Object({ "interactionId": Type.Ref('Id'), "responseId": Type.Ref('Id'), "expectedVersion": Type.Ref('UInt53'), "answer": Type.Ref('DataRef') }, { additionalProperties: false }),
  "ArtifactClientOpenDownloadRequest": Type.Object({ "artifactId": Type.Ref('Id'), "version": Type.Ref('ArtifactVersion'), "disposition": Type.Union([Type.Literal('inline'), Type.Literal('attachment')]) }, { additionalProperties: false }),
  "ClientInteractionFormLinkInput": Type.Object({ "interactionId": Type.Ref('Id'), "expectedVersion": Type.Ref('UInt53') }, { additionalProperties: false }),
  "ArtifactDescribeInput": Type.Object({ "artifactId": Type.Ref('Id'), "version": Type.Ref('ArtifactVersion') }, { additionalProperties: false }),
  "ClientCallHeader": Type.Object({ "negotiatedSession": Type.Ref('Id'), "clientInstanceId": Type.Ref('Id'), "catalogRevision": Type.Ref('UInt53'), "callId": Type.Ref('Id') }, { additionalProperties: false }),
  "ClientCatalogStatusRequest": Type.Object({ "header": Type.Ref('ClientCallHeader') }, { additionalProperties: false }),
  "ClientArtifactStreamStatusRequest": Type.Object({ "header": Type.Ref('ClientCallHeader'), "streamId": Type.Ref('Id') }, { additionalProperties: false }),
  "ConversationListRequest": Type.Object({ "scope": Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "kind": Type.Literal('workspace') }, { additionalProperties: false }), "text": Type.Union([Object.assign(Type.String(), {"x-max-utf8-bytes":1024}), Type.Null()]), "cursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "limit": Type.Integer({ minimum: 1, maximum: 128 }) }, { additionalProperties: false }),
  "ClientQueryCall": Type.Union([Type.Object({ "operation": Type.Literal('conversation.open'), "input": Type.Ref('ShellConversationClientOpenRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('conversation.history'), "input": Type.Ref('ShellConversationClientHistoryRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('conversation.status'), "input": Type.Ref('ShellConversationClientStatusRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('domain.query'), "input": Type.Ref('DomainQuery') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('domain.commandStatus'), "input": Type.Ref('DomainCommandClientCommandStatusRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('control.read'), "input": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('control.status'), "input": Type.Ref('SessionControlClientStatusRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('budget.read'), "input": Type.Ref('SessionBudgetClientReadRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('permission.listGrants'), "input": Type.Ref('ApprovalGrantBindingInput') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('jobs.poll'), "input": Type.Ref('SessionJobsClientPollRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('jobs.inspect'), "input": Type.Ref('SessionJobsClientInspectRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('jobs.commandStatus'), "input": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('interaction.pending'), "input": Type.Ref('InteractionClientPendingRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('interaction.read'), "input": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('interaction.responseStatus'), "input": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('approval.read'), "input": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('approval.responseStatus'), "input": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('artifact.describe'), "input": Type.Ref('ArtifactDescribeInput') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('transport.catalogStatus'), "input": Type.Ref('ClientCatalogStatusRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('transport.streamStatus'), "input": Type.Ref('ClientArtifactStreamStatusRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('conversation.list'), "input": Type.Ref('ConversationListRequest') }, { additionalProperties: false })]),
  "ClientQueryRequest": Object.assign(Type.Object({ "header": Type.Ref('ClientCallHeader'), "call": Type.Ref('ClientQueryCall') }, { additionalProperties: false }), {"x-max-canonical-json-bytes":1048576}),
  "ClientCommandCall": Type.Union([Type.Object({ "operation": Type.Literal('conversation.create'), "input": Type.Ref('ShellConversationClientCreateRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('conversation.submit'), "input": Type.Ref('ShellConversationClientSubmitRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('conversation.cancel'), "input": Type.Ref('ShellConversationClientCancelRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('domain.submit'), "input": Type.Ref('DomainCommandClientSubmitRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('control.submit'), "input": Type.Ref('SessionControlRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('permission.revokeGrant'), "input": Type.Ref('PermissionClientRevokeGrantRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('jobs.enqueue'), "input": Type.Ref('SessionJobsClientEnqueueRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('jobs.cancel'), "input": Type.Ref('SessionJobsClientCancelRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('jobs.create'), "input": Type.Ref('SessionJobsClientCreateRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('jobs.update'), "input": Type.Ref('SessionJobsClientUpdateRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('jobs.cancelDefinition'), "input": Type.Ref('SessionJobsClientCancelDefinitionRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('interaction.respond'), "input": Type.Ref('InteractionClientRespondRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('interaction.formLink'), "input": Type.Ref('ClientInteractionFormLinkInput') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('approval.respond'), "input": Type.Ref('ApprovalRespondRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('approval.formLink'), "input": Type.Ref('ClientInteractionFormLinkInput') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('artifact.openDownload'), "input": Type.Ref('ArtifactClientOpenDownloadRequest') }, { additionalProperties: false })]),
  "ClientCommandRequest": Object.assign(Type.Object({ "header": Type.Ref('ClientCallHeader'), "call": Type.Ref('ClientCommandCall') }, { additionalProperties: false }), {"x-max-canonical-json-bytes":1048576}),
  "ClientArtifactStreamMetadata": Type.Object({ "streamId": Type.Ref('Id'), "offset": Type.Ref('UInt53'), "totalBytes": Type.Ref('UInt53') }, { additionalProperties: false }),
  "ClientModuleCredentialBinding": Type.Object({ "principalRef": Type.Ref('Id'), "tenantRef": Type.Ref('Id'), "authRevision": Type.Ref('Revision'), "credentialRevision": Type.Ref('UInt53'), "negotiatedSession": Type.Ref('Id'), "clientInstanceId": Type.Ref('Id'), "moduleId": Type.Ref('Id'), "packageDigest": Type.Ref('Digest'), "assetDigest": Type.Ref('Digest'), "moduleGeneration": Type.Ref('UInt53'), "ownerRef": Type.Ref('OwnerRef'), "catalogRevision": Type.Ref('UInt53'), "expiresAt": Type.Ref('Timestamp'), "channelBinding": Type.Ref('Digest'), "operations": Type.Array(Object.assign(Type.String({ minLength: 1 }), {"x-max-utf8-bytes":128}), { maxItems: 256, uniqueItems: true }), "allowedActions": Type.Array(Type.Ref('DomainActionRef'), { maxItems: 256 }), "moduleReady": Type.Literal(true) }, { additionalProperties: false }),
  "ClientTransportRequestFrame": Object.assign(Type.Union([Type.Object({ "kind": Type.Literal('query'), "request": Type.Ref('ClientQueryRequest') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('command'), "request": Type.Ref('ClientCommandRequest') }, { additionalProperties: false })]), {"x-max-canonical-json-bytes":1048576}),
  "TransportEvidenceProof": Type.Union([Type.Object({ "kind": Type.Literal('in-process'), "issuerBindingId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('signed'), "issuerBindingId": Type.Ref('Id'), "keyId": Type.Ref('Id'), "expiresAt": Type.Ref('Timestamp'), "signature": Object.assign(Type.String({ minLength: 1 }), {"x-max-utf8-bytes":1024}) }, { additionalProperties: false })]),
  "TransportAuthenticationEvidence": Type.Object({ "bindingId": Type.Ref('Id'), "ingressId": Type.Ref('Id'), "requestNonce": Type.Ref('Id'), "receivedAt": Type.Ref('Timestamp'), "transport": Type.Union([Type.Literal('http'), Type.Literal('websocket')]), "method": Type.Union([Type.Literal('GET'), Type.Literal('POST')]), "path": Object.assign(Type.String({ minLength: 1 }), {"x-max-utf8-bytes":2048}), "origin": Type.Union([Object.assign(Type.String({ minLength: 1 }), {"x-max-utf8-bytes":2048}), Type.Null()]), "authority": Object.assign(Type.String({ minLength: 1 }), {"x-max-utf8-bytes":512}), "peerLoopback": Type.Boolean(), "tls": Type.Boolean(), "channelBinding": Type.Ref('Digest'), "proof": Type.Ref('TransportEvidenceProof') }, { additionalProperties: false }),
  "TransportCredentialEnvelope": Type.Union([Type.Object({ "kind": Type.Literal('bearer'), "token": Object.assign(Type.String({ minLength: 1 }), {"x-max-utf8-bytes":8192}) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('session-cookie'), "token": Object.assign(Type.String({ minLength: 1 }), {"x-max-utf8-bytes":8192}) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('module-session'), "token": Object.assign(Type.String({ minLength: 1 }), {"x-max-utf8-bytes":8192}) }, { additionalProperties: false })]),
  "ArtifactContentDescriptor": Type.Object({ "title": Type.Ref('ArtifactTitle'), "mediaType": Type.Ref('ArtifactMediaType'), "bytes": Type.Ref('UInt53'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "ArtifactsFailRequest": Type.Object({ "publicationId": Type.Ref('Id'), "expectedRevision": Type.Ref('Revision'), "failureRef": Type.Ref('ReceiptPointer') }, { additionalProperties: false }),
  "ArtifactAccessGrantValue": Type.Object({ "grantId": Type.Ref('Id'), "artifact": Type.Ref('ArtifactRef'), "granteePrincipalRef": Type.Ref('Id'), "scope": Type.Ref('ScopeRef'), "permissions": Type.Array(Type.Union([Type.Literal('read'), Type.Literal('download')]), { minItems: 1, maxItems: 2, uniqueItems: true }), "expiresAt": Type.Union([Type.Ref('Timestamp'), Type.Null()]), "revision": Type.Ref('Revision'), "status": Type.Union([Type.Literal('active'), Type.Literal('revoked')]), "sourceAuthorizationRef": Type.Ref('Id') }, { additionalProperties: false }),
  "ArtifactsGrantRequest": Type.Object({ "requestId": Type.Ref('Id'), "artifactRef": Type.Ref('ArtifactRef'), "granteePrincipalRef": Type.Ref('Id'), "scope": Type.Ref('ScopeRef'), "permissions": Type.Array(Type.Union([Type.Literal('read'), Type.Literal('download')]), { minItems: 1, maxItems: 2, uniqueItems: true }), "expiresAt": Type.Union([Type.Ref('Timestamp'), Type.Null()]) }, { additionalProperties: false }),
  "ArtifactsRevokeGrantRequest": Type.Object({ "requestId": Type.Ref('Id'), "grantId": Type.Ref('Id'), "expectedRevision": Type.Ref('Revision'), "reason": Type.String() }, { additionalProperties: false }),
  "ArtifactRedeemDownloadRequest": Type.Object({ "ticketId": Type.Ref('Id'), "nonce": Type.String({ minLength: 43, maxLength: 43, pattern: "^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$" }), "offset": Type.Ref('UInt53') }, { additionalProperties: false }),
  "ArtifactDownloadPresentation": Type.Object({ "artifact": Type.Ref('ArtifactReadyView'), "disposition": Type.Union([Type.Literal('inline'), Type.Literal('attachment')]), "expiresAt": Type.Ref('Timestamp'), "grantRevision": Type.Ref('UInt53') }, { additionalProperties: false }),
  "ArtifactDownloadMetadata": Type.Object({ "stream": Type.Ref('ClientArtifactStreamMetadata'), "download": Type.Ref('ArtifactDownloadPresentation') }, { additionalProperties: false }),
  "LegacyArtifactRef": Type.Ref('Externalsession_v1_ArtifactRef'),
  "LegacyArtifactMappingValue": Type.Object({ "legacy": Type.Ref('LegacyArtifactRef'), "sessionId": Type.Ref('Id'), "laneId": Type.Ref('Id'), "ownerPrincipalRef": Type.Ref('Id'), "artifact": Type.Ref('ArtifactRef'), "blob": Type.Ref('BlobRef'), "migrationId": Type.Ref('Id'), "sourceEvidenceRef": Type.Ref('DomainReference') }, { additionalProperties: false }),
  "OutboxDeliveryKey": Type.Object({ "sourceAuthorityId": Type.Ref('Id'), "eventId": Type.Ref('Id'), "destination": Type.Ref('Id') }, { additionalProperties: false }),
  "OutboxDeadLettersRequest": Type.Object({ "scope": Type.Ref('ScopeRef'), "destination": Type.Union([Type.Ref('Id'), Type.Null()]), "cursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "limit": Type.Integer({ minimum: 1, maximum: 500 }) }, { additionalProperties: false }),
  "OutboxDeadLetterItem": Type.Object({ "delivery": Type.Ref('OutboxDeliveryKey'), "outbox": Type.Ref('OutboxRecord'), "owner": Type.Ref('RecordOwner'), "deliveryRevision": Type.Ref('UInt53'), "deadAt": Type.Ref('Timestamp') }, { additionalProperties: false }),
  "PageOutboxDeadLetterItem": Type.Object({ "items": Type.Array(Type.Ref('OutboxDeadLetterItem'), { maxItems: 500 }), "snapshot": Type.Ref('Id'), "nextCursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "complete": Type.Boolean() }, { additionalProperties: false }),
  "OutboxRedriveRequest": Type.Object({ "requestId": Type.Ref('Id'), "scope": Type.Ref('ScopeRef'), "delivery": Type.Ref('OutboxDeliveryKey'), "expectedDeliveryRevision": Type.Ref('UInt53'), "reason": Object.assign(Type.String({ minLength: 1 }), {"x-max-utf8-bytes":8192}) }, { additionalProperties: false }),
  "OutboxRedriveResult": Type.Object({ "delivery": Type.Ref('OutboxDeliveryKey'), "state": Type.Literal('pending'), "deliveryRevision": Type.Ref('UInt53') }, { additionalProperties: false }),
  "OutboxRedriveRecord": Type.Object({ "owner": Type.Ref('RecordOwner'), "request": Type.Ref('OutboxRedriveRequest'), "actorRef": Type.Ref('Id'), "fingerprint": Type.Ref('Digest'), "acceptedAt": Type.Ref('Timestamp'), "authorizationRef": Type.Ref('Id'), "result": Type.Ref('OutboxRedriveResult') }, { additionalProperties: false }),
  "Externalchannel_JwtCredential": Type.Object({ "kind": Type.Literal('jwt'), "token": Type.String({ maxLength: 8192 }) }, { additionalProperties: false }),
  "Externalchannel_SourceAuthCredential": Type.Object({ "kind": Type.Literal('source-auth'), "timestamp": Type.Integer(), "signature": Type.String({ pattern: "^v0=[0-9a-f]{64}$" }), "nonce": Type.String({ pattern: "^[0-9a-f]{32}$" }) }, { additionalProperties: false }),
  "Externalchannel_PortalIdentityCredential": Type.Object({ "kind": Type.Literal('portal-identity'), "token": Type.String({ maxLength: 8192 }) }, { additionalProperties: false }),
  "Externalchannel_LocalCredential": Type.Object({ "kind": Type.Literal('local') }, { additionalProperties: false }),
  "Externalchannel_SurfaceAuthCredential": Type.Object({ "kind": Type.Literal('surface'), "sourceId": Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9-]{0,63}$" }), "source": Type.Ref('Externalchannel_SourceAuthCredential'), "subject": Type.Union([Type.Ref('Externalchannel_JwtCredential'), Type.Ref('Externalchannel_PortalIdentityCredential')]) }, { additionalProperties: false }),
  "Externalchannel_Auth": Type.Union([Type.Ref('Externalchannel_JwtCredential'), Type.Ref('Externalchannel_SourceAuthCredential'), Type.Ref('Externalchannel_PortalIdentityCredential'), Type.Ref('Externalchannel_LocalCredential'), Type.Ref('Externalchannel_SurfaceAuthCredential')]),
  "Externalagnes_v1_Auth": Type.Ref('Externalchannel_Auth'),
  "LegacyIdentityCredentialEnvelope": Type.Ref('Externalagnes_v1_Auth'),
  "LegacyIdentityTransportEvidence": Type.Object({ "bindingId": Type.Ref('Id'), "ingressId": Type.Ref('Id'), "connectionId": Type.Ref('Id'), "initializeDigest": Type.Ref('Digest'), "receivedAt": Type.Ref('Timestamp'), "channelBinding": Type.Ref('Digest'), "clientId": Type.String(), "transport": Type.Union([Type.Literal('local'), Type.Literal('rpc'), Type.Literal('websocket')]), "localGate": Type.Union([Type.Literal('none'), Type.Literal('local-peer'), Type.Literal('loopback-host-origin')]), "proof": Type.Ref('TransportEvidenceProof') }, { additionalProperties: false }),
  "StateScanResult": Type.Object({ "items": Type.Array(Type.Ref('DataRef'), { maxItems: 500 }), "snapshot": Type.Ref('Id'), "nextCursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "complete": Type.Boolean() }, { additionalProperties: false }),
  "StateProbeCommitRequest": Type.Object({ "commitId": Type.Ref('Id') }, { additionalProperties: false }),
  "StateProbeCommitResult": Type.Union([Type.Ref('StateCommitReceipt'), Type.Null()]),
  "StateLeaseRecordValue": Type.Object({ "sessionId": Type.Ref('Id'), "lastWriterEpoch": Type.Ref('UInt53'), "claim": Type.Union([Type.Ref('WriterClaim'), Type.Null()]) }, { additionalProperties: false }),
  "StateLeaseProofValue": Type.Object({ "request": Type.Ref('StateLeaseRequest'), "requestFingerprint": Type.Ref('Digest'), "evaluatedAt": Type.Ref('Timestamp'), "sessionIdentityVersion": Type.Ref('ReadGuard'), "previousLeaseVersion": Type.Union([Type.Ref('ReadGuard'), Type.Null()]), "leaseVersion": Type.Ref('ReadGuard') }, { additionalProperties: false }),
  "StateWriteOpenRequest": Type.Object({ "requestId": Type.Ref('Id'), "authority": Type.Ref('StateAuthorityRef'), "sessionId": Type.Ref('Id'), "mode": Type.Literal('write'), "writerId": Type.Ref('Id'), "ttlMs": Type.Ref('UInt53') }, { additionalProperties: false }),
  "StateWriteOpenProofValue": Type.Object({ "request": Type.Ref('StateWriteOpenRequest'), "requestFingerprint": Type.Ref('Digest'), "evaluatedAt": Type.Ref('Timestamp'), "sessionIdentityVersion": Type.Ref('ReadGuard'), "previousLeaseVersion": Type.Union([Type.Ref('ReadGuard'), Type.Null()]), "leaseVersion": Type.Ref('ReadGuard'), "snapshotId": Type.Ref('Id'), "snapshotExpiresAt": Type.Ref('Timestamp'), "snapshotCommitId": Type.Ref('Id') }, { additionalProperties: false }),
  "RuntimeEmptyAuthorConfig": Type.Object({  }, { additionalProperties: false }),
})

export const Id = RuntimePublic23.Import('Id')
export type Id = Static<typeof Id>
export const UInt53 = RuntimePublic23.Import('UInt53')
export type UInt53 = Static<typeof UInt53>
export const Timestamp = RuntimePublic23.Import('Timestamp')
export type Timestamp = Static<typeof Timestamp>
export const TypeId = RuntimePublic23.Import('TypeId')
export type TypeId = Static<typeof TypeId>
export const Digest = RuntimePublic23.Import('Digest')
export type Digest = Static<typeof Digest>
export const SchemaRef = RuntimePublic23.Import('SchemaRef')
export type SchemaRef = Static<typeof SchemaRef>
export const BlobRef = RuntimePublic23.Import('BlobRef')
export type BlobRef = Static<typeof BlobRef>
export const DataRef = RuntimePublic23.Import('DataRef')
export type DataRef = Static<typeof DataRef>
export const RuntimeErrorCode = RuntimePublic23.Import('RuntimeErrorCode')
export type RuntimeErrorCode = Static<typeof RuntimeErrorCode>
export const OwnerRef = RuntimePublic23.Import('OwnerRef')
export type OwnerRef = Static<typeof OwnerRef>
export const RetryAdvice = RuntimePublic23.Import('RetryAdvice')
export type RetryAdvice = Static<typeof RetryAdvice>
export const RuntimeError = RuntimePublic23.Import('RuntimeError')
export type RuntimeError = Static<typeof RuntimeError>
export const BindingRef = RuntimePublic23.Import('BindingRef')
export type BindingRef = Static<typeof BindingRef>
export const StateCommitReceipt = RuntimePublic23.Import('StateCommitReceipt')
export type StateCommitReceipt = Static<typeof StateCommitReceipt>
export const StateAuthorityRef = RuntimePublic23.Import('StateAuthorityRef')
export type StateAuthorityRef = Static<typeof StateAuthorityRef>
export const ReadGuard = RuntimePublic23.Import('ReadGuard')
export type ReadGuard = Static<typeof ReadGuard>
export const ScopeRef = RuntimePublic23.Import('ScopeRef')
export type ScopeRef = Static<typeof ScopeRef>
export const DomainReference = RuntimePublic23.Import('DomainReference')
export type DomainReference = Static<typeof DomainReference>
export const OutboxRecord = RuntimePublic23.Import('OutboxRecord')
export type OutboxRecord = Static<typeof OutboxRecord>
export const StateLeaseRequest = RuntimePublic23.Import('StateLeaseRequest')
export type StateLeaseRequest = Static<typeof StateLeaseRequest>
export const WriterClaim = RuntimePublic23.Import('WriterClaim')
export type WriterClaim = Static<typeof WriterClaim>
export const ArtifactVersion = RuntimePublic23.Import('ArtifactVersion')
export type ArtifactVersion = Static<typeof ArtifactVersion>
export const ArtifactRef = RuntimePublic23.Import('ArtifactRef')
export type ArtifactRef = Static<typeof ArtifactRef>
export const Revision = RuntimePublic23.Import('Revision')
export type Revision = Static<typeof Revision>
export const DomainObjectRef = RuntimePublic23.Import('DomainObjectRef')
export type DomainObjectRef = Static<typeof DomainObjectRef>
export const ReceiptPointer = RuntimePublic23.Import('ReceiptPointer')
export type ReceiptPointer = Static<typeof ReceiptPointer>
export const ThinkingLevel = RuntimePublic23.Import('ThinkingLevel')
export type ThinkingLevel = Static<typeof ThinkingLevel>
export const ContentBlock = RuntimePublic23.Import('ContentBlock')
export type ContentBlock = Static<typeof ContentBlock>
export const SlotName = RuntimePublic23.Import('SlotName')
export type SlotName = Static<typeof SlotName>
export const SessionControlCommand = RuntimePublic23.Import('SessionControlCommand')
export type SessionControlCommand = Static<typeof SessionControlCommand>
export const SessionControlRequest = RuntimePublic23.Import('SessionControlRequest')
export type SessionControlRequest = Static<typeof SessionControlRequest>
export const ApprovalRespondRequest = RuntimePublic23.Import('ApprovalRespondRequest')
export type ApprovalRespondRequest = Static<typeof ApprovalRespondRequest>
export const Externalsession_v1_ContentBlock = RuntimePublic23.Import('Externalsession_v1_ContentBlock')
export type Externalsession_v1_ContentBlock = Static<typeof Externalsession_v1_ContentBlock>
export const Externalsession_v1_ArtifactRef = RuntimePublic23.Import('Externalsession_v1_ArtifactRef')
export type Externalsession_v1_ArtifactRef = Static<typeof Externalsession_v1_ArtifactRef>
export const Externaljobs_ContentBlock = RuntimePublic23.Import('Externaljobs_ContentBlock')
export type Externaljobs_ContentBlock = Static<typeof Externaljobs_ContentBlock>
export const Externaljobs_JsonValue = RuntimePublic23.Import('Externaljobs_JsonValue')
export type Externaljobs_JsonValue = Static<typeof Externaljobs_JsonValue>
export const Externaljobs_Schedule = RuntimePublic23.Import('Externaljobs_Schedule')
export type Externaljobs_Schedule = Static<typeof Externaljobs_Schedule>
export const Externaljobs_JobSpec = RuntimePublic23.Import('Externaljobs_JobSpec')
export type Externaljobs_JobSpec = Static<typeof Externaljobs_JobSpec>
export const Externalagnes_v1_JobSpec = RuntimePublic23.Import('Externalagnes_v1_JobSpec')
export type Externalagnes_v1_JobSpec = Static<typeof Externalagnes_v1_JobSpec>
export const JobSpec = RuntimePublic23.Import('JobSpec')
export type JobSpec = Static<typeof JobSpec>
export const Cursor = RuntimePublic23.Import('Cursor')
export type Cursor = Static<typeof Cursor>
export const RecordOwner = RuntimePublic23.Import('RecordOwner')
export type RecordOwner = Static<typeof RecordOwner>
export const AuthorizedViewScope = RuntimePublic23.Import('AuthorizedViewScope')
export type AuthorizedViewScope = Static<typeof AuthorizedViewScope>
export const ArtifactTitle = RuntimePublic23.Import('ArtifactTitle')
export type ArtifactTitle = Static<typeof ArtifactTitle>
export const ArtifactMediaType = RuntimePublic23.Import('ArtifactMediaType')
export type ArtifactMediaType = Static<typeof ArtifactMediaType>
export const ArtifactReadyView = RuntimePublic23.Import('ArtifactReadyView')
export type ArtifactReadyView = Static<typeof ArtifactReadyView>
export const DomainQuery = RuntimePublic23.Import('DomainQuery')
export type DomainQuery = Static<typeof DomainQuery>
export const DomainActionRef = RuntimePublic23.Import('DomainActionRef')
export type DomainActionRef = Static<typeof DomainActionRef>
export const ApprovalGrantBindingInput = RuntimePublic23.Import('ApprovalGrantBindingInput')
export type ApprovalGrantBindingInput = Static<typeof ApprovalGrantBindingInput>
export const JobTarget = RuntimePublic23.Import('JobTarget')
export type JobTarget = Static<typeof JobTarget>
export const JobSchedule = RuntimePublic23.Import('JobSchedule')
export type JobSchedule = Static<typeof JobSchedule>
export const JobPolicy = RuntimePublic23.Import('JobPolicy')
export type JobPolicy = Static<typeof JobPolicy>
export const JobEdit = RuntimePublic23.Import('JobEdit')
export type JobEdit = Static<typeof JobEdit>
export const DomainCommandClientSubmitRequest = RuntimePublic23.Import('DomainCommandClientSubmitRequest')
export type DomainCommandClientSubmitRequest = Static<typeof DomainCommandClientSubmitRequest>
export const DomainCommandClientCommandStatusRequest = RuntimePublic23.Import('DomainCommandClientCommandStatusRequest')
export type DomainCommandClientCommandStatusRequest = Static<typeof DomainCommandClientCommandStatusRequest>
export const ShellConversationClientCreateRequest = RuntimePublic23.Import('ShellConversationClientCreateRequest')
export type ShellConversationClientCreateRequest = Static<typeof ShellConversationClientCreateRequest>
export const ShellConversationClientOpenRequest = RuntimePublic23.Import('ShellConversationClientOpenRequest')
export type ShellConversationClientOpenRequest = Static<typeof ShellConversationClientOpenRequest>
export const ShellConversationClientHistoryRequest = RuntimePublic23.Import('ShellConversationClientHistoryRequest')
export type ShellConversationClientHistoryRequest = Static<typeof ShellConversationClientHistoryRequest>
export const ShellConversationClientSubmitRequest = RuntimePublic23.Import('ShellConversationClientSubmitRequest')
export type ShellConversationClientSubmitRequest = Static<typeof ShellConversationClientSubmitRequest>
export const ShellConversationClientCancelRequest = RuntimePublic23.Import('ShellConversationClientCancelRequest')
export type ShellConversationClientCancelRequest = Static<typeof ShellConversationClientCancelRequest>
export const ShellConversationClientStatusRequest = RuntimePublic23.Import('ShellConversationClientStatusRequest')
export type ShellConversationClientStatusRequest = Static<typeof ShellConversationClientStatusRequest>
export const SessionControlClientStatusRequest = RuntimePublic23.Import('SessionControlClientStatusRequest')
export type SessionControlClientStatusRequest = Static<typeof SessionControlClientStatusRequest>
export const SessionBudgetClientReadRequest = RuntimePublic23.Import('SessionBudgetClientReadRequest')
export type SessionBudgetClientReadRequest = Static<typeof SessionBudgetClientReadRequest>
export const PermissionClientRevokeGrantRequest = RuntimePublic23.Import('PermissionClientRevokeGrantRequest')
export type PermissionClientRevokeGrantRequest = Static<typeof PermissionClientRevokeGrantRequest>
export const SessionJobsClientEnqueueRequest = RuntimePublic23.Import('SessionJobsClientEnqueueRequest')
export type SessionJobsClientEnqueueRequest = Static<typeof SessionJobsClientEnqueueRequest>
export const SessionJobsClientPollRequest = RuntimePublic23.Import('SessionJobsClientPollRequest')
export type SessionJobsClientPollRequest = Static<typeof SessionJobsClientPollRequest>
export const SessionJobsClientCancelRequest = RuntimePublic23.Import('SessionJobsClientCancelRequest')
export type SessionJobsClientCancelRequest = Static<typeof SessionJobsClientCancelRequest>
export const SessionJobsClientCreateRequest = RuntimePublic23.Import('SessionJobsClientCreateRequest')
export type SessionJobsClientCreateRequest = Static<typeof SessionJobsClientCreateRequest>
export const SessionJobsClientUpdateRequest = RuntimePublic23.Import('SessionJobsClientUpdateRequest')
export type SessionJobsClientUpdateRequest = Static<typeof SessionJobsClientUpdateRequest>
export const SessionJobsClientInspectRequest = RuntimePublic23.Import('SessionJobsClientInspectRequest')
export type SessionJobsClientInspectRequest = Static<typeof SessionJobsClientInspectRequest>
export const SessionJobsClientCancelDefinitionRequest = RuntimePublic23.Import('SessionJobsClientCancelDefinitionRequest')
export type SessionJobsClientCancelDefinitionRequest = Static<typeof SessionJobsClientCancelDefinitionRequest>
export const InteractionClientPendingRequest = RuntimePublic23.Import('InteractionClientPendingRequest')
export type InteractionClientPendingRequest = Static<typeof InteractionClientPendingRequest>
export const InteractionClientRespondRequest = RuntimePublic23.Import('InteractionClientRespondRequest')
export type InteractionClientRespondRequest = Static<typeof InteractionClientRespondRequest>
export const ArtifactClientOpenDownloadRequest = RuntimePublic23.Import('ArtifactClientOpenDownloadRequest')
export type ArtifactClientOpenDownloadRequest = Static<typeof ArtifactClientOpenDownloadRequest>
export const ClientInteractionFormLinkInput = RuntimePublic23.Import('ClientInteractionFormLinkInput')
export type ClientInteractionFormLinkInput = Static<typeof ClientInteractionFormLinkInput>
export const ArtifactDescribeInput = RuntimePublic23.Import('ArtifactDescribeInput')
export type ArtifactDescribeInput = Static<typeof ArtifactDescribeInput>
export const ClientCallHeader = RuntimePublic23.Import('ClientCallHeader')
export type ClientCallHeader = Static<typeof ClientCallHeader>
export const ClientCatalogStatusRequest = RuntimePublic23.Import('ClientCatalogStatusRequest')
export type ClientCatalogStatusRequest = Static<typeof ClientCatalogStatusRequest>
export const ClientArtifactStreamStatusRequest = RuntimePublic23.Import('ClientArtifactStreamStatusRequest')
export type ClientArtifactStreamStatusRequest = Static<typeof ClientArtifactStreamStatusRequest>
export const ConversationListRequest = RuntimePublic23.Import('ConversationListRequest')
export type ConversationListRequest = Static<typeof ConversationListRequest>
export const ClientQueryCall = RuntimePublic23.Import('ClientQueryCall')
export type ClientQueryCall = Static<typeof ClientQueryCall>
export const ClientQueryRequest = RuntimePublic23.Import('ClientQueryRequest')
export type ClientQueryRequest = Static<typeof ClientQueryRequest>
export const ClientCommandCall = RuntimePublic23.Import('ClientCommandCall')
export type ClientCommandCall = Static<typeof ClientCommandCall>
export const ClientCommandRequest = RuntimePublic23.Import('ClientCommandRequest')
export type ClientCommandRequest = Static<typeof ClientCommandRequest>
export const ClientArtifactStreamMetadata = RuntimePublic23.Import('ClientArtifactStreamMetadata')
export type ClientArtifactStreamMetadata = Static<typeof ClientArtifactStreamMetadata>
export const ClientModuleCredentialBinding = RuntimePublic23.Import('ClientModuleCredentialBinding')
export type ClientModuleCredentialBinding = Static<typeof ClientModuleCredentialBinding>
export const ClientTransportRequestFrame = RuntimePublic23.Import('ClientTransportRequestFrame')
export type ClientTransportRequestFrame = Static<typeof ClientTransportRequestFrame>
export const TransportEvidenceProof = RuntimePublic23.Import('TransportEvidenceProof')
export type TransportEvidenceProof = Static<typeof TransportEvidenceProof>
export const TransportAuthenticationEvidence = RuntimePublic23.Import('TransportAuthenticationEvidence')
export type TransportAuthenticationEvidence = Static<typeof TransportAuthenticationEvidence>
export const TransportCredentialEnvelope = RuntimePublic23.Import('TransportCredentialEnvelope')
export type TransportCredentialEnvelope = Static<typeof TransportCredentialEnvelope>
export const ArtifactContentDescriptor = RuntimePublic23.Import('ArtifactContentDescriptor')
export type ArtifactContentDescriptor = Static<typeof ArtifactContentDescriptor>
export const ArtifactsFailRequest = RuntimePublic23.Import('ArtifactsFailRequest')
export type ArtifactsFailRequest = Static<typeof ArtifactsFailRequest>
export const ArtifactAccessGrantValue = RuntimePublic23.Import('ArtifactAccessGrantValue')
export type ArtifactAccessGrantValue = Static<typeof ArtifactAccessGrantValue>
export const ArtifactsGrantRequest = RuntimePublic23.Import('ArtifactsGrantRequest')
export type ArtifactsGrantRequest = Static<typeof ArtifactsGrantRequest>
export const ArtifactsRevokeGrantRequest = RuntimePublic23.Import('ArtifactsRevokeGrantRequest')
export type ArtifactsRevokeGrantRequest = Static<typeof ArtifactsRevokeGrantRequest>
export const ArtifactRedeemDownloadRequest = RuntimePublic23.Import('ArtifactRedeemDownloadRequest')
export type ArtifactRedeemDownloadRequest = Static<typeof ArtifactRedeemDownloadRequest>
export const ArtifactDownloadPresentation = RuntimePublic23.Import('ArtifactDownloadPresentation')
export type ArtifactDownloadPresentation = Static<typeof ArtifactDownloadPresentation>
export const ArtifactDownloadMetadata = RuntimePublic23.Import('ArtifactDownloadMetadata')
export type ArtifactDownloadMetadata = Static<typeof ArtifactDownloadMetadata>
export const LegacyArtifactRef = RuntimePublic23.Import('LegacyArtifactRef')
export type LegacyArtifactRef = Static<typeof LegacyArtifactRef>
export const LegacyArtifactMappingValue = RuntimePublic23.Import('LegacyArtifactMappingValue')
export type LegacyArtifactMappingValue = Static<typeof LegacyArtifactMappingValue>
export const OutboxDeliveryKey = RuntimePublic23.Import('OutboxDeliveryKey')
export type OutboxDeliveryKey = Static<typeof OutboxDeliveryKey>
export const OutboxDeadLettersRequest = RuntimePublic23.Import('OutboxDeadLettersRequest')
export type OutboxDeadLettersRequest = Static<typeof OutboxDeadLettersRequest>
export const OutboxDeadLetterItem = RuntimePublic23.Import('OutboxDeadLetterItem')
export type OutboxDeadLetterItem = Static<typeof OutboxDeadLetterItem>
export const PageOutboxDeadLetterItem = RuntimePublic23.Import('PageOutboxDeadLetterItem')
export type PageOutboxDeadLetterItem = Page<OutboxDeadLetterItem>
export const OutboxRedriveRequest = RuntimePublic23.Import('OutboxRedriveRequest')
export type OutboxRedriveRequest = Static<typeof OutboxRedriveRequest>
export const OutboxRedriveResult = RuntimePublic23.Import('OutboxRedriveResult')
export type OutboxRedriveResult = Static<typeof OutboxRedriveResult>
export const OutboxRedriveRecord = RuntimePublic23.Import('OutboxRedriveRecord')
export type OutboxRedriveRecord = Static<typeof OutboxRedriveRecord>
export const Externalchannel_JwtCredential = RuntimePublic23.Import('Externalchannel_JwtCredential')
export type Externalchannel_JwtCredential = Static<typeof Externalchannel_JwtCredential>
export const Externalchannel_SourceAuthCredential = RuntimePublic23.Import('Externalchannel_SourceAuthCredential')
export type Externalchannel_SourceAuthCredential = Static<typeof Externalchannel_SourceAuthCredential>
export const Externalchannel_PortalIdentityCredential = RuntimePublic23.Import('Externalchannel_PortalIdentityCredential')
export type Externalchannel_PortalIdentityCredential = Static<typeof Externalchannel_PortalIdentityCredential>
export const Externalchannel_LocalCredential = RuntimePublic23.Import('Externalchannel_LocalCredential')
export type Externalchannel_LocalCredential = Static<typeof Externalchannel_LocalCredential>
export const Externalchannel_SurfaceAuthCredential = RuntimePublic23.Import('Externalchannel_SurfaceAuthCredential')
export type Externalchannel_SurfaceAuthCredential = Static<typeof Externalchannel_SurfaceAuthCredential>
export const Externalchannel_Auth = RuntimePublic23.Import('Externalchannel_Auth')
export type Externalchannel_Auth = Static<typeof Externalchannel_Auth>
export const Externalagnes_v1_Auth = RuntimePublic23.Import('Externalagnes_v1_Auth')
export type Externalagnes_v1_Auth = Static<typeof Externalagnes_v1_Auth>
export const LegacyIdentityCredentialEnvelope = RuntimePublic23.Import('LegacyIdentityCredentialEnvelope')
export type LegacyIdentityCredentialEnvelope = Static<typeof LegacyIdentityCredentialEnvelope>
export const LegacyIdentityTransportEvidence = RuntimePublic23.Import('LegacyIdentityTransportEvidence')
export type LegacyIdentityTransportEvidence = Static<typeof LegacyIdentityTransportEvidence>
export const StateScanResult = RuntimePublic23.Import('StateScanResult')
export type StateScanResult = Page<DataRef>
export const StateProbeCommitRequest = RuntimePublic23.Import('StateProbeCommitRequest')
export type StateProbeCommitRequest = Static<typeof StateProbeCommitRequest>
export const StateProbeCommitResult = RuntimePublic23.Import('StateProbeCommitResult')
export type StateProbeCommitResult = Static<typeof StateProbeCommitResult>
export const StateLeaseRecordValue = RuntimePublic23.Import('StateLeaseRecordValue')
export type StateLeaseRecordValue = Static<typeof StateLeaseRecordValue>
export const StateLeaseProofValue = RuntimePublic23.Import('StateLeaseProofValue')
export type StateLeaseProofValue = Static<typeof StateLeaseProofValue>
export const StateWriteOpenRequest = RuntimePublic23.Import('StateWriteOpenRequest')
export type StateWriteOpenRequest = Static<typeof StateWriteOpenRequest>
export const StateWriteOpenProofValue = RuntimePublic23.Import('StateWriteOpenProofValue')
export type StateWriteOpenProofValue = Static<typeof StateWriteOpenProofValue>
export const RuntimeEmptyAuthorConfig = RuntimePublic23.Import('RuntimeEmptyAuthorConfig')
export type RuntimeEmptyAuthorConfig = Static<typeof RuntimeEmptyAuthorConfig>
