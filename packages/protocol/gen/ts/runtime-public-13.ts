import type { Page } from './runtime-public.js'
// generated from schema by tools/gen.ts — do not edit
import { Type, type Static } from '@sinclair/typebox'
import { FormatRegistry } from '@sinclair/typebox'

if (!FormatRegistry.Has('date-time')) FormatRegistry.Set('date-time', (value) => { const parts = value.split(/t/i); if (parts.length !== 2) return false; const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(parts[0] ?? ''); const time = /^(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)(z|([+-])(\d{2}):(\d{2}))$/i.exec(parts[1] ?? ''); if (!date || !time) return false; const year = Number(date[1]), month = Number(date[2]), day = Number(date[3]); const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0); const days = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; if (month < 1 || month > 12 || day < 1 || day > (days[month] ?? 0)) return false; const hour = Number(time[1]), minute = Number(time[2]), second = Number(time[3]); const offsetHour = Number(time[6] || 0), offsetMinute = Number(time[7] || 0); if (hour > 23 || minute > 59 || offsetHour > 23 || offsetMinute > 59) return false; if (second < 60) return true; const sign = time[5] === '-' ? -1 : 1; const utcMinute = minute - offsetMinute * sign; const utcHour = hour - offsetHour * sign - (utcMinute < 0 ? 1 : 0); return (utcHour === 23 || utcHour === -1) && (utcMinute === 59 || utcMinute === -1) && second < 61; })

export const JsonValue = Type.Recursive((This) => Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String(), Type.Array(This, { minItems: 0, maxItems: 10000 }), Type.Record(Type.String(), This)]))
export type JsonValue = Static<typeof JsonValue>

export const RuntimePublic13 = Type.Module({
  "Id": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }),
  "UInt53": Type.Integer({ minimum: 0, maximum: 9007199254740991 }),
  "Timestamp": Type.String({ pattern: "Z$", format: "date-time" }),
  "TypeId": Type.String({ minLength: 1, maxLength: 256, pattern: "^(?:[a-z][a-z0-9.-]*|@[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*)/[a-zA-Z0-9._/-]+@[1-9][0-9]*$" }),
  "Digest": Type.String({ pattern: "^[a-f0-9]{64}$" }),
  "SchemaRef": Type.Object({ "typeId": Type.Ref('TypeId'), "revision": Type.Ref('UInt53'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "BlobRef": Type.Object({ "authorityId": Type.Ref('Id'), "blobId": Type.Ref('Id'), "digest": Type.Ref('Digest'), "bytes": Type.Ref('UInt53'), "mediaType": Type.String(), "pinId": Type.Ref('Id') }, { additionalProperties: false }),
  "DataRef": Type.Union([Type.Object({ "kind": Type.Literal('inline'), "schema": Type.Ref('SchemaRef'), "value": JsonValue, "digest": Type.Ref('Digest'), "bytes": Type.Ref('UInt53') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('blob'), "schema": Type.Ref('SchemaRef'), "blob": Type.Ref('BlobRef') }, { additionalProperties: false })]),
  "ActionRef": Type.Union([Type.Object({ "existingActionId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "localKey": Type.String() }, { additionalProperties: false })]),
  "RuntimeErrorCode": Type.Union([Type.Literal('invalid_input'), Type.Literal('denied'), Type.Literal('incompatible'), Type.Literal('quota'), Type.Literal('cancelled'), Type.Literal('timeout'), Type.Literal('retryable'), Type.Literal('unknown_effect'), Type.Literal('conflict'), Type.Literal('internal')]),
  "OwnerRef": Type.Object({ "kind": Type.Union([Type.Literal('run'), Type.Literal('action'), Type.Literal('job'), Type.Literal('reconciliation')]), "id": Type.Ref('Id') }, { additionalProperties: false }),
  "RetryAdvice": Type.Union([Type.Object({ "kind": Type.Literal('never') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('retry_read'), "notBefore": Type.Optional(Type.Ref('Timestamp')) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('retry_same_action'), "notBefore": Type.Optional(Type.Ref('Timestamp')) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('reconcile'), "ownerRef": Type.Ref('OwnerRef') }, { additionalProperties: false })]),
  "RuntimeError": Type.Object({ "code": Type.Ref('RuntimeErrorCode'), "detailCode": Type.String(), "message": Type.String(), "retryAdvice": Type.Ref('RetryAdvice'), "diagnosticId": Type.Ref('Id'), "safeDetail": Type.Optional(JsonValue) }, { additionalProperties: false }),
  "ExternalRequestRef": Type.Object({ "system": Type.String(), "requestId": Type.Ref('Id'), "idempotencyKey": Type.Optional(Type.String()), "requestDigest": Type.Ref('Digest') }, { additionalProperties: false }),
  "RetentionRef": Type.Object({ "kind": Type.Union([Type.Literal('blob'), Type.Literal('artifact'), Type.Literal('domain-record'), Type.Literal('package'), Type.Literal('schema'), Type.Literal('codec')]), "authorityId": Type.Ref('Id'), "resourceId": Type.Ref('Id'), "version": Type.String(), "digest": Type.Ref('Digest'), "pinId": Type.Ref('Id') }, { additionalProperties: false }),
  "BindingRef": Type.Object({ "bindingId": Type.Ref('Id'), "contract": Type.String(), "logicalName": Type.String(), "providerId": Type.Ref('Id') }, { additionalProperties: false }),
  "Provenance": Type.Object({ "sourceRefs": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "producer": Type.Ref('BindingRef'), "trustLabels": Type.Array(Type.String(), { maxItems: 10000 }) }, { additionalProperties: false }),
  "ActionResultView": Type.Object({ "receiptId": Type.Ref('Id'), "actionId": Type.Ref('Id'), "attemptId": Type.Ref('Id'), "bindingId": Type.Ref('Id'), "inputDigest": Type.Ref('Digest'), "outcome": Type.Union([Type.Literal('succeeded'), Type.Literal('failed'), Type.Literal('cancelled'), Type.Literal('unknown_effect')]), "result": Type.Optional(Type.Ref('DataRef')), "error": Type.Optional(Type.Ref('RuntimeError')), "externalRequests": Type.Array(Type.Ref('ExternalRequestRef'), { maxItems: 10000 }), "usageRefs": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "references": Type.Array(Type.Ref('RetentionRef'), { maxItems: 10000 }), "provenance": Type.Ref('Provenance'), "completedAt": Type.Ref('Timestamp'), "visibility": Type.Literal('ready'), "viewId": Type.Ref('Id'), "sourceReceiptId": Type.Ref('Id'), "hookResultSetRef": Type.Union([Type.Ref('DataRef'), Type.Null()]) }, { additionalProperties: false }),
  "StateAuthorityRef": Type.Object({ "authorityId": Type.Ref('Id'), "tenantId": Type.Ref('Id'), "authorityEpoch": Type.Ref('UInt53') }, { additionalProperties: false }),
  "HookEventName": Type.Union([Type.Literal('tool_call'), Type.Literal('approval_request'), Type.Literal('tool_result'), Type.Literal('context'), Type.Literal('before_request'), Type.Literal('request_error'), Type.Literal('format_deviation'), Type.Literal('before_compact'), Type.Literal('compact'), Type.Literal('session_start'), Type.Literal('shutdown'), Type.Literal('subagent_start'), Type.Literal('subagent_end'), Type.Literal('resources_discover'), Type.Literal('before_step'), Type.Literal('turn_stopping')]),
  "HookResultSet": Type.Object({ "stageId": Type.Ref('Id'), "event": Type.Ref('HookEventName'), "registrationDigest": Type.Ref('Digest'), "inputDigest": Type.Ref('Digest'), "entries": Type.Array(Type.Object({ "registrationId": Type.Ref('Id'), "ordinal": Type.Ref('UInt53'), "outcome": Type.Union([Type.Literal('applied'), Type.Literal('failed-open'), Type.Literal('denied')]), "output": Type.Union([Type.Ref('DataRef'), Type.Null()]), "diagnosticId": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false }), { maxItems: 10000 }), "output": Type.Ref('DataRef'), "digest": Type.Ref('Digest'), "sourceActionId": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false }),
  "ScopeRef": Type.Union([Type.Object({ "installationId": Type.Ref('Id'), "kind": Type.Literal('installation') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "kind": Type.Literal('runtime') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "kind": Type.Literal('workspace') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "kind": Type.Literal('session') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "runId": Type.Ref('Id'), "kind": Type.Literal('run') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "runId": Type.Ref('Id'), "kind": Type.Literal('action'), "actionId": Type.Ref('Id') }, { additionalProperties: false })]),
  "DomainReference": Type.Object({ "authorityId": Type.Ref('Id'), "recordId": Type.Ref('Id'), "recordRevision": Type.Ref('UInt53'), "schema": Type.Ref('SchemaRef'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "RequestIdentity": Type.Object({ "system": Type.String(), "aghRequestId": Type.Ref('Id'), "idempotencyKey": Type.Union([Type.String(), Type.Null()]), "requestDigest": Type.Ref('Digest') }, { additionalProperties: false }),
  "ConversationAdmission": Type.Object({ "turnId": Type.Ref('Id'), "inputMessageId": Type.Ref('Id'), "inputRef": Type.Ref('DataRef'), "kind": Type.Union([Type.Literal('prompt'), Type.Literal('follow-up')]) }, { additionalProperties: false }),
  "IsolationMode": Type.Union([Type.Literal('trusted-in-process'), Type.Literal('isolated-process'), Type.Literal('remote')]),
  "CapabilityRequirement": Type.Object({ "capability": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "resourceTypes": Type.Array(Type.Ref('TypeId'), { minItems: 0, maxItems: 64 }), "operations": Type.Array(Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), { minItems: 0, maxItems: 64 }) }, { additionalProperties: false }),
  "ConfigValue": Type.Object({ "schema": Type.Ref('SchemaRef'), "value": JsonValue }, { additionalProperties: false }),
  "ToolPolicyDefaults": Type.Object({ "isReadOnly": Type.Boolean(), "isDestructive": Type.Boolean(), "replay": Type.Union([Type.Literal('safe'), Type.Literal('never'), Type.Literal('idempotent')]), "requiresApproval": Type.Union([Type.Literal('never'), Type.Literal('destructive'), Type.Literal('always')]), "approvalScopes": Type.Array(Type.String(), { maxItems: 16 }) }, { additionalProperties: false }),
  "ToolPolicySnapshot": Type.Object({ "isReadOnly": Type.Boolean(), "isDestructive": Type.Boolean(), "replay": Type.Union([Type.Literal('safe'), Type.Literal('never'), Type.Literal('idempotent')]), "requiresApproval": Type.Union([Type.Literal('never'), Type.Literal('destructive'), Type.Literal('always')]), "approvalScopes": Type.Array(Type.String(), { maxItems: 16 }), "policyVersion": Type.String(), "classifierDigest": Type.Ref('Digest'), "inputDigest": Type.Ref('Digest'), "definitionDigest": Type.Ref('Digest'), "fingerprint": Type.Ref('Digest') }, { additionalProperties: false }),
  "ToolExecutionConstraints": Type.Object({ "concurrency": Type.Union([Type.Literal('parallel'), Type.Literal('batch-barrier')]), "isOpenWorld": Type.Boolean(), "costHint": Type.Union([Type.Ref('DataRef'), Type.Null()]), "deferLoading": Type.Boolean(), "requiredModelInput": Type.Array(Type.Union([Type.Literal('text'), Type.Literal('image'), Type.Literal('audio'), Type.Literal('video')]), { maxItems: 10000 }) }, { additionalProperties: false }),
  "ResourceRef": Type.Object({ "resourceId": Type.Ref('Id'), "version": Type.String(), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "ToolDefinition": Type.Object({ "resource": Type.Ref('ResourceRef'), "executor": Type.Ref('BindingRef'), "name": Type.String(), "inputSchema": Type.Ref('SchemaRef'), "outputSchema": Type.Ref('SchemaRef'), "requiredCapabilities": Type.Array(Type.Ref('CapabilityRequirement'), { maxItems: 10000 }), "retrySafety": Type.Union([Type.Literal('idempotent'), Type.Literal('reconcile-first'), Type.Literal('never')]), "publicAnnotations": Type.Ref('DataRef'), "policy": Type.Object({ "version": Type.String(), "classifierRef": Type.Union([Type.Ref('DataRef'), Type.Null()]), "defaults": Type.Ref('ToolPolicyDefaults') }, { additionalProperties: false }), "execution": Type.Ref('ToolExecutionConstraints') }, { additionalProperties: false }),
  "ArtifactVersion": Type.Integer({ minimum: 1, maximum: 9007199254740991 }),
  "ArtifactRef": Type.Object({ "artifactId": Type.Ref('Id'), "version": Type.Ref('ArtifactVersion') }, { additionalProperties: false }),
  "Revision": Type.Ref('UInt53'),
  "DomainObjectRef": Type.Object({ "authorityId": Type.Ref('Id'), "typeId": Type.Ref('TypeId'), "id": Type.Ref('Id'), "revision": Type.Ref('Revision') }, { additionalProperties: false }),
  "ModelFeatures": Type.Object({ "input": Type.Array(Type.Union([Type.Literal('text'), Type.Literal('image'), Type.Literal('audio'), Type.Literal('video')]), { maxItems: 10000 }), "output": Type.Array(Type.Union([Type.Literal('text'), Type.Literal('image'), Type.Literal('audio'), Type.Literal('video')]), { maxItems: 10000 }), "tools": Type.Boolean(), "structuredOutput": Type.Boolean(), "streaming": Type.Boolean() }, { additionalProperties: false }),
  "SecretConsumerBinding": Type.Object({ "consumer": Type.Union([Type.Literal('model'), Type.Literal('mcp'), Type.Literal('tls'), Type.Literal('jwt'), Type.Literal('source-auth'), Type.Literal('surface'), Type.Literal('exec'), Type.Literal('artifact-ticket')]), "secretId": Type.Ref('Id'), "accountRef": Type.Union([Type.Ref('Id'), Type.Null()]), "serverRef": Type.Ref('Id'), "audience": Type.String(), "purpose": Type.String() }, { additionalProperties: false }),
  "ModelRouteSnapshot": Type.Object({ "routeId": Type.Ref('Id'), "routeRevision": Type.Ref('Revision'), "adapter": Type.Ref('BindingRef'), "model": Type.String(), "endpointRef": Type.Ref('Id'), "catalogRevision": Type.Ref('Revision'), "features": Type.Ref('ModelFeatures'), "priceVersion": Type.Ref('Id'), "credentialAudience": Type.String(), "credentialBinding": Type.Union([Type.Ref('SecretConsumerBinding'), Type.Null()]) }, { additionalProperties: false }),
  "ToolCatalogPolicy": Type.Object({ "disclosure": Type.Union([Type.Literal('standard'), Type.Literal('code'), Type.Literal('hybrid'), Type.Literal('provider-defined')]), "discoveredResourceIds": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "compactionAgentCallable": Type.Boolean(), "mainModel": Type.Union([Type.Ref('ModelRouteSnapshot'), Type.Null()]), "policyRevision": Type.Ref('Revision') }, { additionalProperties: false }),
  "TaintSnapshot": Type.Object({ "recordRevision": Type.Integer({ minimum: 1, maximum: 9007199254740991 }), "sourceSeq": Type.Ref('UInt53'), "clearedThroughSeq": Type.Ref('UInt53') }, { additionalProperties: false }),
  "SessionRef": Type.Object({ "sessionId": Type.Ref('Id'), "authority": Type.Ref('StateAuthorityRef') }, { additionalProperties: false }),
  "RunRef": Type.Object({ "runId": Type.Ref('Id'), "session": Type.Ref('SessionRef') }, { additionalProperties: false }),
  "InteractionRef": Type.Object({ "interactionId": Type.Ref('Id') }, { additionalProperties: false }),
  "PublicBlobReference": Type.Object({ "kind": Type.Literal('blob'), "value": Type.Ref('BlobRef') }, { additionalProperties: false }),
  "UploadSession": Type.Object({ "authorityId": Type.Ref('Id'), "uploadId": Type.Ref('Id'), "reservationId": Type.Ref('Id'), "expectedBytes": Type.Ref('UInt53'), "receivedBytes": Type.Ref('UInt53'), "expectedDigest": Type.Union([Type.Ref('Digest'), Type.Null()]), "mediaType": Type.String(), "status": Type.Union([Type.Literal('uploading'), Type.Literal('sealed'), Type.Literal('aborted')]), "revision": Type.Ref('Revision') }, { additionalProperties: false }),
  "PublicUploadReference": Type.Object({ "kind": Type.Literal('upload'), "value": Type.Ref('UploadSession') }, { additionalProperties: false }),
  "StagedBlobRef": Type.Object({ "authorityId": Type.Ref('Id'), "blobId": Type.Ref('Id'), "digest": Type.Ref('Digest'), "bytes": Type.Ref('UInt53'), "mediaType": Type.String(), "reservationId": Type.Ref('Id') }, { additionalProperties: false }),
  "PublicStagedBlobReference": Type.Object({ "kind": Type.Literal('staged-blob'), "value": Type.Ref('StagedBlobRef') }, { additionalProperties: false }),
  "PublicRef": Type.Union([Type.Object({ "kind": Type.Literal('session'), "value": Type.Ref('SessionRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('run'), "value": Type.Ref('RunRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('action'), "run": Type.Ref('RunRef'), "actionId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('resource'), "value": Type.Ref('ResourceRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('artifact'), "value": Type.Ref('ArtifactRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('interaction'), "value": Type.Ref('InteractionRef') }, { additionalProperties: false }), Type.Ref('PublicBlobReference'), Type.Ref('PublicUploadReference'), Type.Ref('PublicStagedBlobReference'), Type.Object({ "kind": Type.Literal('domain'), "value": Type.Ref('DomainObjectRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('event'), "authorityId": Type.Ref('Id'), "eventId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('state'), "value": Type.Ref('DomainReference') }, { additionalProperties: false })]),
  "ApprovalGrantEvidence": Type.Object({ "grantId": Type.Ref('Id'), "revision": Type.Ref('Revision'), "kind": Type.Union([Type.Literal('once'), Type.Literal('session'), Type.Literal('permanent')]), "actorRef": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "toolName": Type.String(), "scopes": Type.Array(Type.String(), { maxItems: 10000 }), "profileDigest": Type.Ref('Digest'), "policyVersion": Type.String(), "inputDigest": Type.Union([Type.Ref('Digest'), Type.Null()]), "validUntil": Type.Union([Type.Ref('Timestamp'), Type.Null()]), "consumed": Type.Boolean() }, { additionalProperties: false }),
  "ReceiptPointer": Type.Object({ "authorityId": Type.Ref('Id'), "receiptId": Type.Ref('Id'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "TrustedPolicyFacts": Type.Object({ "factsId": Type.Ref('Id'), "actionId": Type.Ref('Id'), "inputDigest": Type.Ref('Digest'), "evaluatedAt": Type.Ref('Timestamp'), "toolPolicy": Type.Union([Type.Ref('ToolPolicySnapshot'), Type.Null()]), "actor": Type.Object({ "principalRef": Type.Ref('Id'), "revision": Type.Ref('Revision'), "executionDomain": Type.Ref('Id'), "packageDigest": Type.Ref('Digest') }, { additionalProperties: false }), "taint": Type.Object({ "runId": Type.Ref('Id'), "current": Type.Ref('TaintSnapshot'), "captured": Type.Ref('TaintSnapshot'), "tainted": Type.Boolean(), "sourceRefs": Type.Array(Type.Ref('PublicRef'), { maxItems: 10000 }) }, { additionalProperties: false }), "configuration": Type.Object({ "revision": Type.Ref('Revision'), "profileDigest": Type.Ref('Digest'), "mode": Type.Union([Type.Literal('manual'), Type.Literal('smart'), Type.Literal('off')]), "yolo": Type.Boolean() }, { additionalProperties: false }), "authorization": Type.Object({ "decision": Type.Union([Type.Literal('allow'), Type.Literal('require-approval'), Type.Literal('deny')]), "policyRevision": Type.Ref('Revision'), "sourceRefs": Type.Array(Type.Ref('DomainReference'), { maxItems: 10000 }) }, { additionalProperties: false }), "grants": Type.Array(Type.Ref('ApprovalGrantEvidence'), { maxItems: 10000 }), "guardian": Type.Object({ "state": Type.Union([Type.Literal('not-needed'), Type.Literal('pending'), Type.Literal('decided')]), "actionId": Type.Union([Type.Ref('Id'), Type.Null()]), "resultRef": Type.Union([Type.Ref('ReceiptPointer'), Type.Null()]), "decision": Type.Union([Type.Literal('allow'), Type.Literal('ask'), Type.Literal('deny'), Type.Null()]) }, { additionalProperties: false }), "hookResults": Type.Union([Type.Ref('HookResultSet'), Type.Null()]), "approvalRequestRef": Type.Union([Type.Ref('DataRef'), Type.Null()]) }, { additionalProperties: false }),
  "FilePath": Type.String(),
  "FileCheckpointProof": Type.Object({ "requestId": Type.Ref('Id'), "path": Type.Ref('FilePath'), "beforeVersion": Type.Union([Type.Ref('Revision'), Type.Null()]), "before": Type.Union([Type.Literal('present'), Type.Literal('absent')]), "restoration": Type.Ref('RetentionRef'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "ExactQuantity": Type.Object({ "unit": Type.String(), "value": Type.String() }, { additionalProperties: false }),
  "SessionControlBoundary": Type.Object({ "kind": Type.Union([Type.Literal('immediate'), Type.Literal('next-request'), Type.Literal('next-turn'), Type.Literal('quiet-step'), Type.Literal('quiet-turn'), Type.Literal('next-run')]), "revision": Type.Ref('UInt53'), "runId": Type.Union([Type.Ref('Id'), Type.Null()]), "afterRequestId": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false }),
  "SessionParameterRevision": Type.Object({ "sessionId": Type.Ref('Id'), "revision": Type.Ref('UInt53'), "previousRevision": Type.Union([Type.Ref('UInt53'), Type.Null()]), "sourceRequestId": Type.Ref('Id'), "presetId": Type.Ref('Id'), "presetDigest": Type.Ref('Digest'), "parameters": Type.Ref('ConfigValue'), "effective": Type.Ref('SessionControlBoundary'), "committedAt": Type.Ref('Timestamp') }, { additionalProperties: false }),
  "ResourceLimits": Type.Object({ "cpuMs": Type.Ref('UInt53'), "wallMs": Type.Ref('UInt53'), "memoryBytes": Type.Ref('UInt53'), "outputBytes": Type.Ref('UInt53'), "processes": Type.Ref('UInt53'), "openFiles": Type.Ref('UInt53') }, { additionalProperties: false }),
  "RunState": Type.Union([Type.Literal('admitted'), Type.Literal('runnable'), Type.Literal('waiting'), Type.Literal('failing'), Type.Literal('cancelling'), Type.Literal('draining'), Type.Literal('succeeded'), Type.Literal('failed'), Type.Literal('cancelled'), Type.Literal('frozen'), Type.Literal('migrating'), Type.Literal('blocked_incompatible'), Type.Literal('blocked_integrity')]),
  "UsageFactRef": Type.Object({ "authorityId": Type.Ref('Id'), "usageId": Type.Ref('Id'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "FsPolicySnapshot": Type.Object({ "policyId": Type.Ref('Id'), "digest": Type.Ref('Digest'), "scope": Type.Ref('ScopeRef'), "compilerVersion": Type.String(), "roots": Type.Array(Type.Object({ "kind": Type.Union([Type.Literal('workspace'), Type.Literal('home'), Type.Literal('data')]), "mount": Type.Object({ "workspaceId": Type.Ref('Id'), "mountId": Type.Ref('Id') }, { additionalProperties: false }) }, { additionalProperties: false }), { maxItems: 10000 }), "rules": Type.Array(Type.Object({ "root": Type.Union([Type.Literal('workspace'), Type.Literal('home'), Type.Literal('data')]), "path": Type.Ref('FilePath'), "effect": Type.Union([Type.Literal('hard-deny'), Type.Literal('deny'), Type.Literal('allow')]), "access": Type.Array(Type.Union([Type.Literal('read'), Type.Literal('write'), Type.Literal('stat'), Type.Literal('list')]), { maxItems: 10000 }) }, { additionalProperties: false }), { maxItems: 10000 }) }, { additionalProperties: false }),
  "LeaseRef": Type.Object({ "authorityId": Type.Ref('Id'), "leaseId": Type.Ref('Id'), "epoch": Type.Ref('UInt53'), "expiresAt": Type.Ref('Timestamp') }, { additionalProperties: false }),
  "MountRef": Type.Object({ "workspaceId": Type.Ref('Id'), "mountId": Type.Ref('Id'), "revision": Type.Ref('Revision'), "lease": Type.Ref('LeaseRef') }, { additionalProperties: false }),
  "FsEnforcementProof": Type.Object({ "policyDigest": Type.Ref('Digest'), "provider": Type.Ref('BindingRef'), "authorityEpoch": Type.Ref('UInt53'), "checkedAt": Type.Ref('Timestamp'), "scope": Type.Ref('ScopeRef'), "workspaceRoot": Type.Object({ "mount": Type.Ref('MountRef'), "policyDecision": Type.Literal('allow'), "exists": Type.Boolean() }, { additionalProperties: false }), "probes": Type.Array(Type.Object({ "root": Type.Union([Type.Literal('workspace'), Type.Literal('home'), Type.Literal('data')]), "path": Type.Ref('FilePath'), "decision": Type.Literal('denied'), "evidenceCode": Type.Literal('E_FS_DENIED') }, { additionalProperties: false }), { minItems: 5, maxItems: 10000, uniqueItems: true }), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "AttemptRef": Type.Object({ "run": Type.Ref('RunRef'), "actionId": Type.Ref('Id'), "attemptId": Type.Ref('Id') }, { additionalProperties: false }),
  "Cursor": Type.String(),
  "AttemptState": Type.Union([Type.Literal('allocated'), Type.Literal('dispatching'), Type.Literal('running'), Type.Literal('unknown'), Type.Literal('settled')]),
  "BytesRef": Type.Ref('BlobRef'),
  "RetrievalFilter": Type.Object({ "labels": Type.Optional(Type.Array(Type.String(), { maxItems: 10000 })), "after": Type.Optional(Type.Ref('Timestamp')) }, { additionalProperties: false }),
  "VersionPrecondition": Type.Union([Type.Object({ "kind": Type.Literal('absent') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('exact'), "revision": Type.Ref('Revision') }, { additionalProperties: false })]),
  "FileRange": Type.Object({ "offset": Type.Ref('UInt53'), "length": Type.Ref('UInt53') }, { additionalProperties: false }),
  "FileEntry": Type.Object({ "path": Type.Ref('FilePath'), "kind": Type.Union([Type.Literal('file'), Type.Literal('directory'), Type.Literal('symlink')]), "bytes": Type.Union([Type.Ref('UInt53'), Type.Null()]), "revision": Type.Ref('Revision') }, { additionalProperties: false }),
  "SandboxRef": Type.Object({ "authorityId": Type.Ref('Id'), "sandboxId": Type.Ref('Id'), "ownerBinding": Type.Ref('BindingRef'), "lease": Type.Ref('LeaseRef') }, { additionalProperties: false }),
  "SandboxState": Type.Union([Type.Literal('creating'), Type.Literal('ready'), Type.Literal('stopping'), Type.Literal('stopped'), Type.Literal('lost')]),
  "ExecutionRef": Type.Object({ "authorityId": Type.Ref('Id'), "executionId": Type.Ref('Id'), "requestIdentity": Type.Ref('RequestIdentity') }, { additionalProperties: false }),
  "NetworkTarget": Type.Object({ "targetId": Type.Ref('Id'), "scheme": Type.Union([Type.Literal('http'), Type.Literal('https')]), "host": Type.String(), "port": Type.Ref('UInt53'), "path": Type.String() }, { additionalProperties: false }),
  "NewRunSpec": Type.Object({ "presetRef": Type.Ref('Id'), "inputRef": Type.Ref('DataRef'), "idempotencyKey": Type.Ref('Id'), "conversation": Type.Optional(Type.Ref('ConversationAdmission')) }, { additionalProperties: false }),
  "ScheduleTarget": Type.Union([Type.Object({ "kind": Type.Literal('existing'), "run": Type.Ref('RunRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('new'), "spec": Type.Ref('NewRunSpec') }, { additionalProperties: false })]),
  "SchedulerDelivery": Type.Object({ "deliveryId": Type.Ref('Id'), "target": Type.Ref('ScheduleTarget'), "inputRef": Type.Ref('DataRef'), "priority": Type.Union([Type.Literal('interactive'), Type.Literal('background')]), "notBefore": Type.Ref('Timestamp'), "state": Type.Union([Type.Literal('queued'), Type.Literal('claimed'), Type.Literal('acked'), Type.Literal('cancelled')]), "claim": Type.Union([Type.Null(), Type.Object({ "workerId": Type.Ref('Id'), "epoch": Type.Ref('UInt53'), "expiresAt": Type.Ref('Timestamp'), "bindingId": Type.Ref('Id'), "ticketId": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false })]), "revision": Type.Ref('Revision'), "outcomeRef": Type.Union([Type.Ref('ReceiptPointer'), Type.Null()]) }, { additionalProperties: false }),
  "JobTarget": Type.Union([Type.Object({ "kind": Type.Literal('pin'), "releaseSetId": Type.Ref('Id'), "bindingId": Type.Ref('Id'), "presetRef": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('follow'), "routeId": Type.Ref('Id'), "presetRef": Type.Ref('Id') }, { additionalProperties: false })]),
  "JobSchedule": Type.Union([Type.Object({ "kind": Type.Literal('once'), "at": Type.Ref('Timestamp') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('rrule'), "rrule": Type.String(), "timezone": Type.String(), "startsAt": Type.Ref('Timestamp'), "ambiguousLocalTime": Type.Union([Type.Literal('earlier'), Type.Literal('later')]), "nonexistentLocalTime": Type.Union([Type.Literal('skip'), Type.Literal('next-valid')]) }, { additionalProperties: false })]),
  "JobPolicy": Type.Object({ "missed": Type.Union([Type.Literal('skip'), Type.Literal('latest'), Type.Literal('catch-up')]), "maxCatchUp": Type.Ref('UInt53'), "concurrency": Type.Union([Type.Literal('forbid'), Type.Literal('queue'), Type.Literal('parallel')]), "maxConcurrent": Type.Ref('UInt53'), "maxAttempts": Type.Ref('UInt53'), "retryDelayMs": Type.Ref('UInt53'), "retryMaxDelayMs": Type.Ref('UInt53') }, { additionalProperties: false }),
  "JobEdit": Type.Object({ "schedule": Type.Optional(Type.Ref('JobSchedule')), "policy": Type.Optional(Type.Ref('JobPolicy')), "target": Type.Optional(Type.Ref('JobTarget')), "inputRef": Type.Optional(Type.Ref('DataRef')), "budgetAccount": Type.Optional(Type.Ref('DomainObjectRef')), "status": Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('paused')])) }, { additionalProperties: false }),
  "MemoryItem": Type.Object({ "ref": Type.Ref('DomainObjectRef'), "contentRef": Type.Ref('DataRef'), "sourceRefs": Type.Array(Type.Ref('PublicRef'), { maxItems: 10000 }), "provenance": Type.Ref('Provenance'), "trust": Type.Union([Type.Literal('system'), Type.Literal('user'), Type.Literal('external'), Type.Literal('derived')]), "labels": Type.Array(Type.String(), { maxItems: 10000 }), "ownerPrincipalRef": Type.Ref('Id'), "expiresAt": Type.Union([Type.Ref('Timestamp'), Type.Null()]), "status": Type.Union([Type.Literal('active'), Type.Literal('deleted')]) }, { additionalProperties: false }),
  "DeletionReceipt": Type.Object({ "deletionId": Type.Ref('Id'), "authorityId": Type.Ref('Id'), "watermark": Type.Ref('UInt53'), "invalidatedRefs": Type.Array(Type.Ref('PublicRef'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "RetrievalHit": Type.Object({ "ref": Type.Ref('PublicRef'), "score": Type.Number(), "source": Type.Ref('Provenance'), "trust": Type.Union([Type.Literal('system'), Type.Literal('user'), Type.Literal('external'), Type.Literal('derived')]) }, { additionalProperties: false }),
  "ResourcesRegisterResult": Type.Object({ "revision": Type.Ref('Revision') }, { additionalProperties: false }),
  "ResourcesRemoveRequest": Type.Object({ "id": Type.Ref('Id'), "expectedRevision": Type.Ref('Revision') }, { additionalProperties: false }),
  "ResourcesRemoveResult": Type.Object({ "revision": Type.Ref('Revision') }, { additionalProperties: false }),
  "ResourcesRetainRequest": Type.Object({ "resource": Type.Ref('PublicRef'), "purpose": Type.Union([Type.Literal('continuation'), Type.Literal('artifact'), Type.Literal('job'), Type.Literal('history')]) }, { additionalProperties: false }),
  "ResourcesReleaseRequest": Type.Object({ "retention": Type.Ref('RetentionRef'), "reason": Type.String() }, { additionalProperties: false }),
  "ResourcesReleaseResult": Type.Object({ "state": Type.Union([Type.Literal('release-pending'), Type.Literal('released')]), "receipt": Type.Ref('ReceiptPointer') }, { additionalProperties: false }),
  "McpConnectResult": Type.Object({ "connectionRef": Type.Ref('DomainObjectRef'), "capabilities": Type.Ref('DataRef'), "schemaRevision": Type.Ref('Revision') }, { additionalProperties: false }),
  "McpCallRequest": Type.Object({ "connectionRef": Type.Ref('DomainObjectRef'), "method": Type.String(), "methodSchema": Type.Ref('SchemaRef'), "params": Type.Ref('DataRef') }, { additionalProperties: false }),
  "McpCallResult": Type.Object({ "contentRefs": Type.Array(Type.Ref('DataRef'), { maxItems: 10000 }), "provenance": Type.Ref('Provenance'), "remoteReceipt": Type.Union([Type.Ref('DataRef'), Type.Null()]) }, { additionalProperties: false }),
  "McpReadRequest": Type.Object({ "connectionRef": Type.Ref('DomainObjectRef'), "method": Type.String(), "methodSchema": Type.Ref('SchemaRef'), "params": Type.Ref('DataRef') }, { additionalProperties: false }),
  "McpReadResult": Type.Object({ "contentRefs": Type.Array(Type.Ref('DataRef'), { maxItems: 10000 }), "provenance": Type.Ref('Provenance'), "remoteReceipt": Type.Union([Type.Ref('DataRef'), Type.Null()]) }, { additionalProperties: false }),
  "ToolsDescribeRequest": Type.Object({ "resource": Type.Ref('ResourceRef') }, { additionalProperties: false }),
  "ToolsInspectRequest": Type.Object({ "action": Type.Ref('ActionRef') }, { additionalProperties: false }),
  "ToolsInspectResult": Type.Object({ "actionId": Type.Union([Type.Ref('Id'), Type.Null()]), "receipt": Type.Union([Type.Ref('ActionResultView'), Type.Null()]), "visibility": Type.Union([Type.Literal('absent'), Type.Literal('pending'), Type.Literal('ready')]) }, { additionalProperties: false }),
  "ToolsClassifyRequest": Type.Object({ "definition": Type.Ref('ToolDefinition'), "input": Type.Ref('DataRef') }, { additionalProperties: false }),
  "ToolsCatalogRequest": Type.Object({ "tools": Type.Array(Type.Ref('ToolDefinition'), { maxItems: 10000 }), "policy": Type.Ref('ToolCatalogPolicy') }, { additionalProperties: false }),
  "ToolsUpdatePlanResult": Type.Object({ "commandId": Type.Ref('Id'), "revision": Type.Ref('Revision'), "seq": Type.Ref('UInt53') }, { additionalProperties: false }),
  "ToolsRequestCompactionRequest": Type.Object({ "instructions": Type.Union([Type.String(), Type.Null()]) }, { additionalProperties: false }),
  "ToolsRequestCompactionResult": Type.Object({ "commandId": Type.Ref('Id'), "signalId": Type.Ref('Id') }, { additionalProperties: false }),
  "ToolsCancelRequest": Type.Object({ "attempt": Type.Ref('AttemptRef'), "reason": Type.String() }, { additionalProperties: false }),
  "ToolsCancelResult": Type.Object({ "cancellationRef": Type.Ref('ReceiptPointer'), "status": Type.Union([Type.Literal('requested'), Type.Literal('confirmed'), Type.Literal('unknown')]) }, { additionalProperties: false }),
  "ToolsReconcileRequest": Type.Object({ "attempt": Type.Ref('AttemptRef'), "evidence": Type.Union([Type.Ref('DataRef'), Type.Null()]) }, { additionalProperties: false }),
  "MemoryRememberRequest": Type.Object({ "items": Type.Array(Type.Object({ "contentRef": Type.Ref('DataRef'), "sourceRefs": Type.Array(Type.Ref('PublicRef'), { maxItems: 10000 }), "trust": Type.Union([Type.Literal('system'), Type.Literal('user'), Type.Literal('external'), Type.Literal('derived')]), "labels": Type.Array(Type.String(), { maxItems: 10000 }), "expiresAt": Type.Union([Type.Ref('Timestamp'), Type.Null()]) }, { additionalProperties: false }), { maxItems: 10000 }), "expectedRevision": Type.Ref('Revision') }, { additionalProperties: false }),
  "MemoryRememberResult": Type.Object({ "memoryRefs": Type.Array(Type.Ref('DomainObjectRef'), { maxItems: 10000 }), "revision": Type.Ref('Revision') }, { additionalProperties: false }),
  "MemoryForgetRequest": Type.Object({ "memoryIds": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "reason": Type.String(), "expectedRevision": Type.Ref('Revision') }, { additionalProperties: false }),
  "MemoryForgetResult": Type.Object({ "deletionReceipt": Type.Ref('DeletionReceipt'), "propagationJobRef": Type.Ref('DomainObjectRef') }, { additionalProperties: false }),
  "MemoryGetRequest": Type.Object({ "ids": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "atRevision": Type.Union([Type.Ref('Revision'), Type.Null()]) }, { additionalProperties: false }),
  "MemoryGetResult": Type.Object({ "items": Type.Array(Type.Ref('MemoryItem'), { maxItems: 10000 }), "revision": Type.Ref('Revision') }, { additionalProperties: false }),
  "RetrievalSearchRequest": Type.Object({ "queryText": Type.String(), "indexRef": Type.Ref('DomainObjectRef'), "topK": Type.Ref('UInt53'), "filter": Type.Ref('RetrievalFilter'), "cursor": Type.Union([Type.Ref('Cursor'), Type.Null()]) }, { additionalProperties: false }),
  "PageRetrievalHit": Type.Object({ "items": Type.Array(Type.Ref('RetrievalHit'), { maxItems: 10000 }), "snapshot": Type.Ref('Id'), "nextCursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "complete": Type.Boolean() }, { additionalProperties: false }),
  "RetrievalSearchResult": Type.Ref('PageRetrievalHit'),
  "RetrievalSearchRemoteRequest": Type.Object({ "queryText": Type.String(), "targetRef": Type.Ref('ResourceRef'), "topK": Type.Ref('UInt53'), "filter": Type.Ref('RetrievalFilter'), "embeddingRoute": Type.Union([Type.Ref('ModelRouteSnapshot'), Type.Null()]) }, { additionalProperties: false }),
  "RetrievalSearchRemoteResult": Type.Object({ "hits": Type.Array(Type.Ref('RetrievalHit'), { maxItems: 10000 }), "usageRefs": Type.Array(Type.Ref('UsageFactRef'), { maxItems: 10000 }), "provenance": Type.Ref('Provenance') }, { additionalProperties: false }),
  "EmbeddingVectors": Type.Array(Type.Array(Type.Number(), { minItems: 1, maxItems: 10000 }), { maxItems: 10000 }),
  "EmbeddingEncodeRequest": Type.Object({ "inputRefs": Type.Array(Type.Ref('DataRef'), { maxItems: 10000 }), "modelRoute": Type.Ref('ModelRouteSnapshot'), "dimensions": Type.Ref('UInt53'), "normalize": Type.Boolean() }, { additionalProperties: false }),
  "EmbeddingEncodeResult": Type.Object({ "vectorsRef": Type.Ref('DataRef'), "dimensions": Type.Ref('UInt53'), "inputDigest": Type.Ref('Digest'), "usageRefs": Type.Array(Type.Ref('UsageFactRef'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "IdentityAuthenticateRequest": Type.Object({ "credentialEnvelope": Type.Ref('DataRef'), "transportEvidence": Type.Ref('DataRef') }, { additionalProperties: false }),
  "IdentityResolveRequest": Type.Object({ "principalRef": Type.Ref('Id') }, { additionalProperties: false }),
  "PolicyEvaluateRequest": Type.Object({ "principalRef": Type.Ref('Id'), "resourceRef": Type.Ref('PublicRef'), "actionType": Type.Ref('TypeId'), "inputDigest": Type.Ref('Digest'), "scope": Type.Ref('ScopeRef'), "policyRevision": Type.Ref('Revision'), "verifiedFacts": Type.Ref('TrustedPolicyFacts') }, { additionalProperties: false }),
  "EffectsDispatchRequest": Type.Object({ "committedActionRef": Type.Ref('ActionRef'), "expectedWriterEpoch": Type.Ref('UInt53'), "expectedAuthorityEpoch": Type.Ref('UInt53') }, { additionalProperties: false }),
  "EffectsDispatchResult": Type.Object({ "attemptRef": Type.Ref('AttemptRef'), "status": Type.Ref('AttemptState'), "receiptRef": Type.Union([Type.Ref('ReceiptPointer'), Type.Null()]) }, { additionalProperties: false }),
  "EffectsReconcileRequest": Type.Object({ "attemptRef": Type.Ref('AttemptRef') }, { additionalProperties: false }),
  "EffectsReconcileResult": Type.Object({ "attemptRef": Type.Ref('AttemptRef'), "status": Type.Ref('AttemptState'), "receiptRef": Type.Union([Type.Ref('ReceiptPointer'), Type.Null()]) }, { additionalProperties: false }),
  "WorkspaceAcquireRequest": Type.Object({ "workspaceId": Type.Ref('Id'), "mode": Type.Union([Type.Literal('read'), Type.Literal('write')]), "expectedRevision": Type.Union([Type.Ref('Revision'), Type.Null()]) }, { additionalProperties: false }),
  "WorkspaceAcquireResult": Type.Object({ "mountRef": Type.Ref('MountRef'), "revision": Type.Ref('Revision'), "leaseRef": Type.Ref('LeaseRef') }, { additionalProperties: false }),
  "WorkspaceReleaseRequest": Type.Object({ "leaseRef": Type.Ref('LeaseRef') }, { additionalProperties: false }),
  "WorkspaceReleaseResult": Type.Object({ "released": Type.Boolean() }, { additionalProperties: false }),
  "FilesReadRequest": Type.Object({ "mountRef": Type.Ref('MountRef'), "path": Type.Ref('FilePath'), "range": Type.Union([Type.Ref('FileRange'), Type.Null()]), "expectedVersion": Type.Union([Type.Ref('Revision'), Type.Null()]) }, { additionalProperties: false }),
  "FilesReadResult": Type.Object({ "bytesRef": Type.Ref('BytesRef'), "version": Type.Ref('Revision') }, { additionalProperties: false }),
  "FilesWriteRequest": Type.Object({ "mountRef": Type.Ref('MountRef'), "path": Type.Ref('FilePath'), "bytesRef": Type.Ref('BytesRef'), "expectedVersion": Type.Ref('VersionPrecondition') }, { additionalProperties: false }),
  "FilesWriteResult": Type.Object({ "version": Type.Ref('Revision'), "digest": Type.Ref('Digest'), "checkpoint": Type.Ref('FileCheckpointProof') }, { additionalProperties: false }),
  "FilesListRequest": Type.Object({ "mountRef": Type.Ref('MountRef'), "path": Type.Ref('FilePath'), "cursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "limit": Type.Ref('UInt53') }, { additionalProperties: false }),
  "PageFileEntry": Type.Object({ "items": Type.Array(Type.Ref('FileEntry'), { maxItems: 10000 }), "snapshot": Type.Ref('Id'), "nextCursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "complete": Type.Boolean() }, { additionalProperties: false }),
  "FilesListResult": Type.Ref('PageFileEntry'),
  "FilesStatRequest": Type.Object({ "mountRef": Type.Ref('MountRef'), "path": Type.Ref('FilePath') }, { additionalProperties: false }),
  "SandboxCreateRequest": Type.Object({ "workspaceRef": Type.Ref('MountRef'), "mode": Type.Ref('IsolationMode'), "resourceLimits": Type.Ref('ResourceLimits'), "networkPolicyRef": Type.Ref('Id'), "filesystemPolicy": Type.Ref('FsPolicySnapshot') }, { additionalProperties: false }),
  "SandboxCreateResult": Type.Object({ "sandboxRef": Type.Ref('SandboxRef'), "achievedIsolation": Type.Ref('IsolationMode'), "limits": Type.Ref('ResourceLimits'), "filesystemProof": Type.Ref('FsEnforcementProof') }, { additionalProperties: false }),
  "SandboxStopRequest": Type.Object({ "sandboxRef": Type.Ref('SandboxRef'), "reason": Type.String() }, { additionalProperties: false }),
  "SandboxStopResult": Type.Object({ "terminationReceipt": Type.Ref('ReceiptPointer'), "effectStatus": Type.Union([Type.Literal('confirmed'), Type.Literal('unknown')]) }, { additionalProperties: false }),
  "SandboxInspectRequest": Type.Object({ "sandboxRef": Type.Ref('SandboxRef') }, { additionalProperties: false }),
  "SandboxInspectResult": Type.Object({ "state": Type.Ref('SandboxState'), "usage": Type.Array(Type.Ref('ExactQuantity'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "ExecReconcileRequest": Type.Object({ "executionRef": Type.Ref('ExecutionRef') }, { additionalProperties: false }),
  "NetworkRequestResult": Type.Object({ "status": Type.Ref('UInt53'), "headersRef": Type.Ref('DataRef'), "bodyRef": Type.Ref('BytesRef'), "finalTarget": Type.Ref('NetworkTarget'), "receipt": Type.Union([Type.Ref('DataRef'), Type.Null()]) }, { additionalProperties: false }),
  "SecretsResolveRequest": Type.Object({ "secretId": Type.Ref('Id'), "audience": Type.String(), "purpose": Type.String() }, { additionalProperties: false }),
  "SecretsRotateRequest": Type.Object({ "secretId": Type.Ref('Id'), "newVersionRef": Type.Ref('Id') }, { additionalProperties: false }),
  "SecretsRotateResult": Type.Object({ "revision": Type.Ref('Revision') }, { additionalProperties: false }),
  "SecretsRevokeRequest": Type.Object({ "secretId": Type.Ref('Id'), "reason": Type.String() }, { additionalProperties: false }),
  "SecretsRevokeResult": Type.Object({ "revision": Type.Ref('Revision') }, { additionalProperties: false }),
  "SecretsAcceptCallbackResult": Type.Object({ "flowId": Type.Ref('Id'), "escrowId": Type.Ref('Id') }, { additionalProperties: false }),
  "InteractionRespondRequest": Type.Object({ "interactionId": Type.Ref('Id'), "expectedVersion": Type.Ref('Revision'), "responseId": Type.Ref('Id'), "answer": Type.Ref('DataRef') }, { additionalProperties: false }),
  "InteractionExpireRequest": Type.Object({ "expectedVersion": Type.Ref('Revision'), "reason": Object.assign(Type.String({ minLength: 1 }), {"x-max-utf8-bytes":8192}), "interactionId": Type.Ref('Id') }, { additionalProperties: false }),
  "InteractionCancelRequest": Type.Object({ "expectedVersion": Type.Ref('Revision'), "reason": Object.assign(Type.String({ minLength: 1 }), {"x-max-utf8-bytes":8192}), "interactionId": Type.Ref('Id') }, { additionalProperties: false }),
  "InteractionReadRequest": Type.Object({ "interactionId": Type.Ref('Id') }, { additionalProperties: false }),
  "RecoveryInspectRequest": Type.Object({ "runRef": Type.Ref('RunRef'), "targetBindingRef": Type.Union([Type.Ref('BindingRef'), Type.Null()]), "checkpointRef": Type.Union([Type.Ref('DomainReference'), Type.Null()]) }, { additionalProperties: false }),
  "RecoveryInspectResult": Type.Object({ "status": Type.Union([Type.Literal('resumable'), Type.Literal('needs-reconcile'), Type.Literal('blocked'), Type.Literal('terminal')]), "frameRef": Type.Union([Type.Ref('DataRef'), Type.Null()]), "reasons": Type.Array(Type.String(), { maxItems: 10000 }), "requiredAssets": Type.Array(Type.Ref('DataRef'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "RecoveryRestoreRequest": Type.Object({ "runRef": Type.Ref('RunRef'), "targetBindingRef": Type.Union([Type.Ref('BindingRef'), Type.Null()]), "checkpointRef": Type.Union([Type.Ref('DomainReference'), Type.Null()]) }, { additionalProperties: false }),
  "RecoveryRestoreResult": Type.Object({ "status": Type.Union([Type.Literal('resumable'), Type.Literal('needs-reconcile'), Type.Literal('blocked'), Type.Literal('terminal')]), "frameRef": Type.Union([Type.Ref('DataRef'), Type.Null()]), "reasons": Type.Array(Type.String(), { maxItems: 10000 }), "requiredAssets": Type.Array(Type.Ref('DataRef'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "SupervisorAdmitResult": Type.Object({ "runId": Type.Ref('Id'), "bindingRef": Type.Ref('BindingRef') }, { additionalProperties: false }),
  "SupervisorSignalRequest": Type.Object({ "runRef": Type.Ref('RunRef'), "signalId": Type.Ref('Id'), "type": Type.Ref('SchemaRef'), "payloadRef": Type.Ref('DataRef') }, { additionalProperties: false }),
  "SupervisorSignalResult": Type.Object({ "acceptedSignalRef": Type.Ref('ReceiptPointer') }, { additionalProperties: false }),
  "SupervisorCancelRequest": Type.Object({ "runRef": Type.Ref('RunRef'), "reason": Type.String() }, { additionalProperties: false }),
  "SupervisorCancelResult": Type.Object({ "cancellationRef": Type.Ref('ReceiptPointer') }, { additionalProperties: false }),
  "SupervisorSessionParametersRequest": Type.Object({ "runRef": Type.Ref('RunRef') }, { additionalProperties: false }),
  "SupervisorSessionParametersResult": Type.Object({ "value": Type.Ref('SessionParameterRevision'), "reference": Type.Ref('DomainReference') }, { additionalProperties: false }),
  "SupervisorInspectRequest": Type.Object({ "runRef": Type.Ref('RunRef') }, { additionalProperties: false }),
  "SupervisorInspectResult": Type.Object({ "status": Type.Ref('RunState'), "revision": Type.Ref('Revision'), "waitingRefs": Type.Array(Type.Ref('PublicRef'), { maxItems: 10000 }), "blockedReason": Type.Union([Type.String(), Type.Null()]) }, { additionalProperties: false }),
  "SchedulerEnqueueRequest": Type.Object({ "deliveryId": Type.Ref('Id'), "target": Type.Ref('ScheduleTarget'), "inputRef": Type.Ref('DataRef'), "priority": Type.Union([Type.Literal('interactive'), Type.Literal('background')]), "notBefore": Type.Ref('Timestamp') }, { additionalProperties: false }),
  "SchedulerEnqueueResult": Type.Object({ "delivery": Type.Ref('SchedulerDelivery') }, { additionalProperties: false }),
  "SchedulerClaimRequest": Type.Object({ "workerId": Type.Ref('Id'), "capacity": Type.Ref('UInt53'), "capabilities": Type.Array(Type.String(), { maxItems: 10000 }) }, { additionalProperties: false }),
  "SchedulerClaimResult": Type.Object({ "claims": Type.Array(Type.Ref('SchedulerDelivery'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "SchedulerAckRequest": Type.Object({ "deliveryId": Type.Ref('Id'), "expectedEpoch": Type.Ref('UInt53'), "outcomeRef": Type.Ref('ReceiptPointer') }, { additionalProperties: false }),
  "SchedulerAckResult": Type.Object({ "state": Type.Union([Type.Literal('queued'), Type.Literal('claimed'), Type.Literal('acked'), Type.Literal('cancelled')]) }, { additionalProperties: false }),
  "AgentsSpawnResult": Type.Object({ "agentRef": Type.Ref('DomainObjectRef'), "runRef": Type.Ref('RunRef') }, { additionalProperties: false }),
  "AgentsSendRequest": Type.Object({ "agentRef": Type.Ref('DomainObjectRef'), "messageId": Type.Ref('Id'), "mode": Type.Union([Type.Literal('queue'), Type.Literal('steer')]), "contentRef": Type.Ref('DataRef') }, { additionalProperties: false }),
  "AgentsSendResult": Type.Object({ "queuedReceipt": Type.Ref('ReceiptPointer'), "consumedReceipt": Type.Union([Type.Ref('ReceiptPointer'), Type.Null()]) }, { additionalProperties: false }),
  "AgentsResumeRequest": Type.Object({ "agentRef": Type.Ref('DomainObjectRef'), "expectedRevision": Type.Ref('Revision') }, { additionalProperties: false }),
  "AgentsResumeResult": Type.Object({ "runRef": Type.Ref('RunRef'), "state": Type.String() }, { additionalProperties: false }),
  "AgentsCancelRequest": Type.Object({ "agentRef": Type.Ref('DomainObjectRef'), "reason": Type.String() }, { additionalProperties: false }),
  "AgentsCancelResult": Type.Object({ "drainRef": Type.Ref('ReceiptPointer') }, { additionalProperties: false }),
  "AgentsRetireRequest": Type.Object({ "agentRef": Type.Ref('DomainObjectRef'), "reason": Type.String() }, { additionalProperties: false }),
  "AgentsRetireResult": Type.Object({ "drainRef": Type.Ref('ReceiptPointer') }, { additionalProperties: false }),
  "AgentsInspectRequest": Type.Object({ "agentRef": Type.Ref('DomainObjectRef') }, { additionalProperties: false }),
  "JobsRequestCreateRequest": Type.Object({ "schedule": Type.Ref('JobSchedule'), "policy": Type.Ref('JobPolicy'), "target": Type.Ref('JobTarget'), "inputRef": Type.Ref('DataRef'), "budgetAccount": Type.Ref('DomainObjectRef') }, { additionalProperties: false }),
  "JobsRequestUpdateRequest": Type.Object({ "id": Type.Ref('Id'), "expectedRevision": Type.Ref('Revision'), "changes": Type.Ref('JobEdit') }, { additionalProperties: false }),
  "JobsRequestCancelRequest": Type.Object({ "id": Type.Ref('Id'), "expectedRevision": Type.Ref('Revision'), "reason": Type.String(), "cancelActive": Type.Boolean() }, { additionalProperties: false }),
})

export const Id = RuntimePublic13.Import('Id')
export type Id = Static<typeof Id>
export const UInt53 = RuntimePublic13.Import('UInt53')
export type UInt53 = Static<typeof UInt53>
export const Timestamp = RuntimePublic13.Import('Timestamp')
export type Timestamp = Static<typeof Timestamp>
export const TypeId = RuntimePublic13.Import('TypeId')
export type TypeId = Static<typeof TypeId>
export const Digest = RuntimePublic13.Import('Digest')
export type Digest = Static<typeof Digest>
export const SchemaRef = RuntimePublic13.Import('SchemaRef')
export type SchemaRef = Static<typeof SchemaRef>
export const BlobRef = RuntimePublic13.Import('BlobRef')
export type BlobRef = Static<typeof BlobRef>
export const DataRef = RuntimePublic13.Import('DataRef')
export type DataRef = Static<typeof DataRef>
export const ActionRef = RuntimePublic13.Import('ActionRef')
export type ActionRef = Static<typeof ActionRef>
export const RuntimeErrorCode = RuntimePublic13.Import('RuntimeErrorCode')
export type RuntimeErrorCode = Static<typeof RuntimeErrorCode>
export const OwnerRef = RuntimePublic13.Import('OwnerRef')
export type OwnerRef = Static<typeof OwnerRef>
export const RetryAdvice = RuntimePublic13.Import('RetryAdvice')
export type RetryAdvice = Static<typeof RetryAdvice>
export const RuntimeError = RuntimePublic13.Import('RuntimeError')
export type RuntimeError = Static<typeof RuntimeError>
export const ExternalRequestRef = RuntimePublic13.Import('ExternalRequestRef')
export type ExternalRequestRef = Static<typeof ExternalRequestRef>
export const RetentionRef = RuntimePublic13.Import('RetentionRef')
export type RetentionRef = Static<typeof RetentionRef>
export const BindingRef = RuntimePublic13.Import('BindingRef')
export type BindingRef = Static<typeof BindingRef>
export const Provenance = RuntimePublic13.Import('Provenance')
export type Provenance = Static<typeof Provenance>
export const ActionResultView = RuntimePublic13.Import('ActionResultView')
export type ActionResultView = Static<typeof ActionResultView>
export const StateAuthorityRef = RuntimePublic13.Import('StateAuthorityRef')
export type StateAuthorityRef = Static<typeof StateAuthorityRef>
export const HookEventName = RuntimePublic13.Import('HookEventName')
export type HookEventName = Static<typeof HookEventName>
export const HookResultSet = RuntimePublic13.Import('HookResultSet')
export type HookResultSet = Static<typeof HookResultSet>
export const ScopeRef = RuntimePublic13.Import('ScopeRef')
export type ScopeRef = Static<typeof ScopeRef>
export const DomainReference = RuntimePublic13.Import('DomainReference')
export type DomainReference = Static<typeof DomainReference>
export const RequestIdentity = RuntimePublic13.Import('RequestIdentity')
export type RequestIdentity = Static<typeof RequestIdentity>
export const ConversationAdmission = RuntimePublic13.Import('ConversationAdmission')
export type ConversationAdmission = Static<typeof ConversationAdmission>
export const IsolationMode = RuntimePublic13.Import('IsolationMode')
export type IsolationMode = Static<typeof IsolationMode>
export const CapabilityRequirement = RuntimePublic13.Import('CapabilityRequirement')
export type CapabilityRequirement = Static<typeof CapabilityRequirement>
export const ConfigValue = RuntimePublic13.Import('ConfigValue')
export type ConfigValue = Static<typeof ConfigValue>
export const ToolPolicyDefaults = RuntimePublic13.Import('ToolPolicyDefaults')
export type ToolPolicyDefaults = Static<typeof ToolPolicyDefaults>
export const ToolPolicySnapshot = RuntimePublic13.Import('ToolPolicySnapshot')
export type ToolPolicySnapshot = Static<typeof ToolPolicySnapshot>
export const ToolExecutionConstraints = RuntimePublic13.Import('ToolExecutionConstraints')
export type ToolExecutionConstraints = Static<typeof ToolExecutionConstraints>
export const ResourceRef = RuntimePublic13.Import('ResourceRef')
export type ResourceRef = Static<typeof ResourceRef>
export const ToolDefinition = RuntimePublic13.Import('ToolDefinition')
export type ToolDefinition = Static<typeof ToolDefinition>
export const ArtifactVersion = RuntimePublic13.Import('ArtifactVersion')
export type ArtifactVersion = Static<typeof ArtifactVersion>
export const ArtifactRef = RuntimePublic13.Import('ArtifactRef')
export type ArtifactRef = Static<typeof ArtifactRef>
export const Revision = RuntimePublic13.Import('Revision')
export type Revision = Static<typeof Revision>
export const DomainObjectRef = RuntimePublic13.Import('DomainObjectRef')
export type DomainObjectRef = Static<typeof DomainObjectRef>
export const ModelFeatures = RuntimePublic13.Import('ModelFeatures')
export type ModelFeatures = Static<typeof ModelFeatures>
export const SecretConsumerBinding = RuntimePublic13.Import('SecretConsumerBinding')
export type SecretConsumerBinding = Static<typeof SecretConsumerBinding>
export const ModelRouteSnapshot = RuntimePublic13.Import('ModelRouteSnapshot')
export type ModelRouteSnapshot = Static<typeof ModelRouteSnapshot>
export const ToolCatalogPolicy = RuntimePublic13.Import('ToolCatalogPolicy')
export type ToolCatalogPolicy = Static<typeof ToolCatalogPolicy>
export const TaintSnapshot = RuntimePublic13.Import('TaintSnapshot')
export type TaintSnapshot = Static<typeof TaintSnapshot>
export const SessionRef = RuntimePublic13.Import('SessionRef')
export type SessionRef = Static<typeof SessionRef>
export const RunRef = RuntimePublic13.Import('RunRef')
export type RunRef = Static<typeof RunRef>
export const InteractionRef = RuntimePublic13.Import('InteractionRef')
export type InteractionRef = Static<typeof InteractionRef>
export const PublicBlobReference = RuntimePublic13.Import('PublicBlobReference')
export type PublicBlobReference = Static<typeof PublicBlobReference>
export const UploadSession = RuntimePublic13.Import('UploadSession')
export type UploadSession = Static<typeof UploadSession>
export const PublicUploadReference = RuntimePublic13.Import('PublicUploadReference')
export type PublicUploadReference = Static<typeof PublicUploadReference>
export const StagedBlobRef = RuntimePublic13.Import('StagedBlobRef')
export type StagedBlobRef = Static<typeof StagedBlobRef>
export const PublicStagedBlobReference = RuntimePublic13.Import('PublicStagedBlobReference')
export type PublicStagedBlobReference = Static<typeof PublicStagedBlobReference>
export const PublicRef = RuntimePublic13.Import('PublicRef')
export type PublicRef = Static<typeof PublicRef>
export const ApprovalGrantEvidence = RuntimePublic13.Import('ApprovalGrantEvidence')
export type ApprovalGrantEvidence = Static<typeof ApprovalGrantEvidence>
export const ReceiptPointer = RuntimePublic13.Import('ReceiptPointer')
export type ReceiptPointer = Static<typeof ReceiptPointer>
export const TrustedPolicyFacts = RuntimePublic13.Import('TrustedPolicyFacts')
export type TrustedPolicyFacts = Static<typeof TrustedPolicyFacts>
export const FilePath = RuntimePublic13.Import('FilePath')
export type FilePath = Static<typeof FilePath>
export const FileCheckpointProof = RuntimePublic13.Import('FileCheckpointProof')
export type FileCheckpointProof = Static<typeof FileCheckpointProof>
export const ExactQuantity = RuntimePublic13.Import('ExactQuantity')
export type ExactQuantity = Static<typeof ExactQuantity>
export const SessionControlBoundary = RuntimePublic13.Import('SessionControlBoundary')
export type SessionControlBoundary = Static<typeof SessionControlBoundary>
export const SessionParameterRevision = RuntimePublic13.Import('SessionParameterRevision')
export type SessionParameterRevision = Static<typeof SessionParameterRevision>
export const ResourceLimits = RuntimePublic13.Import('ResourceLimits')
export type ResourceLimits = Static<typeof ResourceLimits>
export const RunState = RuntimePublic13.Import('RunState')
export type RunState = Static<typeof RunState>
export const UsageFactRef = RuntimePublic13.Import('UsageFactRef')
export type UsageFactRef = Static<typeof UsageFactRef>
export const FsPolicySnapshot = RuntimePublic13.Import('FsPolicySnapshot')
export type FsPolicySnapshot = Static<typeof FsPolicySnapshot>
export const LeaseRef = RuntimePublic13.Import('LeaseRef')
export type LeaseRef = Static<typeof LeaseRef>
export const MountRef = RuntimePublic13.Import('MountRef')
export type MountRef = Static<typeof MountRef>
export const FsEnforcementProof = RuntimePublic13.Import('FsEnforcementProof')
export type FsEnforcementProof = Static<typeof FsEnforcementProof>
export const AttemptRef = RuntimePublic13.Import('AttemptRef')
export type AttemptRef = Static<typeof AttemptRef>
export const Cursor = RuntimePublic13.Import('Cursor')
export type Cursor = Static<typeof Cursor>
export const AttemptState = RuntimePublic13.Import('AttemptState')
export type AttemptState = Static<typeof AttemptState>
export const BytesRef = RuntimePublic13.Import('BytesRef')
export type BytesRef = Static<typeof BytesRef>
export const RetrievalFilter = RuntimePublic13.Import('RetrievalFilter')
export type RetrievalFilter = Static<typeof RetrievalFilter>
export const VersionPrecondition = RuntimePublic13.Import('VersionPrecondition')
export type VersionPrecondition = Static<typeof VersionPrecondition>
export const FileRange = RuntimePublic13.Import('FileRange')
export type FileRange = Static<typeof FileRange>
export const FileEntry = RuntimePublic13.Import('FileEntry')
export type FileEntry = Static<typeof FileEntry>
export const SandboxRef = RuntimePublic13.Import('SandboxRef')
export type SandboxRef = Static<typeof SandboxRef>
export const SandboxState = RuntimePublic13.Import('SandboxState')
export type SandboxState = Static<typeof SandboxState>
export const ExecutionRef = RuntimePublic13.Import('ExecutionRef')
export type ExecutionRef = Static<typeof ExecutionRef>
export const NetworkTarget = RuntimePublic13.Import('NetworkTarget')
export type NetworkTarget = Static<typeof NetworkTarget>
export const NewRunSpec = RuntimePublic13.Import('NewRunSpec')
export type NewRunSpec = Static<typeof NewRunSpec>
export const ScheduleTarget = RuntimePublic13.Import('ScheduleTarget')
export type ScheduleTarget = Static<typeof ScheduleTarget>
export const SchedulerDelivery = RuntimePublic13.Import('SchedulerDelivery')
export type SchedulerDelivery = Static<typeof SchedulerDelivery>
export const JobTarget = RuntimePublic13.Import('JobTarget')
export type JobTarget = Static<typeof JobTarget>
export const JobSchedule = RuntimePublic13.Import('JobSchedule')
export type JobSchedule = Static<typeof JobSchedule>
export const JobPolicy = RuntimePublic13.Import('JobPolicy')
export type JobPolicy = Static<typeof JobPolicy>
export const JobEdit = RuntimePublic13.Import('JobEdit')
export type JobEdit = Static<typeof JobEdit>
export const MemoryItem = RuntimePublic13.Import('MemoryItem')
export type MemoryItem = Static<typeof MemoryItem>
export const DeletionReceipt = RuntimePublic13.Import('DeletionReceipt')
export type DeletionReceipt = Static<typeof DeletionReceipt>
export const RetrievalHit = RuntimePublic13.Import('RetrievalHit')
export type RetrievalHit = Static<typeof RetrievalHit>
export const ResourcesRegisterResult = RuntimePublic13.Import('ResourcesRegisterResult')
export type ResourcesRegisterResult = Static<typeof ResourcesRegisterResult>
export const ResourcesRemoveRequest = RuntimePublic13.Import('ResourcesRemoveRequest')
export type ResourcesRemoveRequest = Static<typeof ResourcesRemoveRequest>
export const ResourcesRemoveResult = RuntimePublic13.Import('ResourcesRemoveResult')
export type ResourcesRemoveResult = Static<typeof ResourcesRemoveResult>
export const ResourcesRetainRequest = RuntimePublic13.Import('ResourcesRetainRequest')
export type ResourcesRetainRequest = Static<typeof ResourcesRetainRequest>
export const ResourcesReleaseRequest = RuntimePublic13.Import('ResourcesReleaseRequest')
export type ResourcesReleaseRequest = Static<typeof ResourcesReleaseRequest>
export const ResourcesReleaseResult = RuntimePublic13.Import('ResourcesReleaseResult')
export type ResourcesReleaseResult = Static<typeof ResourcesReleaseResult>
export const McpConnectResult = RuntimePublic13.Import('McpConnectResult')
export type McpConnectResult = Static<typeof McpConnectResult>
export const McpCallRequest = RuntimePublic13.Import('McpCallRequest')
export type McpCallRequest = Static<typeof McpCallRequest>
export const McpCallResult = RuntimePublic13.Import('McpCallResult')
export type McpCallResult = Static<typeof McpCallResult>
export const McpReadRequest = RuntimePublic13.Import('McpReadRequest')
export type McpReadRequest = Static<typeof McpReadRequest>
export const McpReadResult = RuntimePublic13.Import('McpReadResult')
export type McpReadResult = Static<typeof McpReadResult>
export const ToolsDescribeRequest = RuntimePublic13.Import('ToolsDescribeRequest')
export type ToolsDescribeRequest = Static<typeof ToolsDescribeRequest>
export const ToolsInspectRequest = RuntimePublic13.Import('ToolsInspectRequest')
export type ToolsInspectRequest = Static<typeof ToolsInspectRequest>
export const ToolsInspectResult = RuntimePublic13.Import('ToolsInspectResult')
export type ToolsInspectResult = Static<typeof ToolsInspectResult>
export const ToolsClassifyRequest = RuntimePublic13.Import('ToolsClassifyRequest')
export type ToolsClassifyRequest = Static<typeof ToolsClassifyRequest>
export const ToolsCatalogRequest = RuntimePublic13.Import('ToolsCatalogRequest')
export type ToolsCatalogRequest = Static<typeof ToolsCatalogRequest>
export const ToolsUpdatePlanResult = RuntimePublic13.Import('ToolsUpdatePlanResult')
export type ToolsUpdatePlanResult = Static<typeof ToolsUpdatePlanResult>
export const ToolsRequestCompactionRequest = RuntimePublic13.Import('ToolsRequestCompactionRequest')
export type ToolsRequestCompactionRequest = Static<typeof ToolsRequestCompactionRequest>
export const ToolsRequestCompactionResult = RuntimePublic13.Import('ToolsRequestCompactionResult')
export type ToolsRequestCompactionResult = Static<typeof ToolsRequestCompactionResult>
export const ToolsCancelRequest = RuntimePublic13.Import('ToolsCancelRequest')
export type ToolsCancelRequest = Static<typeof ToolsCancelRequest>
export const ToolsCancelResult = RuntimePublic13.Import('ToolsCancelResult')
export type ToolsCancelResult = Static<typeof ToolsCancelResult>
export const ToolsReconcileRequest = RuntimePublic13.Import('ToolsReconcileRequest')
export type ToolsReconcileRequest = Static<typeof ToolsReconcileRequest>
export const MemoryRememberRequest = RuntimePublic13.Import('MemoryRememberRequest')
export type MemoryRememberRequest = Static<typeof MemoryRememberRequest>
export const MemoryRememberResult = RuntimePublic13.Import('MemoryRememberResult')
export type MemoryRememberResult = Static<typeof MemoryRememberResult>
export const MemoryForgetRequest = RuntimePublic13.Import('MemoryForgetRequest')
export type MemoryForgetRequest = Static<typeof MemoryForgetRequest>
export const MemoryForgetResult = RuntimePublic13.Import('MemoryForgetResult')
export type MemoryForgetResult = Static<typeof MemoryForgetResult>
export const MemoryGetRequest = RuntimePublic13.Import('MemoryGetRequest')
export type MemoryGetRequest = Static<typeof MemoryGetRequest>
export const MemoryGetResult = RuntimePublic13.Import('MemoryGetResult')
export type MemoryGetResult = Static<typeof MemoryGetResult>
export const RetrievalSearchRequest = RuntimePublic13.Import('RetrievalSearchRequest')
export type RetrievalSearchRequest = Static<typeof RetrievalSearchRequest>
export const PageRetrievalHit = RuntimePublic13.Import('PageRetrievalHit')
export type PageRetrievalHit = Page<RetrievalHit>
export const RetrievalSearchResult = RuntimePublic13.Import('RetrievalSearchResult')
export type RetrievalSearchResult = PageRetrievalHit
export const RetrievalSearchRemoteRequest = RuntimePublic13.Import('RetrievalSearchRemoteRequest')
export type RetrievalSearchRemoteRequest = Static<typeof RetrievalSearchRemoteRequest>
export const RetrievalSearchRemoteResult = RuntimePublic13.Import('RetrievalSearchRemoteResult')
export type RetrievalSearchRemoteResult = Static<typeof RetrievalSearchRemoteResult>
export const EmbeddingVectors = RuntimePublic13.Import('EmbeddingVectors')
export type EmbeddingVectors = Static<typeof EmbeddingVectors>
export const EmbeddingEncodeRequest = RuntimePublic13.Import('EmbeddingEncodeRequest')
export type EmbeddingEncodeRequest = Static<typeof EmbeddingEncodeRequest>
export const EmbeddingEncodeResult = RuntimePublic13.Import('EmbeddingEncodeResult')
export type EmbeddingEncodeResult = Static<typeof EmbeddingEncodeResult>
export const IdentityAuthenticateRequest = RuntimePublic13.Import('IdentityAuthenticateRequest')
export type IdentityAuthenticateRequest = Static<typeof IdentityAuthenticateRequest>
export const IdentityResolveRequest = RuntimePublic13.Import('IdentityResolveRequest')
export type IdentityResolveRequest = Static<typeof IdentityResolveRequest>
export const PolicyEvaluateRequest = RuntimePublic13.Import('PolicyEvaluateRequest')
export type PolicyEvaluateRequest = Static<typeof PolicyEvaluateRequest>
export const EffectsDispatchRequest = RuntimePublic13.Import('EffectsDispatchRequest')
export type EffectsDispatchRequest = Static<typeof EffectsDispatchRequest>
export const EffectsDispatchResult = RuntimePublic13.Import('EffectsDispatchResult')
export type EffectsDispatchResult = Static<typeof EffectsDispatchResult>
export const EffectsReconcileRequest = RuntimePublic13.Import('EffectsReconcileRequest')
export type EffectsReconcileRequest = Static<typeof EffectsReconcileRequest>
export const EffectsReconcileResult = RuntimePublic13.Import('EffectsReconcileResult')
export type EffectsReconcileResult = Static<typeof EffectsReconcileResult>
export const WorkspaceAcquireRequest = RuntimePublic13.Import('WorkspaceAcquireRequest')
export type WorkspaceAcquireRequest = Static<typeof WorkspaceAcquireRequest>
export const WorkspaceAcquireResult = RuntimePublic13.Import('WorkspaceAcquireResult')
export type WorkspaceAcquireResult = Static<typeof WorkspaceAcquireResult>
export const WorkspaceReleaseRequest = RuntimePublic13.Import('WorkspaceReleaseRequest')
export type WorkspaceReleaseRequest = Static<typeof WorkspaceReleaseRequest>
export const WorkspaceReleaseResult = RuntimePublic13.Import('WorkspaceReleaseResult')
export type WorkspaceReleaseResult = Static<typeof WorkspaceReleaseResult>
export const FilesReadRequest = RuntimePublic13.Import('FilesReadRequest')
export type FilesReadRequest = Static<typeof FilesReadRequest>
export const FilesReadResult = RuntimePublic13.Import('FilesReadResult')
export type FilesReadResult = Static<typeof FilesReadResult>
export const FilesWriteRequest = RuntimePublic13.Import('FilesWriteRequest')
export type FilesWriteRequest = Static<typeof FilesWriteRequest>
export const FilesWriteResult = RuntimePublic13.Import('FilesWriteResult')
export type FilesWriteResult = Static<typeof FilesWriteResult>
export const FilesListRequest = RuntimePublic13.Import('FilesListRequest')
export type FilesListRequest = Static<typeof FilesListRequest>
export const PageFileEntry = RuntimePublic13.Import('PageFileEntry')
export type PageFileEntry = Page<FileEntry>
export const FilesListResult = RuntimePublic13.Import('FilesListResult')
export type FilesListResult = PageFileEntry
export const FilesStatRequest = RuntimePublic13.Import('FilesStatRequest')
export type FilesStatRequest = Static<typeof FilesStatRequest>
export const SandboxCreateRequest = RuntimePublic13.Import('SandboxCreateRequest')
export type SandboxCreateRequest = Static<typeof SandboxCreateRequest>
export const SandboxCreateResult = RuntimePublic13.Import('SandboxCreateResult')
export type SandboxCreateResult = Static<typeof SandboxCreateResult>
export const SandboxStopRequest = RuntimePublic13.Import('SandboxStopRequest')
export type SandboxStopRequest = Static<typeof SandboxStopRequest>
export const SandboxStopResult = RuntimePublic13.Import('SandboxStopResult')
export type SandboxStopResult = Static<typeof SandboxStopResult>
export const SandboxInspectRequest = RuntimePublic13.Import('SandboxInspectRequest')
export type SandboxInspectRequest = Static<typeof SandboxInspectRequest>
export const SandboxInspectResult = RuntimePublic13.Import('SandboxInspectResult')
export type SandboxInspectResult = Static<typeof SandboxInspectResult>
export const ExecReconcileRequest = RuntimePublic13.Import('ExecReconcileRequest')
export type ExecReconcileRequest = Static<typeof ExecReconcileRequest>
export const NetworkRequestResult = RuntimePublic13.Import('NetworkRequestResult')
export type NetworkRequestResult = Static<typeof NetworkRequestResult>
export const SecretsResolveRequest = RuntimePublic13.Import('SecretsResolveRequest')
export type SecretsResolveRequest = Static<typeof SecretsResolveRequest>
export const SecretsRotateRequest = RuntimePublic13.Import('SecretsRotateRequest')
export type SecretsRotateRequest = Static<typeof SecretsRotateRequest>
export const SecretsRotateResult = RuntimePublic13.Import('SecretsRotateResult')
export type SecretsRotateResult = Static<typeof SecretsRotateResult>
export const SecretsRevokeRequest = RuntimePublic13.Import('SecretsRevokeRequest')
export type SecretsRevokeRequest = Static<typeof SecretsRevokeRequest>
export const SecretsRevokeResult = RuntimePublic13.Import('SecretsRevokeResult')
export type SecretsRevokeResult = Static<typeof SecretsRevokeResult>
export const SecretsAcceptCallbackResult = RuntimePublic13.Import('SecretsAcceptCallbackResult')
export type SecretsAcceptCallbackResult = Static<typeof SecretsAcceptCallbackResult>
export const InteractionRespondRequest = RuntimePublic13.Import('InteractionRespondRequest')
export type InteractionRespondRequest = Static<typeof InteractionRespondRequest>
export const InteractionExpireRequest = RuntimePublic13.Import('InteractionExpireRequest')
export type InteractionExpireRequest = Static<typeof InteractionExpireRequest>
export const InteractionCancelRequest = RuntimePublic13.Import('InteractionCancelRequest')
export type InteractionCancelRequest = Static<typeof InteractionCancelRequest>
export const InteractionReadRequest = RuntimePublic13.Import('InteractionReadRequest')
export type InteractionReadRequest = Static<typeof InteractionReadRequest>
export const RecoveryInspectRequest = RuntimePublic13.Import('RecoveryInspectRequest')
export type RecoveryInspectRequest = Static<typeof RecoveryInspectRequest>
export const RecoveryInspectResult = RuntimePublic13.Import('RecoveryInspectResult')
export type RecoveryInspectResult = Static<typeof RecoveryInspectResult>
export const RecoveryRestoreRequest = RuntimePublic13.Import('RecoveryRestoreRequest')
export type RecoveryRestoreRequest = Static<typeof RecoveryRestoreRequest>
export const RecoveryRestoreResult = RuntimePublic13.Import('RecoveryRestoreResult')
export type RecoveryRestoreResult = Static<typeof RecoveryRestoreResult>
export const SupervisorAdmitResult = RuntimePublic13.Import('SupervisorAdmitResult')
export type SupervisorAdmitResult = Static<typeof SupervisorAdmitResult>
export const SupervisorSignalRequest = RuntimePublic13.Import('SupervisorSignalRequest')
export type SupervisorSignalRequest = Static<typeof SupervisorSignalRequest>
export const SupervisorSignalResult = RuntimePublic13.Import('SupervisorSignalResult')
export type SupervisorSignalResult = Static<typeof SupervisorSignalResult>
export const SupervisorCancelRequest = RuntimePublic13.Import('SupervisorCancelRequest')
export type SupervisorCancelRequest = Static<typeof SupervisorCancelRequest>
export const SupervisorCancelResult = RuntimePublic13.Import('SupervisorCancelResult')
export type SupervisorCancelResult = Static<typeof SupervisorCancelResult>
export const SupervisorSessionParametersRequest = RuntimePublic13.Import('SupervisorSessionParametersRequest')
export type SupervisorSessionParametersRequest = Static<typeof SupervisorSessionParametersRequest>
export const SupervisorSessionParametersResult = RuntimePublic13.Import('SupervisorSessionParametersResult')
export type SupervisorSessionParametersResult = Static<typeof SupervisorSessionParametersResult>
export const SupervisorInspectRequest = RuntimePublic13.Import('SupervisorInspectRequest')
export type SupervisorInspectRequest = Static<typeof SupervisorInspectRequest>
export const SupervisorInspectResult = RuntimePublic13.Import('SupervisorInspectResult')
export type SupervisorInspectResult = Static<typeof SupervisorInspectResult>
export const SchedulerEnqueueRequest = RuntimePublic13.Import('SchedulerEnqueueRequest')
export type SchedulerEnqueueRequest = Static<typeof SchedulerEnqueueRequest>
export const SchedulerEnqueueResult = RuntimePublic13.Import('SchedulerEnqueueResult')
export type SchedulerEnqueueResult = Static<typeof SchedulerEnqueueResult>
export const SchedulerClaimRequest = RuntimePublic13.Import('SchedulerClaimRequest')
export type SchedulerClaimRequest = Static<typeof SchedulerClaimRequest>
export const SchedulerClaimResult = RuntimePublic13.Import('SchedulerClaimResult')
export type SchedulerClaimResult = Static<typeof SchedulerClaimResult>
export const SchedulerAckRequest = RuntimePublic13.Import('SchedulerAckRequest')
export type SchedulerAckRequest = Static<typeof SchedulerAckRequest>
export const SchedulerAckResult = RuntimePublic13.Import('SchedulerAckResult')
export type SchedulerAckResult = Static<typeof SchedulerAckResult>
export const AgentsSpawnResult = RuntimePublic13.Import('AgentsSpawnResult')
export type AgentsSpawnResult = Static<typeof AgentsSpawnResult>
export const AgentsSendRequest = RuntimePublic13.Import('AgentsSendRequest')
export type AgentsSendRequest = Static<typeof AgentsSendRequest>
export const AgentsSendResult = RuntimePublic13.Import('AgentsSendResult')
export type AgentsSendResult = Static<typeof AgentsSendResult>
export const AgentsResumeRequest = RuntimePublic13.Import('AgentsResumeRequest')
export type AgentsResumeRequest = Static<typeof AgentsResumeRequest>
export const AgentsResumeResult = RuntimePublic13.Import('AgentsResumeResult')
export type AgentsResumeResult = Static<typeof AgentsResumeResult>
export const AgentsCancelRequest = RuntimePublic13.Import('AgentsCancelRequest')
export type AgentsCancelRequest = Static<typeof AgentsCancelRequest>
export const AgentsCancelResult = RuntimePublic13.Import('AgentsCancelResult')
export type AgentsCancelResult = Static<typeof AgentsCancelResult>
export const AgentsRetireRequest = RuntimePublic13.Import('AgentsRetireRequest')
export type AgentsRetireRequest = Static<typeof AgentsRetireRequest>
export const AgentsRetireResult = RuntimePublic13.Import('AgentsRetireResult')
export type AgentsRetireResult = Static<typeof AgentsRetireResult>
export const AgentsInspectRequest = RuntimePublic13.Import('AgentsInspectRequest')
export type AgentsInspectRequest = Static<typeof AgentsInspectRequest>
export const JobsRequestCreateRequest = RuntimePublic13.Import('JobsRequestCreateRequest')
export type JobsRequestCreateRequest = Static<typeof JobsRequestCreateRequest>
export const JobsRequestUpdateRequest = RuntimePublic13.Import('JobsRequestUpdateRequest')
export type JobsRequestUpdateRequest = Static<typeof JobsRequestUpdateRequest>
export const JobsRequestCancelRequest = RuntimePublic13.Import('JobsRequestCancelRequest')
export type JobsRequestCancelRequest = Static<typeof JobsRequestCancelRequest>
