import type { Page } from './runtime-public.js'
// generated from schema by tools/gen.ts — do not edit
import { Type, type Static } from '@sinclair/typebox'
import { FormatRegistry } from '@sinclair/typebox'

if (!FormatRegistry.Has('date-time')) FormatRegistry.Set('date-time', (value) => { const parts = value.split(/t/i); if (parts.length !== 2) return false; const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(parts[0] ?? ''); const time = /^(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)(z|([+-])(\d{2}):(\d{2}))$/i.exec(parts[1] ?? ''); if (!date || !time) return false; const year = Number(date[1]), month = Number(date[2]), day = Number(date[3]); const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0); const days = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; if (month < 1 || month > 12 || day < 1 || day > (days[month] ?? 0)) return false; const hour = Number(time[1]), minute = Number(time[2]), second = Number(time[3]); const offsetHour = Number(time[6] || 0), offsetMinute = Number(time[7] || 0); if (hour > 23 || minute > 59 || offsetHour > 23 || offsetMinute > 59) return false; if (second < 60) return true; const sign = time[5] === '-' ? -1 : 1; const utcMinute = minute - offsetMinute * sign; const utcHour = hour - offsetHour * sign - (utcMinute < 0 ? 1 : 0); return (utcHour === 23 || utcHour === -1) && (utcMinute === 59 || utcMinute === -1) && second < 61; })

export const JsonValue = Type.Recursive((This) => Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String(), Type.Array(This, { minItems: 0, maxItems: 10000 }), Type.Record(Type.String(), This)]))
export type JsonValue = Static<typeof JsonValue>

export const RuntimePublic12 = Type.Module({
  "Id": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }),
  "UInt53": Type.Integer({ minimum: 0, maximum: 9007199254740991 }),
  "Timestamp": Type.String({ pattern: "Z$", format: "date-time" }),
  "TypeId": Type.String({ minLength: 1, maxLength: 256, pattern: "^[a-z][a-z0-9.-]*/[a-zA-Z0-9._/-]+@[1-9][0-9]*$" }),
  "Digest": Type.String({ pattern: "^[a-f0-9]{64}$" }),
  "SchemaRef": Type.Object({ "typeId": Type.Ref('TypeId'), "revision": Type.Ref('UInt53'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "BlobRef": Type.Object({ "authorityId": Type.Ref('Id'), "blobId": Type.Ref('Id'), "digest": Type.Ref('Digest'), "bytes": Type.Ref('UInt53'), "mediaType": Type.String(), "pinId": Type.Ref('Id') }, { additionalProperties: false }),
  "DataRef": Type.Union([Type.Object({ "kind": Type.Literal('inline'), "schema": Type.Ref('SchemaRef'), "value": JsonValue, "digest": Type.Ref('Digest'), "bytes": Type.Ref('UInt53') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('blob'), "schema": Type.Ref('SchemaRef'), "blob": Type.Ref('BlobRef') }, { additionalProperties: false })]),
  "ActionRef": Type.Union([Type.Object({ "existingActionId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "localKey": Type.String() }, { additionalProperties: false })]),
  "ExternalRequestRef": Type.Object({ "system": Type.String(), "requestId": Type.Ref('Id'), "idempotencyKey": Type.Optional(Type.String()), "requestDigest": Type.Ref('Digest') }, { additionalProperties: false }),
  "RetentionRef": Type.Object({ "kind": Type.Union([Type.Literal('blob'), Type.Literal('artifact'), Type.Literal('domain-record'), Type.Literal('package'), Type.Literal('schema'), Type.Literal('codec')]), "authorityId": Type.Ref('Id'), "resourceId": Type.Ref('Id'), "version": Type.String(), "digest": Type.Ref('Digest'), "pinId": Type.Ref('Id') }, { additionalProperties: false }),
  "BindingRef": Type.Object({ "bindingId": Type.Ref('Id'), "contract": Type.String(), "logicalName": Type.String(), "providerId": Type.Ref('Id') }, { additionalProperties: false }),
  "Provenance": Type.Object({ "sourceRefs": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "producer": Type.Ref('BindingRef'), "trustLabels": Type.Array(Type.String(), { maxItems: 10000 }) }, { additionalProperties: false }),
  "StateAuthorityRef": Type.Object({ "authorityId": Type.Ref('Id'), "tenantId": Type.Ref('Id'), "authorityEpoch": Type.Ref('UInt53') }, { additionalProperties: false }),
  "HookEventName": Type.Union([Type.Literal('tool_call'), Type.Literal('approval_request'), Type.Literal('tool_result'), Type.Literal('context'), Type.Literal('before_request'), Type.Literal('request_error'), Type.Literal('format_deviation'), Type.Literal('before_compact'), Type.Literal('compact'), Type.Literal('session_start'), Type.Literal('shutdown'), Type.Literal('subagent_start'), Type.Literal('subagent_end'), Type.Literal('resources_discover'), Type.Literal('before_step'), Type.Literal('turn_stopping')]),
  "HookResultSet": Type.Object({ "stageId": Type.Ref('Id'), "event": Type.Ref('HookEventName'), "registrationDigest": Type.Ref('Digest'), "inputDigest": Type.Ref('Digest'), "entries": Type.Array(Type.Object({ "registrationId": Type.Ref('Id'), "ordinal": Type.Ref('UInt53'), "outcome": Type.Union([Type.Literal('applied'), Type.Literal('failed-open'), Type.Literal('denied')]), "output": Type.Union([Type.Ref('DataRef'), Type.Null()]), "diagnosticId": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false }), { maxItems: 10000 }), "output": Type.Ref('DataRef'), "digest": Type.Ref('Digest'), "sourceActionId": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false }),
  "ScopeRef": Type.Union([Type.Object({ "installationId": Type.Ref('Id'), "kind": Type.Literal('installation') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "kind": Type.Literal('runtime') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "kind": Type.Literal('workspace') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "kind": Type.Literal('session') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "runId": Type.Ref('Id'), "kind": Type.Literal('run') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "runId": Type.Ref('Id'), "kind": Type.Literal('action'), "actionId": Type.Ref('Id') }, { additionalProperties: false })]),
  "DomainReference": Type.Object({ "authorityId": Type.Ref('Id'), "recordId": Type.Ref('Id'), "recordRevision": Type.Ref('UInt53'), "schema": Type.Ref('SchemaRef'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "RequestIdentity": Type.Object({ "system": Type.String(), "aghRequestId": Type.Ref('Id'), "idempotencyKey": Type.Union([Type.String(), Type.Null()]), "requestDigest": Type.Ref('Digest') }, { additionalProperties: false }),
  "ConversationAdmission": Type.Object({ "turnId": Type.Ref('Id'), "inputMessageId": Type.Ref('Id'), "inputRef": Type.Ref('DataRef'), "kind": Type.Union([Type.Literal('prompt'), Type.Literal('follow-up')]) }, { additionalProperties: false }),
  "Money": Type.Object({ "currency": Type.String(), "scale": Type.Literal(6), "units": Type.String() }, { additionalProperties: false }),
  "UsageFact": Type.Object({ "usageId": Type.Ref('Id'), "originKey": Type.String(), "actionId": Type.Ref('Id'), "attemptId": Type.Ref('Id'), "source": Type.Ref('BindingRef'), "dimensions": Type.Ref('DataRef'), "externalRequest": Type.Ref('ExternalRequestRef'), "observedAt": Type.Ref('Timestamp'), "certainty": Type.Union([Type.Literal('measured'), Type.Literal('estimated'), Type.Literal('unknown')]) }, { additionalProperties: false }),
  "IsolationMode": Type.Union([Type.Literal('trusted-in-process'), Type.Literal('isolated-process'), Type.Literal('remote')]),
  "ConfigValue": Type.Object({ "schema": Type.Ref('SchemaRef'), "value": JsonValue }, { additionalProperties: false }),
  "ToolPolicySnapshot": Type.Object({ "isReadOnly": Type.Boolean(), "isDestructive": Type.Boolean(), "replay": Type.Union([Type.Literal('safe'), Type.Literal('never'), Type.Literal('idempotent')]), "requiresApproval": Type.Union([Type.Literal('never'), Type.Literal('destructive'), Type.Literal('always')]), "approvalScopes": Type.Array(Type.String(), { maxItems: 16 }), "policyVersion": Type.String(), "classifierDigest": Type.Ref('Digest'), "inputDigest": Type.Ref('Digest'), "definitionDigest": Type.Ref('Digest'), "fingerprint": Type.Ref('Digest') }, { additionalProperties: false }),
  "ResourceRef": Type.Object({ "resourceId": Type.Ref('Id'), "version": Type.String(), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "ArtifactRef": Type.Object({ "artifactId": Type.Ref('Id'), "version": Type.Ref('UInt53') }, { additionalProperties: false }),
  "Revision": Type.Ref('UInt53'),
  "DomainObjectRef": Type.Object({ "authorityId": Type.Ref('Id'), "typeId": Type.Ref('TypeId'), "id": Type.Ref('Id'), "revision": Type.Ref('Revision') }, { additionalProperties: false }),
  "ModelFeatures": Type.Object({ "input": Type.Array(Type.Union([Type.Literal('text'), Type.Literal('image'), Type.Literal('audio'), Type.Literal('video')]), { maxItems: 10000 }), "output": Type.Array(Type.Union([Type.Literal('text'), Type.Literal('image'), Type.Literal('audio'), Type.Literal('video')]), { maxItems: 10000 }), "tools": Type.Boolean(), "structuredOutput": Type.Boolean(), "streaming": Type.Boolean() }, { additionalProperties: false }),
  "SecretConsumerBinding": Type.Object({ "consumer": Type.Union([Type.Literal('model'), Type.Literal('mcp'), Type.Literal('tls'), Type.Literal('jwt'), Type.Literal('source-auth'), Type.Literal('surface')]), "secretId": Type.Ref('Id'), "accountRef": Type.Union([Type.Ref('Id'), Type.Null()]), "serverRef": Type.Ref('Id'), "audience": Type.String(), "purpose": Type.String() }, { additionalProperties: false }),
  "ModelRouteSnapshot": Type.Object({ "routeId": Type.Ref('Id'), "routeRevision": Type.Ref('Revision'), "adapter": Type.Ref('BindingRef'), "model": Type.String(), "endpointRef": Type.Ref('Id'), "catalogRevision": Type.Ref('Revision'), "features": Type.Ref('ModelFeatures'), "priceVersion": Type.Ref('Id'), "credentialAudience": Type.String(), "credentialBinding": Type.Union([Type.Ref('SecretConsumerBinding'), Type.Null()]) }, { additionalProperties: false }),
  "TaintSnapshot": Type.Object({ "recordRevision": Type.Integer({ minimum: 1, maximum: 9007199254740991 }), "sourceSeq": Type.Ref('UInt53'), "clearedThroughSeq": Type.Ref('UInt53') }, { additionalProperties: false }),
  "SessionRef": Type.Object({ "sessionId": Type.Ref('Id'), "authority": Type.Ref('StateAuthorityRef') }, { additionalProperties: false }),
  "RunRef": Type.Object({ "runId": Type.Ref('Id'), "session": Type.Ref('SessionRef') }, { additionalProperties: false }),
  "InteractionRef": Type.Object({ "interactionId": Type.Ref('Id') }, { additionalProperties: false }),
  "UploadSession": Type.Object({ "authorityId": Type.Ref('Id'), "uploadId": Type.Ref('Id'), "reservationId": Type.Ref('Id'), "expectedBytes": Type.Ref('UInt53'), "receivedBytes": Type.Ref('UInt53'), "expectedDigest": Type.Union([Type.Ref('Digest'), Type.Null()]), "mediaType": Type.String(), "status": Type.Union([Type.Literal('uploading'), Type.Literal('sealed'), Type.Literal('aborted')]), "revision": Type.Ref('Revision') }, { additionalProperties: false }),
  "StagedBlobRef": Type.Object({ "authorityId": Type.Ref('Id'), "blobId": Type.Ref('Id'), "digest": Type.Ref('Digest'), "bytes": Type.Ref('UInt53'), "mediaType": Type.String(), "reservationId": Type.Ref('Id') }, { additionalProperties: false }),
  "PublicRef": Type.Union([Type.Object({ "kind": Type.Literal('session'), "value": Type.Ref('SessionRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('run'), "value": Type.Ref('RunRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('action'), "run": Type.Ref('RunRef'), "actionId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('resource'), "value": Type.Ref('ResourceRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('artifact'), "value": Type.Ref('ArtifactRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('interaction'), "value": Type.Ref('InteractionRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('blob'), "value": Type.Ref('BlobRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('upload'), "value": Type.Ref('UploadSession') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('staged-blob'), "value": Type.Ref('StagedBlobRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('domain'), "value": Type.Ref('DomainObjectRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('event'), "authorityId": Type.Ref('Id'), "eventId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('state'), "value": Type.Ref('DomainReference') }, { additionalProperties: false })]),
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
  "JobDefinition": Type.Object({ "definitionId": Type.Ref('Id'), "revision": Type.Ref('Revision'), "status": Type.Union([Type.Literal('active'), Type.Literal('paused'), Type.Literal('cancelled')]), "schedule": Type.Ref('JobSchedule'), "policy": Type.Ref('JobPolicy'), "target": Type.Ref('JobTarget'), "inputRef": Type.Ref('DataRef'), "budgetAccount": Type.Ref('DomainObjectRef'), "ownerPrincipalRef": Type.Ref('Id'), "nextDueAt": Type.Union([Type.Ref('Timestamp'), Type.Null()]), "protected": Type.Boolean() }, { additionalProperties: false }),
  "JobOccurrence": Type.Object({ "occurrenceId": Type.Ref('Id'), "revision": Type.Ref('Revision'), "definitionId": Type.Ref('Id'), "definitionRevision": Type.Ref('Revision'), "scheduledAt": Type.Ref('Timestamp'), "attempt": Type.Ref('UInt53'), "state": Type.Union([Type.Literal('pending'), Type.Literal('claimed'), Type.Literal('running'), Type.Literal('succeeded'), Type.Literal('failed'), Type.Literal('cancelled')]), "bindingId": Type.Union([Type.Ref('Id'), Type.Null()]), "releaseSetId": Type.Union([Type.Ref('Id'), Type.Null()]), "ticketId": Type.Union([Type.Ref('Id'), Type.Null()]), "runId": Type.Union([Type.Ref('Id'), Type.Null()]), "claim": Type.Union([Type.Ref('LeaseRef'), Type.Null()]), "nextAttemptAt": Type.Union([Type.Ref('Timestamp'), Type.Null()]), "outcomeRef": Type.Union([Type.Ref('ReceiptPointer'), Type.Null()]) }, { additionalProperties: false }),
  "JobEdit": Type.Object({ "schedule": Type.Optional(Type.Ref('JobSchedule')), "policy": Type.Optional(Type.Ref('JobPolicy')), "target": Type.Optional(Type.Ref('JobTarget')), "inputRef": Type.Optional(Type.Ref('DataRef')), "budgetAccount": Type.Optional(Type.Ref('DomainObjectRef')), "status": Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('paused')])) }, { additionalProperties: false }),
  "RetrievalHit": Type.Object({ "ref": Type.Ref('PublicRef'), "score": Type.Number(), "source": Type.Ref('Provenance'), "trust": Type.Union([Type.Literal('system'), Type.Literal('user'), Type.Literal('external'), Type.Literal('derived')]) }, { additionalProperties: false }),
  "BudgetReservation": Type.Object({ "ref": Type.Ref('DomainObjectRef'), "actionId": Type.Ref('Id'), "attemptId": Type.Ref('Id'), "accountRef": Type.Ref('DomainObjectRef'), "parentReservationRef": Type.Union([Type.Ref('DomainObjectRef'), Type.Null()]), "scopeIds": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "unitsByKind": Type.Array(Type.Ref('ExactQuantity'), { maxItems: 10000 }), "held": Type.Union([Type.Ref('Money'), Type.Null()]), "priceVersion": Type.Union([Type.Ref('Id'), Type.Null()]), "status": Type.Union([Type.Literal('held'), Type.Literal('settling'), Type.Literal('settled'), Type.Literal('released'), Type.Literal('unknown')]), "revision": Type.Ref('Revision'), "expiresAt": Type.Ref('Timestamp'), "settledAmount": Type.Union([Type.Ref('Money'), Type.Null()]), "usageRefs": Type.Array(Type.Ref('UsageFactRef'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "UsageMeasurement": Type.Object({ "kind": Type.Union([Type.Literal('reported'), Type.Literal('estimated'), Type.Literal('corrected'), Type.Literal('unknown')]), "quantities": Type.Array(Type.Ref('ExactQuantity'), { maxItems: 10000 }), "actualModel": Type.Union([Type.String(), Type.Null()]), "source": Type.Union([Type.Literal('provider-receipt'), Type.Literal('adapter-counter'), Type.Literal('reported-target'), Type.Literal('estimator')]), "sourceReceipt": Type.Union([Type.Ref('DataRef'), Type.Null()]), "replacesFactIds": Type.Array(Type.Ref('Id'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "UploadRef": Type.Object({ "authorityId": Type.Ref('Id'), "uploadId": Type.Ref('Id'), "reservationId": Type.Ref('Id'), "digest": Type.Ref('Digest'), "bytes": Type.Ref('UInt53'), "mediaType": Type.String(), "status": Type.Literal('sealed') }, { additionalProperties: false }),
  "PageJobOccurrence": Type.Object({ "items": Type.Array(Type.Ref('JobOccurrence'), { maxItems: 10000 }), "snapshot": Type.Ref('Id'), "nextCursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "complete": Type.Boolean() }, { additionalProperties: false }),
  "RetrievalSearchRemoteResult": Type.Object({ "hits": Type.Array(Type.Ref('RetrievalHit'), { maxItems: 10000 }), "usageRefs": Type.Array(Type.Ref('UsageFactRef'), { maxItems: 10000 }), "provenance": Type.Ref('Provenance') }, { additionalProperties: false }),
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
  "InteractionExpireRequest": Type.Object({ "id": Type.Ref('Id'), "expectedVersion": Type.Ref('Revision'), "reason": Type.String() }, { additionalProperties: false }),
  "InteractionCancelRequest": Type.Object({ "id": Type.Ref('Id'), "expectedVersion": Type.Ref('Revision'), "reason": Type.String() }, { additionalProperties: false }),
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
  "JobsRequestCancelResult": Type.Object({ "definition": Type.Ref('JobDefinition'), "cancellationRefs": Type.Array(Type.Ref('ReceiptPointer'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "JobsRequestReserveDetachedRequest": Type.Object({ "sourceActionKey": Type.String(), "inputDigest": Type.Ref('Digest'), "providerBinding": Type.Ref('BindingRef') }, { additionalProperties: false }),
  "JobsClaimOccurrenceRequest": Type.Object({ "id": Type.Ref('Id'), "expectedRevision": Type.Ref('Revision'), "ownerId": Type.Ref('Id'), "until": Type.Ref('Timestamp') }, { additionalProperties: false }),
  "JobsCompleteOccurrenceRequest": Type.Object({ "id": Type.Ref('Id'), "expectedEpoch": Type.Ref('UInt53'), "outcomeRef": Type.Ref('ReceiptPointer') }, { additionalProperties: false }),
  "JobsReserveDetachedRequest": Type.Object({ "mutationId": Type.Ref('Id'), "fingerprint": Type.Ref('Digest'), "sourceAction": Type.Ref('ActionRef'), "sourceRun": Type.Ref('RunRef'), "sourceParentActionId": Type.Union([Type.Ref('Id'), Type.Null()]), "sourceActionKey": Type.String(), "inputDigest": Type.Ref('Digest'), "providerBinding": Type.Ref('BindingRef'), "budgetScope": Type.Ref('DomainObjectRef'), "cancellationOwner": Type.Ref('DomainObjectRef') }, { additionalProperties: false }),
  "JobsAttachDetachedRequest": Type.Object({ "acceptanceId": Type.Ref('Id'), "committedAction": Type.Ref('ActionRef') }, { additionalProperties: false }),
  "JobsCancelDetachedRequest": Type.Object({ "acceptanceId": Type.Ref('Id'), "expectedRevision": Type.Ref('Revision'), "reason": Type.String() }, { additionalProperties: false }),
  "JobsInspectRequest": Type.Object({ "id": Type.Ref('Id'), "cursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "limit": Type.Ref('UInt53') }, { additionalProperties: false }),
  "JobsInspectResult": Type.Object({ "definition": Type.Ref('JobDefinition'), "occurrences": Type.Ref('PageJobOccurrence') }, { additionalProperties: false }),
  "ArtifactsReserveRequest": Type.Object({ "kind": Type.Ref('TypeId'), "schema": Type.Ref('SchemaRef'), "title": Type.String(), "mediaType": Type.String(), "ownerActionRef": Type.Ref('ActionRef') }, { additionalProperties: false }),
  "ArtifactsPublishRequest": Type.Object({ "publicationId": Type.Ref('Id'), "source": Type.Union([Type.Object({ "kind": Type.Literal('upload'), "upload": Type.Ref('UploadRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('blob'), "blob": Type.Ref('BlobRef') }, { additionalProperties: false })]), "expectedRevision": Type.Ref('Revision') }, { additionalProperties: false }),
  "ArtifactsRevokeRequest": Type.Object({ "artifactRef": Type.Ref('ArtifactRef'), "reason": Type.String() }, { additionalProperties: false }),
  "ArtifactsQueryRequest": Type.Object({ "artifactRef": Type.Ref('ArtifactRef') }, { additionalProperties: false }),
  "BlobStageRequest": Type.Object({ "uploadId": Type.Ref('Id'), "size": Type.Ref('UInt53'), "mediaType": Type.String(), "expectedDigest": Type.Union([Type.Ref('Digest'), Type.Null()]) }, { additionalProperties: false }),
  "BlobPromoteRequest": Type.Object({ "upload": Type.Ref('UploadRef'), "expectedDigest": Type.Ref('Digest') }, { additionalProperties: false }),
  "BlobPinRequest": Type.Object({ "stagedBlob": Type.Ref('StagedBlobRef'), "ownerRef": Type.Ref('PublicRef'), "retentionUntil": Type.Union([Type.Ref('Timestamp'), Type.Null()]) }, { additionalProperties: false }),
  "BlobUnpinRequest": Type.Object({ "pinId": Type.Ref('Id'), "expectedRevision": Type.Ref('Revision') }, { additionalProperties: false }),
  "BlobUnpinResult": Type.Object({ "released": Type.Boolean() }, { additionalProperties: false }),
  "BlobGcRequest": Type.Object({ "scopeRef": Type.Ref('ScopeRef'), "dryRun": Type.Boolean(), "cursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "limit": Type.Ref('UInt53') }, { additionalProperties: false }),
  "BlobGcResult": Type.Object({ "eligibleRefs": Type.Array(Type.Ref('PublicRef'), { maxItems: 10000 }), "deletedRefs": Type.Array(Type.Ref('PublicRef'), { maxItems: 10000 }), "nextCursor": Type.Union([Type.Ref('Cursor'), Type.Null()]) }, { additionalProperties: false }),
  "BlobInspectRequest": Type.Object({ "ref": Type.Ref('PublicRef') }, { additionalProperties: false }),
  "BlobInspectResult": Type.Object({ "status": Type.Union([Type.Literal('uploading'), Type.Literal('sealed'), Type.Literal('staged'), Type.Literal('pinned'), Type.Literal('deleted')]), "bytes": Type.Ref('UInt53'), "digest": Type.Union([Type.Ref('Digest'), Type.Null()]), "ownerRefs": Type.Array(Type.Ref('PublicRef'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "BudgetReserveRequest": Type.Object({ "actionRef": Type.Ref('ActionRef'), "attemptId": Type.Ref('Id'), "accountRef": Type.Ref('DomainObjectRef'), "unitsByKind": Type.Array(Type.Ref('ExactQuantity'), { maxItems: 10000 }), "maxCost": Type.Union([Type.Ref('Money'), Type.Null()]), "priceVersion": Type.Union([Type.Ref('Id'), Type.Null()]), "parentReservationRef": Type.Union([Type.Ref('DomainObjectRef'), Type.Null()]) }, { additionalProperties: false }),
  "BudgetReserveResult": Type.Object({ "reservation": Type.Ref('BudgetReservation'), "remaining": Type.Union([Type.Ref('Money'), Type.Null()]) }, { additionalProperties: false }),
  "BudgetSettleRequest": Type.Object({ "reservationRef": Type.Ref('DomainObjectRef'), "usageRefs": Type.Array(Type.Ref('UsageFactRef'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "BudgetSettleResult": Type.Object({ "reservation": Type.Ref('BudgetReservation'), "balance": Type.Union([Type.Ref('Money'), Type.Null()]) }, { additionalProperties: false }),
  "BudgetReconcileRequest": Type.Object({ "reservationRef": Type.Ref('DomainObjectRef'), "evidenceRef": Type.Ref('DataRef') }, { additionalProperties: false }),
  "BudgetReconcileResult": Type.Object({ "reservation": Type.Ref('BudgetReservation'), "balance": Type.Union([Type.Ref('Money'), Type.Null()]) }, { additionalProperties: false }),
  "BudgetReserveQuotaRequest": Type.Object({ "actionRef": Type.Ref('ActionRef'), "attemptId": Type.Ref('Id'), "dimensions": Type.Array(Type.Object({ "name": Type.Union([Type.Literal('parallel-action'), Type.Literal('live-agent')]), "amount": Type.Ref('UInt53') }, { additionalProperties: false }), { maxItems: 10000 }) }, { additionalProperties: false }),
  "BudgetReleaseQuotaRequest": Type.Object({ "reservationRef": Type.Ref('DomainObjectRef'), "completionEvidence": Type.Ref('DataRef') }, { additionalProperties: false }),
  "UsageRecordRequest": Type.Object({ "attemptRef": Type.Ref('AttemptRef'), "externalReceiptRef": Type.Union([Type.Ref('DataRef'), Type.Null()]), "measurement": Type.Ref('UsageMeasurement') }, { additionalProperties: false }),
  "UsageRecordResult": Type.Object({ "factRefs": Type.Array(Type.Ref('UsageFactRef'), { maxItems: 10000 }), "revision": Type.Ref('Revision') }, { additionalProperties: false }),
  "UsageQueryRequest": Type.Object({ "scopeRef": Type.Ref('ScopeRef'), "cursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "limit": Type.Ref('UInt53') }, { additionalProperties: false }),
  "PageUsageFact": Type.Object({ "items": Type.Array(Type.Ref('UsageFact'), { maxItems: 10000 }), "snapshot": Type.Ref('Id'), "nextCursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "complete": Type.Boolean() }, { additionalProperties: false }),
  "UsageQueryResult": Type.Ref('PageUsageFact'),
  "PricingQuoteRequest": Type.Object({ "usageUnits": Type.Array(Type.Ref('ExactQuantity'), { maxItems: 10000 }), "model": Type.String(), "region": Type.Union([Type.String(), Type.Null()]), "priceVersion": Type.Ref('Id'), "currency": Type.String() }, { additionalProperties: false }),
  "BillingPostRequest": Type.Object({ "usageRefs": Type.Array(Type.Ref('UsageFactRef'), { maxItems: 10000 }), "quoteRef": Type.Ref('DataRef'), "accountRef": Type.Ref('DomainObjectRef'), "chargeKey": Type.Ref('Id') }, { additionalProperties: false }),
})

export const Id = RuntimePublic12.Import('Id')
export type Id = Static<typeof Id>
export const UInt53 = RuntimePublic12.Import('UInt53')
export type UInt53 = Static<typeof UInt53>
export const Timestamp = RuntimePublic12.Import('Timestamp')
export type Timestamp = Static<typeof Timestamp>
export const TypeId = RuntimePublic12.Import('TypeId')
export type TypeId = Static<typeof TypeId>
export const Digest = RuntimePublic12.Import('Digest')
export type Digest = Static<typeof Digest>
export const SchemaRef = RuntimePublic12.Import('SchemaRef')
export type SchemaRef = Static<typeof SchemaRef>
export const BlobRef = RuntimePublic12.Import('BlobRef')
export type BlobRef = Static<typeof BlobRef>
export const DataRef = RuntimePublic12.Import('DataRef')
export type DataRef = Static<typeof DataRef>
export const ActionRef = RuntimePublic12.Import('ActionRef')
export type ActionRef = Static<typeof ActionRef>
export const ExternalRequestRef = RuntimePublic12.Import('ExternalRequestRef')
export type ExternalRequestRef = Static<typeof ExternalRequestRef>
export const RetentionRef = RuntimePublic12.Import('RetentionRef')
export type RetentionRef = Static<typeof RetentionRef>
export const BindingRef = RuntimePublic12.Import('BindingRef')
export type BindingRef = Static<typeof BindingRef>
export const Provenance = RuntimePublic12.Import('Provenance')
export type Provenance = Static<typeof Provenance>
export const StateAuthorityRef = RuntimePublic12.Import('StateAuthorityRef')
export type StateAuthorityRef = Static<typeof StateAuthorityRef>
export const HookEventName = RuntimePublic12.Import('HookEventName')
export type HookEventName = Static<typeof HookEventName>
export const HookResultSet = RuntimePublic12.Import('HookResultSet')
export type HookResultSet = Static<typeof HookResultSet>
export const ScopeRef = RuntimePublic12.Import('ScopeRef')
export type ScopeRef = Static<typeof ScopeRef>
export const DomainReference = RuntimePublic12.Import('DomainReference')
export type DomainReference = Static<typeof DomainReference>
export const RequestIdentity = RuntimePublic12.Import('RequestIdentity')
export type RequestIdentity = Static<typeof RequestIdentity>
export const ConversationAdmission = RuntimePublic12.Import('ConversationAdmission')
export type ConversationAdmission = Static<typeof ConversationAdmission>
export const Money = RuntimePublic12.Import('Money')
export type Money = Static<typeof Money>
export const UsageFact = RuntimePublic12.Import('UsageFact')
export type UsageFact = Static<typeof UsageFact>
export const IsolationMode = RuntimePublic12.Import('IsolationMode')
export type IsolationMode = Static<typeof IsolationMode>
export const ConfigValue = RuntimePublic12.Import('ConfigValue')
export type ConfigValue = Static<typeof ConfigValue>
export const ToolPolicySnapshot = RuntimePublic12.Import('ToolPolicySnapshot')
export type ToolPolicySnapshot = Static<typeof ToolPolicySnapshot>
export const ResourceRef = RuntimePublic12.Import('ResourceRef')
export type ResourceRef = Static<typeof ResourceRef>
export const ArtifactRef = RuntimePublic12.Import('ArtifactRef')
export type ArtifactRef = Static<typeof ArtifactRef>
export const Revision = RuntimePublic12.Import('Revision')
export type Revision = Static<typeof Revision>
export const DomainObjectRef = RuntimePublic12.Import('DomainObjectRef')
export type DomainObjectRef = Static<typeof DomainObjectRef>
export const ModelFeatures = RuntimePublic12.Import('ModelFeatures')
export type ModelFeatures = Static<typeof ModelFeatures>
export const SecretConsumerBinding = RuntimePublic12.Import('SecretConsumerBinding')
export type SecretConsumerBinding = Static<typeof SecretConsumerBinding>
export const ModelRouteSnapshot = RuntimePublic12.Import('ModelRouteSnapshot')
export type ModelRouteSnapshot = Static<typeof ModelRouteSnapshot>
export const TaintSnapshot = RuntimePublic12.Import('TaintSnapshot')
export type TaintSnapshot = Static<typeof TaintSnapshot>
export const SessionRef = RuntimePublic12.Import('SessionRef')
export type SessionRef = Static<typeof SessionRef>
export const RunRef = RuntimePublic12.Import('RunRef')
export type RunRef = Static<typeof RunRef>
export const InteractionRef = RuntimePublic12.Import('InteractionRef')
export type InteractionRef = Static<typeof InteractionRef>
export const UploadSession = RuntimePublic12.Import('UploadSession')
export type UploadSession = Static<typeof UploadSession>
export const StagedBlobRef = RuntimePublic12.Import('StagedBlobRef')
export type StagedBlobRef = Static<typeof StagedBlobRef>
export const PublicRef = RuntimePublic12.Import('PublicRef')
export type PublicRef = Static<typeof PublicRef>
export const ApprovalGrantEvidence = RuntimePublic12.Import('ApprovalGrantEvidence')
export type ApprovalGrantEvidence = Static<typeof ApprovalGrantEvidence>
export const ReceiptPointer = RuntimePublic12.Import('ReceiptPointer')
export type ReceiptPointer = Static<typeof ReceiptPointer>
export const TrustedPolicyFacts = RuntimePublic12.Import('TrustedPolicyFacts')
export type TrustedPolicyFacts = Static<typeof TrustedPolicyFacts>
export const FilePath = RuntimePublic12.Import('FilePath')
export type FilePath = Static<typeof FilePath>
export const FileCheckpointProof = RuntimePublic12.Import('FileCheckpointProof')
export type FileCheckpointProof = Static<typeof FileCheckpointProof>
export const ExactQuantity = RuntimePublic12.Import('ExactQuantity')
export type ExactQuantity = Static<typeof ExactQuantity>
export const SessionControlBoundary = RuntimePublic12.Import('SessionControlBoundary')
export type SessionControlBoundary = Static<typeof SessionControlBoundary>
export const SessionParameterRevision = RuntimePublic12.Import('SessionParameterRevision')
export type SessionParameterRevision = Static<typeof SessionParameterRevision>
export const ResourceLimits = RuntimePublic12.Import('ResourceLimits')
export type ResourceLimits = Static<typeof ResourceLimits>
export const RunState = RuntimePublic12.Import('RunState')
export type RunState = Static<typeof RunState>
export const UsageFactRef = RuntimePublic12.Import('UsageFactRef')
export type UsageFactRef = Static<typeof UsageFactRef>
export const FsPolicySnapshot = RuntimePublic12.Import('FsPolicySnapshot')
export type FsPolicySnapshot = Static<typeof FsPolicySnapshot>
export const LeaseRef = RuntimePublic12.Import('LeaseRef')
export type LeaseRef = Static<typeof LeaseRef>
export const MountRef = RuntimePublic12.Import('MountRef')
export type MountRef = Static<typeof MountRef>
export const FsEnforcementProof = RuntimePublic12.Import('FsEnforcementProof')
export type FsEnforcementProof = Static<typeof FsEnforcementProof>
export const AttemptRef = RuntimePublic12.Import('AttemptRef')
export type AttemptRef = Static<typeof AttemptRef>
export const Cursor = RuntimePublic12.Import('Cursor')
export type Cursor = Static<typeof Cursor>
export const AttemptState = RuntimePublic12.Import('AttemptState')
export type AttemptState = Static<typeof AttemptState>
export const BytesRef = RuntimePublic12.Import('BytesRef')
export type BytesRef = Static<typeof BytesRef>
export const VersionPrecondition = RuntimePublic12.Import('VersionPrecondition')
export type VersionPrecondition = Static<typeof VersionPrecondition>
export const FileRange = RuntimePublic12.Import('FileRange')
export type FileRange = Static<typeof FileRange>
export const FileEntry = RuntimePublic12.Import('FileEntry')
export type FileEntry = Static<typeof FileEntry>
export const SandboxRef = RuntimePublic12.Import('SandboxRef')
export type SandboxRef = Static<typeof SandboxRef>
export const SandboxState = RuntimePublic12.Import('SandboxState')
export type SandboxState = Static<typeof SandboxState>
export const ExecutionRef = RuntimePublic12.Import('ExecutionRef')
export type ExecutionRef = Static<typeof ExecutionRef>
export const NetworkTarget = RuntimePublic12.Import('NetworkTarget')
export type NetworkTarget = Static<typeof NetworkTarget>
export const NewRunSpec = RuntimePublic12.Import('NewRunSpec')
export type NewRunSpec = Static<typeof NewRunSpec>
export const ScheduleTarget = RuntimePublic12.Import('ScheduleTarget')
export type ScheduleTarget = Static<typeof ScheduleTarget>
export const SchedulerDelivery = RuntimePublic12.Import('SchedulerDelivery')
export type SchedulerDelivery = Static<typeof SchedulerDelivery>
export const JobTarget = RuntimePublic12.Import('JobTarget')
export type JobTarget = Static<typeof JobTarget>
export const JobSchedule = RuntimePublic12.Import('JobSchedule')
export type JobSchedule = Static<typeof JobSchedule>
export const JobPolicy = RuntimePublic12.Import('JobPolicy')
export type JobPolicy = Static<typeof JobPolicy>
export const JobDefinition = RuntimePublic12.Import('JobDefinition')
export type JobDefinition = Static<typeof JobDefinition>
export const JobOccurrence = RuntimePublic12.Import('JobOccurrence')
export type JobOccurrence = Static<typeof JobOccurrence>
export const JobEdit = RuntimePublic12.Import('JobEdit')
export type JobEdit = Static<typeof JobEdit>
export const RetrievalHit = RuntimePublic12.Import('RetrievalHit')
export type RetrievalHit = Static<typeof RetrievalHit>
export const BudgetReservation = RuntimePublic12.Import('BudgetReservation')
export type BudgetReservation = Static<typeof BudgetReservation>
export const UsageMeasurement = RuntimePublic12.Import('UsageMeasurement')
export type UsageMeasurement = Static<typeof UsageMeasurement>
export const UploadRef = RuntimePublic12.Import('UploadRef')
export type UploadRef = Static<typeof UploadRef>
export const PageJobOccurrence = RuntimePublic12.Import('PageJobOccurrence')
export type PageJobOccurrence = Page<JobOccurrence>
export const RetrievalSearchRemoteResult = RuntimePublic12.Import('RetrievalSearchRemoteResult')
export type RetrievalSearchRemoteResult = Static<typeof RetrievalSearchRemoteResult>
export const EmbeddingEncodeRequest = RuntimePublic12.Import('EmbeddingEncodeRequest')
export type EmbeddingEncodeRequest = Static<typeof EmbeddingEncodeRequest>
export const EmbeddingEncodeResult = RuntimePublic12.Import('EmbeddingEncodeResult')
export type EmbeddingEncodeResult = Static<typeof EmbeddingEncodeResult>
export const IdentityAuthenticateRequest = RuntimePublic12.Import('IdentityAuthenticateRequest')
export type IdentityAuthenticateRequest = Static<typeof IdentityAuthenticateRequest>
export const IdentityResolveRequest = RuntimePublic12.Import('IdentityResolveRequest')
export type IdentityResolveRequest = Static<typeof IdentityResolveRequest>
export const PolicyEvaluateRequest = RuntimePublic12.Import('PolicyEvaluateRequest')
export type PolicyEvaluateRequest = Static<typeof PolicyEvaluateRequest>
export const EffectsDispatchRequest = RuntimePublic12.Import('EffectsDispatchRequest')
export type EffectsDispatchRequest = Static<typeof EffectsDispatchRequest>
export const EffectsDispatchResult = RuntimePublic12.Import('EffectsDispatchResult')
export type EffectsDispatchResult = Static<typeof EffectsDispatchResult>
export const EffectsReconcileRequest = RuntimePublic12.Import('EffectsReconcileRequest')
export type EffectsReconcileRequest = Static<typeof EffectsReconcileRequest>
export const EffectsReconcileResult = RuntimePublic12.Import('EffectsReconcileResult')
export type EffectsReconcileResult = Static<typeof EffectsReconcileResult>
export const WorkspaceAcquireRequest = RuntimePublic12.Import('WorkspaceAcquireRequest')
export type WorkspaceAcquireRequest = Static<typeof WorkspaceAcquireRequest>
export const WorkspaceAcquireResult = RuntimePublic12.Import('WorkspaceAcquireResult')
export type WorkspaceAcquireResult = Static<typeof WorkspaceAcquireResult>
export const WorkspaceReleaseRequest = RuntimePublic12.Import('WorkspaceReleaseRequest')
export type WorkspaceReleaseRequest = Static<typeof WorkspaceReleaseRequest>
export const WorkspaceReleaseResult = RuntimePublic12.Import('WorkspaceReleaseResult')
export type WorkspaceReleaseResult = Static<typeof WorkspaceReleaseResult>
export const FilesReadRequest = RuntimePublic12.Import('FilesReadRequest')
export type FilesReadRequest = Static<typeof FilesReadRequest>
export const FilesReadResult = RuntimePublic12.Import('FilesReadResult')
export type FilesReadResult = Static<typeof FilesReadResult>
export const FilesWriteRequest = RuntimePublic12.Import('FilesWriteRequest')
export type FilesWriteRequest = Static<typeof FilesWriteRequest>
export const FilesWriteResult = RuntimePublic12.Import('FilesWriteResult')
export type FilesWriteResult = Static<typeof FilesWriteResult>
export const FilesListRequest = RuntimePublic12.Import('FilesListRequest')
export type FilesListRequest = Static<typeof FilesListRequest>
export const PageFileEntry = RuntimePublic12.Import('PageFileEntry')
export type PageFileEntry = Page<FileEntry>
export const FilesListResult = RuntimePublic12.Import('FilesListResult')
export type FilesListResult = PageFileEntry
export const FilesStatRequest = RuntimePublic12.Import('FilesStatRequest')
export type FilesStatRequest = Static<typeof FilesStatRequest>
export const SandboxCreateRequest = RuntimePublic12.Import('SandboxCreateRequest')
export type SandboxCreateRequest = Static<typeof SandboxCreateRequest>
export const SandboxCreateResult = RuntimePublic12.Import('SandboxCreateResult')
export type SandboxCreateResult = Static<typeof SandboxCreateResult>
export const SandboxStopRequest = RuntimePublic12.Import('SandboxStopRequest')
export type SandboxStopRequest = Static<typeof SandboxStopRequest>
export const SandboxStopResult = RuntimePublic12.Import('SandboxStopResult')
export type SandboxStopResult = Static<typeof SandboxStopResult>
export const SandboxInspectRequest = RuntimePublic12.Import('SandboxInspectRequest')
export type SandboxInspectRequest = Static<typeof SandboxInspectRequest>
export const SandboxInspectResult = RuntimePublic12.Import('SandboxInspectResult')
export type SandboxInspectResult = Static<typeof SandboxInspectResult>
export const ExecReconcileRequest = RuntimePublic12.Import('ExecReconcileRequest')
export type ExecReconcileRequest = Static<typeof ExecReconcileRequest>
export const NetworkRequestResult = RuntimePublic12.Import('NetworkRequestResult')
export type NetworkRequestResult = Static<typeof NetworkRequestResult>
export const SecretsResolveRequest = RuntimePublic12.Import('SecretsResolveRequest')
export type SecretsResolveRequest = Static<typeof SecretsResolveRequest>
export const SecretsRotateRequest = RuntimePublic12.Import('SecretsRotateRequest')
export type SecretsRotateRequest = Static<typeof SecretsRotateRequest>
export const SecretsRotateResult = RuntimePublic12.Import('SecretsRotateResult')
export type SecretsRotateResult = Static<typeof SecretsRotateResult>
export const SecretsRevokeRequest = RuntimePublic12.Import('SecretsRevokeRequest')
export type SecretsRevokeRequest = Static<typeof SecretsRevokeRequest>
export const SecretsRevokeResult = RuntimePublic12.Import('SecretsRevokeResult')
export type SecretsRevokeResult = Static<typeof SecretsRevokeResult>
export const SecretsAcceptCallbackResult = RuntimePublic12.Import('SecretsAcceptCallbackResult')
export type SecretsAcceptCallbackResult = Static<typeof SecretsAcceptCallbackResult>
export const InteractionRespondRequest = RuntimePublic12.Import('InteractionRespondRequest')
export type InteractionRespondRequest = Static<typeof InteractionRespondRequest>
export const InteractionExpireRequest = RuntimePublic12.Import('InteractionExpireRequest')
export type InteractionExpireRequest = Static<typeof InteractionExpireRequest>
export const InteractionCancelRequest = RuntimePublic12.Import('InteractionCancelRequest')
export type InteractionCancelRequest = Static<typeof InteractionCancelRequest>
export const InteractionReadRequest = RuntimePublic12.Import('InteractionReadRequest')
export type InteractionReadRequest = Static<typeof InteractionReadRequest>
export const RecoveryInspectRequest = RuntimePublic12.Import('RecoveryInspectRequest')
export type RecoveryInspectRequest = Static<typeof RecoveryInspectRequest>
export const RecoveryInspectResult = RuntimePublic12.Import('RecoveryInspectResult')
export type RecoveryInspectResult = Static<typeof RecoveryInspectResult>
export const RecoveryRestoreRequest = RuntimePublic12.Import('RecoveryRestoreRequest')
export type RecoveryRestoreRequest = Static<typeof RecoveryRestoreRequest>
export const RecoveryRestoreResult = RuntimePublic12.Import('RecoveryRestoreResult')
export type RecoveryRestoreResult = Static<typeof RecoveryRestoreResult>
export const SupervisorAdmitResult = RuntimePublic12.Import('SupervisorAdmitResult')
export type SupervisorAdmitResult = Static<typeof SupervisorAdmitResult>
export const SupervisorSignalRequest = RuntimePublic12.Import('SupervisorSignalRequest')
export type SupervisorSignalRequest = Static<typeof SupervisorSignalRequest>
export const SupervisorSignalResult = RuntimePublic12.Import('SupervisorSignalResult')
export type SupervisorSignalResult = Static<typeof SupervisorSignalResult>
export const SupervisorCancelRequest = RuntimePublic12.Import('SupervisorCancelRequest')
export type SupervisorCancelRequest = Static<typeof SupervisorCancelRequest>
export const SupervisorCancelResult = RuntimePublic12.Import('SupervisorCancelResult')
export type SupervisorCancelResult = Static<typeof SupervisorCancelResult>
export const SupervisorSessionParametersRequest = RuntimePublic12.Import('SupervisorSessionParametersRequest')
export type SupervisorSessionParametersRequest = Static<typeof SupervisorSessionParametersRequest>
export const SupervisorSessionParametersResult = RuntimePublic12.Import('SupervisorSessionParametersResult')
export type SupervisorSessionParametersResult = Static<typeof SupervisorSessionParametersResult>
export const SupervisorInspectRequest = RuntimePublic12.Import('SupervisorInspectRequest')
export type SupervisorInspectRequest = Static<typeof SupervisorInspectRequest>
export const SupervisorInspectResult = RuntimePublic12.Import('SupervisorInspectResult')
export type SupervisorInspectResult = Static<typeof SupervisorInspectResult>
export const SchedulerEnqueueRequest = RuntimePublic12.Import('SchedulerEnqueueRequest')
export type SchedulerEnqueueRequest = Static<typeof SchedulerEnqueueRequest>
export const SchedulerEnqueueResult = RuntimePublic12.Import('SchedulerEnqueueResult')
export type SchedulerEnqueueResult = Static<typeof SchedulerEnqueueResult>
export const SchedulerClaimRequest = RuntimePublic12.Import('SchedulerClaimRequest')
export type SchedulerClaimRequest = Static<typeof SchedulerClaimRequest>
export const SchedulerClaimResult = RuntimePublic12.Import('SchedulerClaimResult')
export type SchedulerClaimResult = Static<typeof SchedulerClaimResult>
export const SchedulerAckRequest = RuntimePublic12.Import('SchedulerAckRequest')
export type SchedulerAckRequest = Static<typeof SchedulerAckRequest>
export const SchedulerAckResult = RuntimePublic12.Import('SchedulerAckResult')
export type SchedulerAckResult = Static<typeof SchedulerAckResult>
export const AgentsSpawnResult = RuntimePublic12.Import('AgentsSpawnResult')
export type AgentsSpawnResult = Static<typeof AgentsSpawnResult>
export const AgentsSendRequest = RuntimePublic12.Import('AgentsSendRequest')
export type AgentsSendRequest = Static<typeof AgentsSendRequest>
export const AgentsSendResult = RuntimePublic12.Import('AgentsSendResult')
export type AgentsSendResult = Static<typeof AgentsSendResult>
export const AgentsResumeRequest = RuntimePublic12.Import('AgentsResumeRequest')
export type AgentsResumeRequest = Static<typeof AgentsResumeRequest>
export const AgentsResumeResult = RuntimePublic12.Import('AgentsResumeResult')
export type AgentsResumeResult = Static<typeof AgentsResumeResult>
export const AgentsCancelRequest = RuntimePublic12.Import('AgentsCancelRequest')
export type AgentsCancelRequest = Static<typeof AgentsCancelRequest>
export const AgentsCancelResult = RuntimePublic12.Import('AgentsCancelResult')
export type AgentsCancelResult = Static<typeof AgentsCancelResult>
export const AgentsRetireRequest = RuntimePublic12.Import('AgentsRetireRequest')
export type AgentsRetireRequest = Static<typeof AgentsRetireRequest>
export const AgentsRetireResult = RuntimePublic12.Import('AgentsRetireResult')
export type AgentsRetireResult = Static<typeof AgentsRetireResult>
export const AgentsInspectRequest = RuntimePublic12.Import('AgentsInspectRequest')
export type AgentsInspectRequest = Static<typeof AgentsInspectRequest>
export const JobsRequestCreateRequest = RuntimePublic12.Import('JobsRequestCreateRequest')
export type JobsRequestCreateRequest = Static<typeof JobsRequestCreateRequest>
export const JobsRequestUpdateRequest = RuntimePublic12.Import('JobsRequestUpdateRequest')
export type JobsRequestUpdateRequest = Static<typeof JobsRequestUpdateRequest>
export const JobsRequestCancelRequest = RuntimePublic12.Import('JobsRequestCancelRequest')
export type JobsRequestCancelRequest = Static<typeof JobsRequestCancelRequest>
export const JobsRequestCancelResult = RuntimePublic12.Import('JobsRequestCancelResult')
export type JobsRequestCancelResult = Static<typeof JobsRequestCancelResult>
export const JobsRequestReserveDetachedRequest = RuntimePublic12.Import('JobsRequestReserveDetachedRequest')
export type JobsRequestReserveDetachedRequest = Static<typeof JobsRequestReserveDetachedRequest>
export const JobsClaimOccurrenceRequest = RuntimePublic12.Import('JobsClaimOccurrenceRequest')
export type JobsClaimOccurrenceRequest = Static<typeof JobsClaimOccurrenceRequest>
export const JobsCompleteOccurrenceRequest = RuntimePublic12.Import('JobsCompleteOccurrenceRequest')
export type JobsCompleteOccurrenceRequest = Static<typeof JobsCompleteOccurrenceRequest>
export const JobsReserveDetachedRequest = RuntimePublic12.Import('JobsReserveDetachedRequest')
export type JobsReserveDetachedRequest = Static<typeof JobsReserveDetachedRequest>
export const JobsAttachDetachedRequest = RuntimePublic12.Import('JobsAttachDetachedRequest')
export type JobsAttachDetachedRequest = Static<typeof JobsAttachDetachedRequest>
export const JobsCancelDetachedRequest = RuntimePublic12.Import('JobsCancelDetachedRequest')
export type JobsCancelDetachedRequest = Static<typeof JobsCancelDetachedRequest>
export const JobsInspectRequest = RuntimePublic12.Import('JobsInspectRequest')
export type JobsInspectRequest = Static<typeof JobsInspectRequest>
export const JobsInspectResult = RuntimePublic12.Import('JobsInspectResult')
export type JobsInspectResult = Omit<Static<typeof JobsInspectResult>, "occurrences"> & { "occurrences": PageJobOccurrence }
export const ArtifactsReserveRequest = RuntimePublic12.Import('ArtifactsReserveRequest')
export type ArtifactsReserveRequest = Static<typeof ArtifactsReserveRequest>
export const ArtifactsPublishRequest = RuntimePublic12.Import('ArtifactsPublishRequest')
export type ArtifactsPublishRequest = Static<typeof ArtifactsPublishRequest>
export const ArtifactsRevokeRequest = RuntimePublic12.Import('ArtifactsRevokeRequest')
export type ArtifactsRevokeRequest = Static<typeof ArtifactsRevokeRequest>
export const ArtifactsQueryRequest = RuntimePublic12.Import('ArtifactsQueryRequest')
export type ArtifactsQueryRequest = Static<typeof ArtifactsQueryRequest>
export const BlobStageRequest = RuntimePublic12.Import('BlobStageRequest')
export type BlobStageRequest = Static<typeof BlobStageRequest>
export const BlobPromoteRequest = RuntimePublic12.Import('BlobPromoteRequest')
export type BlobPromoteRequest = Static<typeof BlobPromoteRequest>
export const BlobPinRequest = RuntimePublic12.Import('BlobPinRequest')
export type BlobPinRequest = Static<typeof BlobPinRequest>
export const BlobUnpinRequest = RuntimePublic12.Import('BlobUnpinRequest')
export type BlobUnpinRequest = Static<typeof BlobUnpinRequest>
export const BlobUnpinResult = RuntimePublic12.Import('BlobUnpinResult')
export type BlobUnpinResult = Static<typeof BlobUnpinResult>
export const BlobGcRequest = RuntimePublic12.Import('BlobGcRequest')
export type BlobGcRequest = Static<typeof BlobGcRequest>
export const BlobGcResult = RuntimePublic12.Import('BlobGcResult')
export type BlobGcResult = Static<typeof BlobGcResult>
export const BlobInspectRequest = RuntimePublic12.Import('BlobInspectRequest')
export type BlobInspectRequest = Static<typeof BlobInspectRequest>
export const BlobInspectResult = RuntimePublic12.Import('BlobInspectResult')
export type BlobInspectResult = Static<typeof BlobInspectResult>
export const BudgetReserveRequest = RuntimePublic12.Import('BudgetReserveRequest')
export type BudgetReserveRequest = Static<typeof BudgetReserveRequest>
export const BudgetReserveResult = RuntimePublic12.Import('BudgetReserveResult')
export type BudgetReserveResult = Static<typeof BudgetReserveResult>
export const BudgetSettleRequest = RuntimePublic12.Import('BudgetSettleRequest')
export type BudgetSettleRequest = Static<typeof BudgetSettleRequest>
export const BudgetSettleResult = RuntimePublic12.Import('BudgetSettleResult')
export type BudgetSettleResult = Static<typeof BudgetSettleResult>
export const BudgetReconcileRequest = RuntimePublic12.Import('BudgetReconcileRequest')
export type BudgetReconcileRequest = Static<typeof BudgetReconcileRequest>
export const BudgetReconcileResult = RuntimePublic12.Import('BudgetReconcileResult')
export type BudgetReconcileResult = Static<typeof BudgetReconcileResult>
export const BudgetReserveQuotaRequest = RuntimePublic12.Import('BudgetReserveQuotaRequest')
export type BudgetReserveQuotaRequest = Static<typeof BudgetReserveQuotaRequest>
export const BudgetReleaseQuotaRequest = RuntimePublic12.Import('BudgetReleaseQuotaRequest')
export type BudgetReleaseQuotaRequest = Static<typeof BudgetReleaseQuotaRequest>
export const UsageRecordRequest = RuntimePublic12.Import('UsageRecordRequest')
export type UsageRecordRequest = Static<typeof UsageRecordRequest>
export const UsageRecordResult = RuntimePublic12.Import('UsageRecordResult')
export type UsageRecordResult = Static<typeof UsageRecordResult>
export const UsageQueryRequest = RuntimePublic12.Import('UsageQueryRequest')
export type UsageQueryRequest = Static<typeof UsageQueryRequest>
export const PageUsageFact = RuntimePublic12.Import('PageUsageFact')
export type PageUsageFact = Page<UsageFact>
export const UsageQueryResult = RuntimePublic12.Import('UsageQueryResult')
export type UsageQueryResult = PageUsageFact
export const PricingQuoteRequest = RuntimePublic12.Import('PricingQuoteRequest')
export type PricingQuoteRequest = Static<typeof PricingQuoteRequest>
export const BillingPostRequest = RuntimePublic12.Import('BillingPostRequest')
export type BillingPostRequest = Static<typeof BillingPostRequest>
