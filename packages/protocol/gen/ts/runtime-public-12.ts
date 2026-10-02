import type { Page } from './runtime-public.js'
// generated from schema by tools/gen.ts — do not edit
import { Type, type Static } from '@sinclair/typebox'
import { FormatRegistry } from '@sinclair/typebox'

if (!FormatRegistry.Has('date-time')) FormatRegistry.Set('date-time', (value) => { const parts = value.split(/t/i); if (parts.length !== 2) return false; const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(parts[0] ?? ''); const time = /^(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)(z|([+-])(\d{2}):(\d{2}))$/i.exec(parts[1] ?? ''); if (!date || !time) return false; const year = Number(date[1]), month = Number(date[2]), day = Number(date[3]); const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0); const days = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; if (month < 1 || month > 12 || day < 1 || day > (days[month] ?? 0)) return false; const hour = Number(time[1]), minute = Number(time[2]), second = Number(time[3]); const offsetHour = Number(time[6] || 0), offsetMinute = Number(time[7] || 0); if (hour > 23 || minute > 59 || offsetHour > 23 || offsetMinute > 59) return false; if (second < 60) return true; const sign = time[5] === '-' ? -1 : 1; const utcMinute = minute - offsetMinute * sign; const utcHour = hour - offsetHour * sign - (utcMinute < 0 ? 1 : 0); return (utcHour === 23 || utcHour === -1) && (utcMinute === 59 || utcMinute === -1) && second < 61; })

export const JsonValue = Type.Recursive((This) => Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String(), Type.Array(This, { minItems: 0, maxItems: 10000 }), Type.Record(Type.String(), This)]))
export type JsonValue = Static<typeof JsonValue>

export const Externalsession_v1_JsonValue = Type.Recursive((This) => Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String(), Type.Array(This), Type.Record(Type.String(), This)]))
export type Externalsession_v1_JsonValue = Static<typeof Externalsession_v1_JsonValue>

export const RuntimePublic12 = Type.Module({
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
  "ApprovalRequest": Type.Object({ "kind": Type.Literal('approval'), "title": Type.String(), "body": Type.String(), "approvalHookResults": Type.Optional(Type.Ref('HookResultSet')), "allowedGrantScopes": Type.Optional(Type.Array(Type.Union([Type.Literal('once'), Type.Literal('session'), Type.Literal('permanent')]), { maxItems: 10000 })), "actionRef": Type.String(), "inputDigest": Type.Ref('Digest'), "policyDecisionRef": Type.String(), "scope": Type.Ref('ScopeRef'), "allowedResponders": Type.Array(Type.String(), { maxItems: 10000 }), "expiresAt": Type.Ref('Timestamp'), "idempotencyKey": Type.String(), "risk": Type.Union([Type.Literal('destructive'), Type.Literal('always'), Type.Literal('budget'), Type.Literal('unknown')]), "intentDigest": Type.Ref('Digest') }, { additionalProperties: false }),
  "DomainReference": Type.Object({ "authorityId": Type.Ref('Id'), "recordId": Type.Ref('Id'), "recordRevision": Type.Ref('UInt53'), "schema": Type.Ref('SchemaRef'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "CapabilityRequirement": Type.Object({ "capability": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "resourceTypes": Type.Array(Type.Ref('TypeId'), { minItems: 0, maxItems: 64 }), "operations": Type.Array(Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), { minItems: 0, maxItems: 64 }) }, { additionalProperties: false }),
  "ToolPolicyDefaults": Type.Object({ "isReadOnly": Type.Boolean(), "isDestructive": Type.Boolean(), "replay": Type.Union([Type.Literal('safe'), Type.Literal('never'), Type.Literal('idempotent')]), "requiresApproval": Type.Union([Type.Literal('never'), Type.Literal('destructive'), Type.Literal('always')]), "approvalScopes": Type.Array(Type.String(), { maxItems: 16 }) }, { additionalProperties: false }),
  "ToolExecutionConstraints": Type.Object({ "concurrency": Type.Union([Type.Literal('parallel'), Type.Literal('batch-barrier')]), "isOpenWorld": Type.Boolean(), "costHint": Type.Union([Type.Ref('DataRef'), Type.Null()]), "deferLoading": Type.Boolean(), "requiredModelInput": Type.Array(Type.Union([Type.Literal('text'), Type.Literal('image'), Type.Literal('audio'), Type.Literal('video')]), { maxItems: 10000 }) }, { additionalProperties: false }),
  "ResourceRef": Type.Object({ "resourceId": Type.Ref('Id'), "version": Type.String(), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "ToolDefinition": Type.Object({ "resource": Type.Ref('ResourceRef'), "executor": Type.Ref('BindingRef'), "name": Type.String(), "inputSchema": Type.Ref('SchemaRef'), "outputSchema": Type.Ref('SchemaRef'), "requiredCapabilities": Type.Array(Type.Ref('CapabilityRequirement'), { maxItems: 10000 }), "retrySafety": Type.Union([Type.Literal('idempotent'), Type.Literal('reconcile-first'), Type.Literal('never')]), "publicAnnotations": Type.Ref('DataRef'), "policy": Type.Object({ "version": Type.String(), "classifierRef": Type.Union([Type.Ref('DataRef'), Type.Null()]), "defaults": Type.Ref('ToolPolicyDefaults') }, { additionalProperties: false }), "execution": Type.Ref('ToolExecutionConstraints') }, { additionalProperties: false }),
  "ArtifactVersion": Type.Integer({ minimum: 1, maximum: 9007199254740991 }),
  "ArtifactRef": Type.Object({ "artifactId": Type.Ref('Id'), "version": Type.Ref('ArtifactVersion') }, { additionalProperties: false }),
  "Revision": Type.Ref('UInt53'),
  "DomainObjectRef": Type.Object({ "authorityId": Type.Ref('Id'), "typeId": Type.Ref('TypeId'), "id": Type.Ref('Id'), "revision": Type.Ref('Revision') }, { additionalProperties: false }),
  "ModelFeatures": Type.Object({ "input": Type.Array(Type.Union([Type.Literal('text'), Type.Literal('image'), Type.Literal('audio'), Type.Literal('video')]), { maxItems: 10000 }), "output": Type.Array(Type.Union([Type.Literal('text'), Type.Literal('image'), Type.Literal('audio'), Type.Literal('video')]), { maxItems: 10000 }), "tools": Type.Boolean(), "structuredOutput": Type.Boolean(), "streaming": Type.Boolean() }, { additionalProperties: false }),
  "SecretConsumerBinding": Type.Object({ "consumer": Type.Union([Type.Literal('model'), Type.Literal('mcp'), Type.Literal('tls'), Type.Literal('jwt'), Type.Literal('source-auth'), Type.Literal('surface')]), "secretId": Type.Ref('Id'), "accountRef": Type.Union([Type.Ref('Id'), Type.Null()]), "serverRef": Type.Ref('Id'), "audience": Type.String(), "purpose": Type.String() }, { additionalProperties: false }),
  "ModelRouteSnapshot": Type.Object({ "routeId": Type.Ref('Id'), "routeRevision": Type.Ref('Revision'), "adapter": Type.Ref('BindingRef'), "model": Type.String(), "endpointRef": Type.Ref('Id'), "catalogRevision": Type.Ref('Revision'), "features": Type.Ref('ModelFeatures'), "priceVersion": Type.Ref('Id'), "credentialAudience": Type.String(), "credentialBinding": Type.Union([Type.Ref('SecretConsumerBinding'), Type.Null()]) }, { additionalProperties: false }),
  "ToolCatalogPolicy": Type.Object({ "disclosure": Type.Union([Type.Literal('standard'), Type.Literal('code'), Type.Literal('hybrid'), Type.Literal('provider-defined')]), "discoveredResourceIds": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "compactionAgentCallable": Type.Boolean(), "mainModel": Type.Union([Type.Ref('ModelRouteSnapshot'), Type.Null()]), "policyRevision": Type.Ref('Revision') }, { additionalProperties: false }),
  "SessionRef": Type.Object({ "sessionId": Type.Ref('Id'), "authority": Type.Ref('StateAuthorityRef') }, { additionalProperties: false }),
  "RunRef": Type.Object({ "runId": Type.Ref('Id'), "session": Type.Ref('SessionRef') }, { additionalProperties: false }),
  "InteractionRef": Type.Object({ "interactionId": Type.Ref('Id') }, { additionalProperties: false }),
  "PublicBlobReference": Type.Object({ "kind": Type.Literal('blob'), "value": Type.Ref('BlobRef') }, { additionalProperties: false }),
  "UploadSession": Type.Object({ "authorityId": Type.Ref('Id'), "uploadId": Type.Ref('Id'), "reservationId": Type.Ref('Id'), "expectedBytes": Type.Ref('UInt53'), "receivedBytes": Type.Ref('UInt53'), "expectedDigest": Type.Union([Type.Ref('Digest'), Type.Null()]), "mediaType": Type.String(), "status": Type.Union([Type.Literal('uploading'), Type.Literal('sealed'), Type.Literal('aborted')]), "revision": Type.Ref('Revision') }, { additionalProperties: false }),
  "PublicUploadReference": Type.Object({ "kind": Type.Literal('upload'), "value": Type.Ref('UploadSession') }, { additionalProperties: false }),
  "StagedBlobRef": Type.Object({ "authorityId": Type.Ref('Id'), "blobId": Type.Ref('Id'), "digest": Type.Ref('Digest'), "bytes": Type.Ref('UInt53'), "mediaType": Type.String(), "reservationId": Type.Ref('Id') }, { additionalProperties: false }),
  "PublicStagedBlobReference": Type.Object({ "kind": Type.Literal('staged-blob'), "value": Type.Ref('StagedBlobRef') }, { additionalProperties: false }),
  "PublicRef": Type.Union([Type.Object({ "kind": Type.Literal('session'), "value": Type.Ref('SessionRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('run'), "value": Type.Ref('RunRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('action'), "run": Type.Ref('RunRef'), "actionId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('resource'), "value": Type.Ref('ResourceRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('artifact'), "value": Type.Ref('ArtifactRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('interaction'), "value": Type.Ref('InteractionRef') }, { additionalProperties: false }), Type.Ref('PublicBlobReference'), Type.Ref('PublicUploadReference'), Type.Ref('PublicStagedBlobReference'), Type.Object({ "kind": Type.Literal('domain'), "value": Type.Ref('DomainObjectRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('event'), "authorityId": Type.Ref('Id'), "eventId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('state'), "value": Type.Ref('DomainReference') }, { additionalProperties: false })]),
  "ReceiptPointer": Type.Object({ "authorityId": Type.Ref('Id'), "receiptId": Type.Ref('Id'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "PromptContributionSnapshot": Type.Object({ "digest": Type.Ref('Digest'), "registrationDigest": Type.Ref('Digest'), "sections": Type.Array(Type.Object({ "id": Type.Ref('Id'), "source": Type.Ref('BindingRef'), "order": Type.Ref('UInt53'), "content": Type.Ref('DataRef') }, { additionalProperties: false }), { maxItems: 10000 }), "runtimeContext": Type.Array(Type.Object({ "source": Type.Ref('BindingRef'), "content": Type.Ref('DataRef') }, { additionalProperties: false }), { maxItems: 10000 }), "candidateTools": Type.Array(Type.Ref('ResourceRef'), { maxItems: 10000 }), "conflictDiagnostics": Type.Array(Type.Ref('Id'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "SourceRange": Type.Object({ "session": Type.Ref('SessionRef'), "fromSeq": Type.Ref('UInt53'), "toSeq": Type.Ref('UInt53'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "ContextItem": Type.Object({ "id": Type.Ref('Id'), "kind": Type.Union([Type.Literal('message'), Type.Literal('tool-call'), Type.Literal('tool-result'), Type.Literal('skill'), Type.Literal('resource'), Type.Literal('summary'), Type.Literal('memory')]), "body": Type.Ref('DataRef'), "sourceRefs": Type.Array(Type.Ref('PublicRef'), { maxItems: 10000 }), "provenance": Type.Ref('Provenance'), "trust": Type.Union([Type.Literal('system'), Type.Literal('user'), Type.Literal('external'), Type.Literal('derived')]), "tokenEstimate": Type.Ref('UInt53'), "protected": Type.Boolean(), "toolPairRef": Type.Union([Type.Ref('Id'), Type.Null()]), "sourceRanges": Type.Array(Type.Ref('SourceRange'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "ContextView": Type.Object({ "viewId": Type.Ref('Id'), "format": Type.String(), "schema": Type.Ref('SchemaRef'), "baseRevision": Type.Ref('Revision'), "items": Type.Array(Type.Ref('ContextItem'), { maxItems: 10000 }), "tokenEstimate": Type.Ref('UInt53'), "protectedRefs": Type.Array(Type.Ref('PublicRef'), { maxItems: 10000 }), "inputDigest": Type.Ref('Digest'), "digest": Type.Ref('Digest'), "runtimeInstructionRefs": Type.Array(Type.Ref('DataRef'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "ToolCatalog": Type.Object({ "revision": Type.Ref('Revision'), "digest": Type.Ref('Digest'), "tools": Type.Array(Type.Ref('ToolDefinition'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "ThinkingLevel": Type.Union([Type.Literal('off'), Type.Literal('minimal'), Type.Literal('low'), Type.Literal('medium'), Type.Literal('high'), Type.Literal('xhigh'), Type.Literal('max')]),
  "GenerationOptions": Type.Object({ "maxOutputTokens": Type.Ref('UInt53'), "temperature": Type.Optional(Type.Number()), "seed": Type.Optional(Type.Ref('UInt53')), "thinking": Type.Union([Type.Ref('ThinkingLevel'), Type.Null()]) }, { additionalProperties: false }),
  "ExactQuantity": Type.Object({ "unit": Type.String(), "value": Type.String() }, { additionalProperties: false }),
  "SecretHandle": Type.Object({ "handleId": Type.Ref('Id'), "secretId": Type.Ref('Id'), "version": Type.String(), "audience": Type.String(), "expiresAt": Type.Ref('Timestamp') }, { additionalProperties: false }),
  "ContentBlock": Type.Union([Type.Object({ "type": Type.Literal('text'), "text": Type.String({ maxLength: 1048576 }) }, { additionalProperties: false }), Type.Object({ "type": Type.Literal('image'), "data": Type.String(), "mimeType": Type.String({ maxLength: 128 }) }, { additionalProperties: false }), Type.Object({ "type": Type.Literal('resource_link'), "uri": Type.String({ maxLength: 4096 }), "name": Type.Optional(Type.String({ maxLength: 256 })), "mimeType": Type.Optional(Type.String({ maxLength: 128 })) }, { additionalProperties: false })]),
  "LeaseRef": Type.Object({ "authorityId": Type.Ref('Id'), "leaseId": Type.Ref('Id'), "epoch": Type.Ref('UInt53'), "expiresAt": Type.Ref('Timestamp') }, { additionalProperties: false }),
  "CredentialRefreshRequest": Type.Object({ "requestId": Type.Ref('Id'), "secretId": Type.Ref('Id'), "expectedVersion": Type.String(), "audience": Type.String(), "accountRef": Type.Ref('Id'), "serverRef": Type.Ref('Id'), "purpose": Type.Union([Type.Literal('model-subscription'), Type.Literal('mcp-oauth')]) }, { additionalProperties: false }),
  "AttemptRef": Type.Object({ "run": Type.Ref('RunRef'), "actionId": Type.Ref('Id'), "attemptId": Type.Ref('Id') }, { additionalProperties: false }),
  "QuestionField": Type.Union([Type.Object({ "id": Type.Ref('Id'), "kind": Type.Literal('text'), "label": Type.String({ maxLength: 8192 }), "required": Type.Boolean(), "multiline": Type.Boolean(), "maxLength": Type.Ref('UInt53') }, { additionalProperties: false }), Type.Object({ "id": Type.Ref('Id'), "kind": Type.Literal('singleChoice'), "label": Type.String({ maxLength: 8192 }), "required": Type.Boolean(), "options": Type.Array(Type.Object({ "id": Type.Ref('Id'), "label": Type.String({ maxLength: 8192 }) }, { additionalProperties: false }), { minItems: 1, maxItems: 10000 }) }, { additionalProperties: false }), Type.Object({ "id": Type.Ref('Id'), "kind": Type.Literal('multiChoice'), "label": Type.String({ maxLength: 8192 }), "required": Type.Boolean(), "options": Type.Array(Type.Object({ "id": Type.Ref('Id'), "label": Type.String({ maxLength: 8192 }) }, { additionalProperties: false }), { minItems: 1, maxItems: 10000 }), "minItems": Type.Ref('UInt53'), "maxItems": Type.Ref('UInt53') }, { additionalProperties: false }), Type.Object({ "id": Type.Ref('Id'), "kind": Type.Literal('confirm'), "label": Type.String({ maxLength: 8192 }), "required": Type.Literal(true), "statement": Type.String({ maxLength: 8192 }) }, { additionalProperties: false }), Type.Object({ "id": Type.Ref('Id'), "kind": Type.Literal('custom'), "label": Type.String({ maxLength: 8192 }), "required": Type.Boolean(), "fieldSchema": Type.Ref('SchemaRef'), "rendererKey": Type.Ref('Id') }, { additionalProperties: false })]),
  "QuestionRequest": Type.Object({ "kind": Type.Literal('question'), "body": Type.String({ maxLength: 262144 }), "answerSchema": Type.Ref('SchemaRef'), "fields": Type.Array(Type.Ref('QuestionField'), { minItems: 0, maxItems: 10000 }), "allowedResponders": Type.Array(Type.Ref('Id'), { minItems: 0, maxItems: 10000 }), "expiresAt": Type.Ref('Timestamp'), "idempotencyKey": Type.Ref('Id'), "title": Type.String({ maxLength: 8192 }) }, { additionalProperties: false }),
  "InteractionRequest": Type.Union([Type.Ref('QuestionRequest'), Type.Ref('ApprovalRequest')]),
  "ApprovalAnswerSchemaRef": Type.Object({ "typeId": Type.Literal('agh.interaction/approval-answer@1'), "revision": Type.Literal(1), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "ApprovalAnswer": Type.Union([Type.Object({ "decision": Type.Literal('approve'), "intentDigest": Type.Ref('Digest'), "grantScope": Type.Union([Type.Literal('once'), Type.Literal('session'), Type.Literal('permanent')]) }, { additionalProperties: false }), Type.Object({ "decision": Type.Literal('deny'), "intentDigest": Type.Ref('Digest') }, { additionalProperties: false })]),
  "ApprovalAnswerDataRef": Type.Union([Type.Object({ "kind": Type.Literal('inline'), "schema": Type.Ref('ApprovalAnswerSchemaRef'), "value": Type.Ref('ApprovalAnswer'), "digest": Type.Ref('Digest'), "bytes": Type.Ref('UInt53') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('blob'), "schema": Type.Ref('ApprovalAnswerSchemaRef'), "blob": Type.Ref('BlobRef') }, { additionalProperties: false })]),
  "InteractionRecord": Type.Union([Type.Object({ "interactionId": Type.Ref('Id'), "owner": Type.Object({ "runId": Type.Ref('Id'), "actionId": Type.Ref('Id') }, { additionalProperties: false }), "request": Type.Ref('InteractionRequest'), "version": Type.Integer({ minimum: 1, maximum: 9007199254740991 }), "createdAt": Type.Ref('Timestamp'), "updatedAt": Type.Ref('Timestamp'), "status": Type.Literal('pending'), "terminationReason": Type.Null(), "resolution": Type.Null() }, { additionalProperties: false }), Type.Object({ "interactionId": Type.Ref('Id'), "owner": Type.Object({ "runId": Type.Ref('Id'), "actionId": Type.Ref('Id') }, { additionalProperties: false }), "request": Type.Ref('ApprovalRequest'), "version": Type.Integer({ minimum: 1, maximum: 9007199254740991 }), "createdAt": Type.Ref('Timestamp'), "updatedAt": Type.Ref('Timestamp'), "status": Type.Literal('answered'), "terminationReason": Type.Null(), "resolution": Type.Object({ "responseId": Type.Ref('Id'), "actorRef": Type.Ref('Id'), "answer": Type.Ref('ApprovalAnswerDataRef'), "committedAt": Type.Ref('Timestamp'), "evidence": Type.Union([Type.Object({ "kind": Type.Literal('human'), "authenticationRef": Type.Ref('DataRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('system'), "policyDecisionRef": Type.Ref('DataRef') }, { additionalProperties: false })]) }, { additionalProperties: false }) }, { additionalProperties: false }), Type.Object({ "interactionId": Type.Ref('Id'), "owner": Type.Object({ "runId": Type.Ref('Id'), "actionId": Type.Ref('Id') }, { additionalProperties: false }), "request": Type.Ref('QuestionRequest'), "version": Type.Integer({ minimum: 1, maximum: 9007199254740991 }), "createdAt": Type.Ref('Timestamp'), "updatedAt": Type.Ref('Timestamp'), "status": Type.Literal('answered'), "terminationReason": Type.Null(), "resolution": Type.Object({ "responseId": Type.Ref('Id'), "actorRef": Type.Ref('Id'), "answer": Type.Ref('DataRef'), "committedAt": Type.Ref('Timestamp'), "evidence": Type.Union([Type.Object({ "kind": Type.Literal('human'), "authenticationRef": Type.Ref('DataRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('system'), "policyDecisionRef": Type.Ref('DataRef') }, { additionalProperties: false })]) }, { additionalProperties: false }) }, { additionalProperties: false }), Type.Object({ "interactionId": Type.Ref('Id'), "owner": Type.Object({ "runId": Type.Ref('Id'), "actionId": Type.Ref('Id') }, { additionalProperties: false }), "request": Type.Ref('InteractionRequest'), "version": Type.Integer({ minimum: 1, maximum: 9007199254740991 }), "createdAt": Type.Ref('Timestamp'), "updatedAt": Type.Ref('Timestamp'), "status": Type.Union([Type.Literal('cancelled'), Type.Literal('expired')]), "terminationReason": Object.assign(Type.String({ minLength: 1 }), {"x-max-utf8-bytes":8192}), "resolution": Type.Null() }, { additionalProperties: false })]),
  "Externalsession_v1_ContentBlock": Type.Union([Type.Object({ "type": Type.Literal('text'), "text": Type.String({ maxLength: 1048576 }) }, { additionalProperties: false }), Type.Object({ "type": Type.Literal('image'), "data": Type.String(), "mimeType": Type.String({ maxLength: 128 }) }, { additionalProperties: false }), Type.Object({ "type": Type.Literal('resource_link'), "uri": Type.String({ maxLength: 4096 }), "name": Type.Optional(Type.String({ maxLength: 256 })), "mimeType": Type.Optional(Type.String({ maxLength: 128 })) }, { additionalProperties: false })]),
  "Externaljobs_ContentBlock": Type.Ref('Externalsession_v1_ContentBlock'),
  "Externaljobs_JsonValue": Externalsession_v1_JsonValue,
  "Externaljobs_Schedule": Type.Union([Type.Object({ "kind": Type.Literal('once') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('at'), "at": Type.Integer({ minimum: 0 }) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('every'), "everyMs": Type.Integer({ minimum: 1000 }), "anchorMs": Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('cron'), "expr": Type.String({ maxLength: 128 }), "tz": Type.Optional(Type.String({ maxLength: 64 })), "staggerMs": Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false })]),
  "Externaljobs_JobSpec": Type.Object({ "idempotencyKey": Type.String({ maxLength: 256 }), "sessionKey": Type.String({ maxLength: 512 }), "payload": Type.Union([Type.Object({ "prompt": Type.Union([Type.String({ maxLength: 65536 }), Type.Array(Type.Ref('Externaljobs_ContentBlock'))]), "delivery": Type.Optional(Type.Union([Type.Literal('steer'), Type.Literal('follow_up')])) }, { additionalProperties: false }), Type.Object({ "command": Type.Object({ "method": Type.String({ pattern: "^(?:resume|_agnes/v1/[A-Za-z][A-Za-z0-9./_-]*)$" }), "params": Type.Ref('Externaljobs_JsonValue') }, { additionalProperties: false }) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('directory.sync'), "channel": Type.String({ minLength: 1, maxLength: 64 }) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('shell'), "command": Type.String({ maxLength: 65536 }), "cwd": Type.String({ maxLength: 4096 }) }, { additionalProperties: false })]), "schedule": Type.Ref('Externaljobs_Schedule'), "budget": Type.Optional(Type.Number({ minimum: 0 })), "protected": Type.Optional(Type.Boolean()), "maxAttempts": Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) }, { additionalProperties: false }),
  "Externalagnes_v1_JobSpec": Type.Ref('Externaljobs_JobSpec'),
  "JobSpec": Type.Ref('Externalagnes_v1_JobSpec'),
  "Cursor": Type.String(),
  "AuthorizedViewScope": Type.Union([Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "kind": Type.Literal('workspace') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "kind": Type.Literal('session') }, { additionalProperties: false })]),
  "ResourceFilter": Type.Object({ "namespace": Type.Optional(Type.String()), "tags": Type.Optional(Type.Array(Type.String(), { maxItems: 10000 })) }, { additionalProperties: false }),
  "ContextTarget": Type.Object({ "modelRoute": Type.Ref('Id'), "format": Type.String(), "tokenLimit": Type.Ref('UInt53') }, { additionalProperties: false }),
  "CompactionPlan": Type.Object({ "planId": Type.Ref('Id'), "baseRevision": Type.Ref('Revision'), "inputDigest": Type.Ref('Digest'), "decision": Type.Union([Type.Literal('noop'), Type.Literal('compact')]), "reasonCodes": Type.Array(Type.String(), { maxItems: 10000 }), "algorithm": Type.Ref('BindingRef'), "privatePlan": Type.Ref('DataRef'), "outputCodec": Type.Ref('SchemaRef'), "preservedRefs": Type.Array(Type.Ref('PublicRef'), { maxItems: 10000 }), "sourceRanges": Type.Array(Type.Ref('SourceRange'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "CompactionResult": Type.Object({ "compactionId": Type.Ref('Id'), "viewRevision": Type.Ref('Revision'), "summaryRefs": Type.Array(Type.Ref('DataRef'), { maxItems: 10000 }), "expandedHistoryRef": Type.Ref('DomainObjectRef'), "preservedRefs": Type.Array(Type.Ref('PublicRef'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "ResourceDescriptor": Type.Object({ "id": Type.Ref('Id'), "kind": Type.Union([Type.Literal('tool'), Type.Literal('skill'), Type.Literal('mcp'), Type.Literal('plugin'), Type.Literal('resource')]), "version": Type.String(), "digest": Type.Ref('Digest'), "namespace": Type.String(), "tags": Type.Array(Type.String(), { maxItems: 10000 }), "inputSchema": Type.Union([Type.Ref('SchemaRef'), Type.Null()]), "outputSchema": Type.Union([Type.Ref('SchemaRef'), Type.Null()]), "requiredCapabilities": Type.Array(Type.Ref('CapabilityRequirement'), { maxItems: 10000 }), "sourceRef": Type.Ref('PublicRef'), "trust": Type.Union([Type.Literal('system'), Type.Literal('user'), Type.Literal('external'), Type.Literal('derived')]), "ownerBinding": Type.Ref('BindingRef'), "definition": Type.Ref('DataRef') }, { additionalProperties: false }),
  "JobTarget": Type.Union([Type.Object({ "kind": Type.Literal('pin'), "releaseSetId": Type.Ref('Id'), "bindingId": Type.Ref('Id'), "presetRef": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('follow'), "routeId": Type.Ref('Id'), "presetRef": Type.Ref('Id') }, { additionalProperties: false })]),
  "JobSchedule": Type.Union([Type.Object({ "kind": Type.Literal('once'), "at": Type.Ref('Timestamp') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('rrule'), "rrule": Type.String(), "timezone": Type.String(), "startsAt": Type.Ref('Timestamp'), "ambiguousLocalTime": Type.Union([Type.Literal('earlier'), Type.Literal('later')]), "nonexistentLocalTime": Type.Union([Type.Literal('skip'), Type.Literal('next-valid')]) }, { additionalProperties: false })]),
  "JobPolicy": Type.Object({ "missed": Type.Union([Type.Literal('skip'), Type.Literal('latest'), Type.Literal('catch-up')]), "maxCatchUp": Type.Ref('UInt53'), "concurrency": Type.Union([Type.Literal('forbid'), Type.Literal('queue'), Type.Literal('parallel')]), "maxConcurrent": Type.Ref('UInt53'), "maxAttempts": Type.Ref('UInt53'), "retryDelayMs": Type.Ref('UInt53'), "retryMaxDelayMs": Type.Ref('UInt53') }, { additionalProperties: false }),
  "JobDefinition": Type.Object({ "definitionId": Type.Ref('Id'), "revision": Type.Ref('Revision'), "status": Type.Union([Type.Literal('active'), Type.Literal('paused'), Type.Literal('cancelled')]), "schedule": Type.Ref('JobSchedule'), "policy": Type.Ref('JobPolicy'), "target": Type.Ref('JobTarget'), "inputRef": Type.Ref('DataRef'), "budgetAccount": Type.Ref('DomainObjectRef'), "ownerPrincipalRef": Type.Ref('Id'), "nextDueAt": Type.Union([Type.Ref('Timestamp'), Type.Null()]), "protected": Type.Boolean() }, { additionalProperties: false }),
  "JobOccurrence": Type.Object({ "occurrenceId": Type.Ref('Id'), "revision": Type.Ref('Revision'), "definitionId": Type.Ref('Id'), "definitionRevision": Type.Ref('Revision'), "scheduledAt": Type.Ref('Timestamp'), "attempt": Type.Ref('UInt53'), "state": Type.Union([Type.Literal('pending'), Type.Literal('claimed'), Type.Literal('running'), Type.Literal('succeeded'), Type.Literal('failed'), Type.Literal('cancelled')]), "bindingId": Type.Union([Type.Ref('Id'), Type.Null()]), "releaseSetId": Type.Union([Type.Ref('Id'), Type.Null()]), "ticketId": Type.Union([Type.Ref('Id'), Type.Null()]), "runId": Type.Union([Type.Ref('Id'), Type.Null()]), "claim": Type.Union([Type.Ref('LeaseRef'), Type.Null()]), "nextAttemptAt": Type.Union([Type.Ref('Timestamp'), Type.Null()]), "outcomeRef": Type.Union([Type.Ref('ReceiptPointer'), Type.Null()]) }, { additionalProperties: false }),
  "JobEdit": Type.Object({ "schedule": Type.Optional(Type.Ref('JobSchedule')), "policy": Type.Optional(Type.Ref('JobPolicy')), "target": Type.Optional(Type.Ref('JobTarget')), "inputRef": Type.Optional(Type.Ref('DataRef')), "budgetAccount": Type.Optional(Type.Ref('DomainObjectRef')), "status": Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('paused')])) }, { additionalProperties: false }),
  "ShellConversationClientSubmitRequest": Type.Object({ "sessionId": Type.String(), "kind": Type.Union([Type.Literal('prompt'), Type.Literal('follow-up')]), "content": Type.Array(Type.Ref('ContentBlock'), { maxItems: 10000 }), "requestId": Type.String(), "expectedGeneration": Type.Number() }, { additionalProperties: false }),
  "ShellConversationClientCancelRequest": Type.Object({ "sessionId": Type.String(), "runId": Type.String(), "requestId": Type.String() }, { additionalProperties: false }),
  "ShellConversationClientStatusRequest": Type.String(),
  "SessionControlClientStatusRequest": Type.Object({ "sessionId": Type.Ref('Id'), "requestId": Type.Ref('Id') }, { additionalProperties: false }),
  "SessionBudgetClientReadRequest": Type.Object({ "sessionId": Type.Ref('Id') }, { additionalProperties: false }),
  "PermissionClientRevokeGrantRequest": Type.Object({ "sessionId": Type.Ref('Id'), "toolId": Type.String(), "scope": Type.String(), "policyVersion": Type.String(), "grantId": Type.Ref('Id'), "requestId": Type.Ref('Id') }, { additionalProperties: false }),
  "SessionJobsClientEnqueueRequest": Type.Object({ "requestId": Type.Ref('Id'), "spec": Type.Ref('JobSpec') }, { additionalProperties: false }),
  "SessionJobsClientEnqueueResult": Type.Object({ "jobId": Type.Ref('Id') }, { additionalProperties: false }),
  "SessionJobsClientPollRequest": Type.Object({ "jobId": Type.Ref('Id') }, { additionalProperties: false }),
  "SessionJobsClientCancelRequest": Type.Object({ "jobId": Type.Ref('Id'), "requestId": Type.Ref('Id') }, { additionalProperties: false }),
  "SessionJobsClientCancelResult": Type.Object({ "jobId": Type.Ref('Id'), "cancelRequested": Type.Boolean() }, { additionalProperties: false }),
  "SessionJobsClientCreateRequest": Type.Object({ "requestId": Type.Ref('Id'), "schedule": Type.Ref('JobSchedule'), "policy": Type.Ref('JobPolicy'), "target": Type.Ref('JobTarget'), "inputRef": Type.Ref('DataRef'), "budgetAccount": Type.Ref('DomainObjectRef') }, { additionalProperties: false }),
  "SessionJobsClientUpdateRequest": Type.Object({ "requestId": Type.Ref('Id'), "id": Type.Ref('Id'), "expectedRevision": Type.Ref('Revision'), "changes": Type.Ref('JobEdit') }, { additionalProperties: false }),
  "SessionJobsClientInspectRequest": Type.Object({ "id": Type.Ref('Id'), "cursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "limit": Type.Ref('UInt53') }, { additionalProperties: false }),
  "PageJobOccurrence": Type.Object({ "items": Type.Array(Type.Ref('JobOccurrence'), { maxItems: 10000 }), "snapshot": Type.Ref('Id'), "nextCursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "complete": Type.Boolean() }, { additionalProperties: false }),
  "SessionJobsClientInspectResult": Type.Object({ "definition": Type.Ref('JobDefinition'), "occurrences": Type.Ref('PageJobOccurrence') }, { additionalProperties: false }),
  "SessionJobsClientCancelDefinitionRequest": Type.Object({ "requestId": Type.Ref('Id'), "id": Type.Ref('Id'), "expectedRevision": Type.Ref('Revision'), "reason": Type.String(), "cancelActive": Type.Boolean() }, { additionalProperties: false }),
  "InteractionClientPendingRequest": Type.Object({ "scope": Type.Ref('AuthorizedViewScope'), "cursor": Type.Optional(Type.Ref('Cursor')), "limit": Type.Optional(Type.Ref('UInt53')) }, { additionalProperties: false }),
  "PageInteractionRecord": Type.Object({ "items": Type.Array(Type.Ref('InteractionRecord'), { maxItems: 10000 }), "snapshot": Type.Ref('Id'), "nextCursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "complete": Type.Boolean() }, { additionalProperties: false }),
  "InteractionClientPendingResult": Type.Ref('PageInteractionRecord'),
  "InteractionClientRespondRequest": Type.Object({ "interactionId": Type.Ref('Id'), "responseId": Type.Ref('Id'), "expectedVersion": Type.Ref('UInt53'), "answer": Type.Ref('DataRef') }, { additionalProperties: false }),
  "ArtifactReadStreamCancelRequest": Type.String(),
  "ArtifactClientOpenDownloadRequest": Type.Object({ "artifactId": Type.Ref('Id'), "version": Type.Ref('ArtifactVersion'), "disposition": Type.Union([Type.Literal('inline'), Type.Literal('attachment')]) }, { additionalProperties: false }),
  "ArtifactClientReadRangeRequest": Type.Object({ "artifactId": Type.Ref('Id'), "version": Type.Ref('ArtifactVersion'), "offset": Type.Ref('UInt53'), "length": Type.Ref('UInt53') }, { additionalProperties: false }),
  "ArtifactClientOpenStreamRequest": Type.Object({ "artifactId": Type.Ref('Id'), "version": Type.Ref('ArtifactVersion'), "offset": Type.Optional(Type.Ref('UInt53')) }, { additionalProperties: false }),
  "ContextViewRequest": Type.Object({ "sessionRef": Type.Ref('SessionRef'), "atRevision": Type.Ref('Revision'), "target": Type.Ref('ContextTarget'), "resourceRefs": Type.Array(Type.Ref('PublicRef'), { maxItems: 10000 }), "purpose": Type.String(), "contributions": Type.Ref('PromptContributionSnapshot'), "hookResults": Type.Union([Type.Ref('HookResultSet'), Type.Null()]) }, { additionalProperties: false }),
  "ContextPrepareViewRequest": Type.Object({ "sessionRef": Type.Ref('SessionRef'), "atRevision": Type.Ref('Revision'), "target": Type.Ref('ContextTarget'), "resourceRefs": Type.Array(Type.Ref('PublicRef'), { maxItems: 10000 }), "purpose": Type.String(), "contributions": Type.Ref('PromptContributionSnapshot'), "hookResults": Type.Null() }, { additionalProperties: false }),
  "ContextRefreshRequest": Type.Object({ "resourceRefs": Type.Array(Type.Ref('PublicRef'), { maxItems: 10000 }), "expectedRevision": Type.Ref('Revision'), "reason": Type.String() }, { additionalProperties: false }),
  "ContextRefreshResult": Type.Object({ "newRevision": Type.Ref('Revision'), "updatedRefs": Type.Array(Type.Ref('PublicRef'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "CompactionPlanRequest": Type.Object({ "view": Type.Ref('ContextView'), "limitTokens": Type.Ref('UInt53'), "trigger": Type.Union([Type.Literal('manual'), Type.Literal('automatic')]), "protectedRefs": Type.Array(Type.Ref('PublicRef'), { maxItems: 10000 }), "instructions": Type.Union([Type.String(), Type.Null()]), "hookResults": Type.Union([Type.Ref('HookResultSet'), Type.Null()]) }, { additionalProperties: false }),
  "CompactionPreparePlanRequest": Type.Object({ "view": Type.Ref('ContextView'), "limitTokens": Type.Ref('UInt53'), "trigger": Type.Union([Type.Literal('manual'), Type.Literal('automatic')]), "protectedRefs": Type.Array(Type.Ref('PublicRef'), { maxItems: 10000 }), "instructions": Type.Union([Type.String(), Type.Null()]), "hookResults": Type.Null() }, { additionalProperties: false }),
  "CompactionExecuteRequest": Type.Object({ "plan": Type.Ref('CompactionPlan'), "expectedRevision": Type.Ref('Revision') }, { additionalProperties: false }),
  "CompactionApplyRequest": Type.Object({ "plan": Type.Ref('CompactionPlan'), "expectedRevision": Type.Ref('Revision'), "result": Type.Ref('CompactionResult'), "childReceiptRefs": Type.Array(Type.Ref('ReceiptPointer'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "CompactionApplyResult": Type.Object({ "viewRevision": Type.Ref('Revision') }, { additionalProperties: false }),
  "CompactionExpandRequest": Type.Object({ "compactionId": Type.Ref('Id'), "sourceRange": Type.Ref('SourceRange'), "cursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "limit": Type.Ref('UInt53') }, { additionalProperties: false }),
  "PageContextItem": Type.Object({ "items": Type.Array(Type.Ref('ContextItem'), { maxItems: 10000 }), "snapshot": Type.Ref('Id'), "nextCursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "complete": Type.Boolean() }, { additionalProperties: false }),
  "CompactionExpandResult": Type.Ref('PageContextItem'),
  "ModelPrepareRequest": Type.Object({ "view": Type.Ref('ContextView'), "route": Type.Ref('ModelRouteSnapshot'), "outputSchema": Type.Union([Type.Ref('SchemaRef'), Type.Null()]), "toolCatalog": Type.Union([Type.Ref('ToolCatalog'), Type.Null()]), "generation": Type.Ref('GenerationOptions'), "hookResults": Type.Union([Type.Ref('HookResultSet'), Type.Null()]), "sessionParameterRef": Type.Ref('DomainReference'), "credentialRef": Type.Union([Type.Ref('SecretHandle'), Type.Null()]) }, { additionalProperties: false }),
  "ModelPrepareResult": Type.Object({ "preparedRef": Type.Ref('DataRef'), "targetSnapshot": Type.Ref('ModelRouteSnapshot'), "inputDigest": Type.Ref('Digest'), "estimatedUnits": Type.Array(Type.Ref('ExactQuantity'), { maxItems: 10000 }), "mediaPlanRefs": Type.Array(Type.Ref('DataRef'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "ModelPrepareRequestRequest": Type.Object({ "view": Type.Ref('ContextView'), "route": Type.Ref('ModelRouteSnapshot'), "outputSchema": Type.Union([Type.Ref('SchemaRef'), Type.Null()]), "toolCatalog": Type.Union([Type.Ref('ToolCatalog'), Type.Null()]), "generation": Type.Ref('GenerationOptions'), "hookResults": Type.Null(), "sessionParameterRef": Type.Ref('DomainReference'), "credentialRef": Type.Union([Type.Ref('SecretHandle'), Type.Null()]), "credentialRefresh": Type.Union([Type.Ref('CredentialRefreshRequest'), Type.Null()]) }, { additionalProperties: false }),
  "ModelPrepareRequestResult": Type.Object({ "preparedRef": Type.Ref('DataRef'), "targetSnapshot": Type.Ref('ModelRouteSnapshot'), "inputDigest": Type.Ref('Digest'), "estimatedUnits": Type.Array(Type.Ref('ExactQuantity'), { maxItems: 10000 }), "mediaPlanRefs": Type.Array(Type.Ref('DataRef'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "ModelInferRequest": Type.Object({ "preparedRef": Type.Ref('DataRef') }, { additionalProperties: false }),
  "ModelAdapterInvokeRequest": Type.Object({ "preparedCallRef": Type.Ref('DataRef'), "externalIdempotencyKey": Type.Ref('Id') }, { additionalProperties: false }),
  "ModelAdapterReconcileRequest": Type.Object({ "attemptRef": Type.Ref('AttemptRef'), "externalReceipt": Type.Union([Type.Ref('DataRef'), Type.Null()]) }, { additionalProperties: false }),
  "ResourcesListRequest": Type.Object({ "kind": Type.Union([Type.Literal('tool'), Type.Literal('skill'), Type.Literal('mcp'), Type.Literal('plugin'), Type.Literal('resource')]), "filter": Type.Ref('ResourceFilter'), "cursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "limit": Type.Ref('UInt53') }, { additionalProperties: false }),
  "PageResourceDescriptor": Type.Object({ "items": Type.Array(Type.Ref('ResourceDescriptor'), { maxItems: 10000 }), "snapshot": Type.Ref('Id'), "nextCursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "complete": Type.Boolean() }, { additionalProperties: false }),
  "ResourcesListResult": Type.Ref('PageResourceDescriptor'),
  "ResourcesDescribeRequest": Type.Object({ "resourceId": Type.Ref('Id'), "version": Type.Union([Type.String(), Type.Null()]) }, { additionalProperties: false }),
  "ResourcesRegisterRequest": Type.Object({ "descriptor": Type.Ref('ResourceDescriptor'), "ownerReleaseSetId": Type.Ref('Id') }, { additionalProperties: false }),
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
export const RuntimeErrorCode = RuntimePublic12.Import('RuntimeErrorCode')
export type RuntimeErrorCode = Static<typeof RuntimeErrorCode>
export const OwnerRef = RuntimePublic12.Import('OwnerRef')
export type OwnerRef = Static<typeof OwnerRef>
export const RetryAdvice = RuntimePublic12.Import('RetryAdvice')
export type RetryAdvice = Static<typeof RetryAdvice>
export const RuntimeError = RuntimePublic12.Import('RuntimeError')
export type RuntimeError = Static<typeof RuntimeError>
export const ExternalRequestRef = RuntimePublic12.Import('ExternalRequestRef')
export type ExternalRequestRef = Static<typeof ExternalRequestRef>
export const RetentionRef = RuntimePublic12.Import('RetentionRef')
export type RetentionRef = Static<typeof RetentionRef>
export const BindingRef = RuntimePublic12.Import('BindingRef')
export type BindingRef = Static<typeof BindingRef>
export const Provenance = RuntimePublic12.Import('Provenance')
export type Provenance = Static<typeof Provenance>
export const ActionResultView = RuntimePublic12.Import('ActionResultView')
export type ActionResultView = Static<typeof ActionResultView>
export const StateAuthorityRef = RuntimePublic12.Import('StateAuthorityRef')
export type StateAuthorityRef = Static<typeof StateAuthorityRef>
export const HookEventName = RuntimePublic12.Import('HookEventName')
export type HookEventName = Static<typeof HookEventName>
export const HookResultSet = RuntimePublic12.Import('HookResultSet')
export type HookResultSet = Static<typeof HookResultSet>
export const ScopeRef = RuntimePublic12.Import('ScopeRef')
export type ScopeRef = Static<typeof ScopeRef>
export const ApprovalRequest = RuntimePublic12.Import('ApprovalRequest')
export type ApprovalRequest = Static<typeof ApprovalRequest>
export const DomainReference = RuntimePublic12.Import('DomainReference')
export type DomainReference = Static<typeof DomainReference>
export const CapabilityRequirement = RuntimePublic12.Import('CapabilityRequirement')
export type CapabilityRequirement = Static<typeof CapabilityRequirement>
export const ToolPolicyDefaults = RuntimePublic12.Import('ToolPolicyDefaults')
export type ToolPolicyDefaults = Static<typeof ToolPolicyDefaults>
export const ToolExecutionConstraints = RuntimePublic12.Import('ToolExecutionConstraints')
export type ToolExecutionConstraints = Static<typeof ToolExecutionConstraints>
export const ResourceRef = RuntimePublic12.Import('ResourceRef')
export type ResourceRef = Static<typeof ResourceRef>
export const ToolDefinition = RuntimePublic12.Import('ToolDefinition')
export type ToolDefinition = Static<typeof ToolDefinition>
export const ArtifactVersion = RuntimePublic12.Import('ArtifactVersion')
export type ArtifactVersion = Static<typeof ArtifactVersion>
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
export const ToolCatalogPolicy = RuntimePublic12.Import('ToolCatalogPolicy')
export type ToolCatalogPolicy = Static<typeof ToolCatalogPolicy>
export const SessionRef = RuntimePublic12.Import('SessionRef')
export type SessionRef = Static<typeof SessionRef>
export const RunRef = RuntimePublic12.Import('RunRef')
export type RunRef = Static<typeof RunRef>
export const InteractionRef = RuntimePublic12.Import('InteractionRef')
export type InteractionRef = Static<typeof InteractionRef>
export const PublicBlobReference = RuntimePublic12.Import('PublicBlobReference')
export type PublicBlobReference = Static<typeof PublicBlobReference>
export const UploadSession = RuntimePublic12.Import('UploadSession')
export type UploadSession = Static<typeof UploadSession>
export const PublicUploadReference = RuntimePublic12.Import('PublicUploadReference')
export type PublicUploadReference = Static<typeof PublicUploadReference>
export const StagedBlobRef = RuntimePublic12.Import('StagedBlobRef')
export type StagedBlobRef = Static<typeof StagedBlobRef>
export const PublicStagedBlobReference = RuntimePublic12.Import('PublicStagedBlobReference')
export type PublicStagedBlobReference = Static<typeof PublicStagedBlobReference>
export const PublicRef = RuntimePublic12.Import('PublicRef')
export type PublicRef = Static<typeof PublicRef>
export const ReceiptPointer = RuntimePublic12.Import('ReceiptPointer')
export type ReceiptPointer = Static<typeof ReceiptPointer>
export const PromptContributionSnapshot = RuntimePublic12.Import('PromptContributionSnapshot')
export type PromptContributionSnapshot = Static<typeof PromptContributionSnapshot>
export const SourceRange = RuntimePublic12.Import('SourceRange')
export type SourceRange = Static<typeof SourceRange>
export const ContextItem = RuntimePublic12.Import('ContextItem')
export type ContextItem = Static<typeof ContextItem>
export const ContextView = RuntimePublic12.Import('ContextView')
export type ContextView = Static<typeof ContextView>
export const ToolCatalog = RuntimePublic12.Import('ToolCatalog')
export type ToolCatalog = Static<typeof ToolCatalog>
export const ThinkingLevel = RuntimePublic12.Import('ThinkingLevel')
export type ThinkingLevel = Static<typeof ThinkingLevel>
export const GenerationOptions = RuntimePublic12.Import('GenerationOptions')
export type GenerationOptions = Static<typeof GenerationOptions>
export const ExactQuantity = RuntimePublic12.Import('ExactQuantity')
export type ExactQuantity = Static<typeof ExactQuantity>
export const SecretHandle = RuntimePublic12.Import('SecretHandle')
export type SecretHandle = Static<typeof SecretHandle>
export const ContentBlock = RuntimePublic12.Import('ContentBlock')
export type ContentBlock = Static<typeof ContentBlock>
export const LeaseRef = RuntimePublic12.Import('LeaseRef')
export type LeaseRef = Static<typeof LeaseRef>
export const CredentialRefreshRequest = RuntimePublic12.Import('CredentialRefreshRequest')
export type CredentialRefreshRequest = Static<typeof CredentialRefreshRequest>
export const AttemptRef = RuntimePublic12.Import('AttemptRef')
export type AttemptRef = Static<typeof AttemptRef>
export const QuestionField = RuntimePublic12.Import('QuestionField')
export type QuestionField = Static<typeof QuestionField>
export const QuestionRequest = RuntimePublic12.Import('QuestionRequest')
export type QuestionRequest = Static<typeof QuestionRequest>
export const InteractionRequest = RuntimePublic12.Import('InteractionRequest')
export type InteractionRequest = Static<typeof InteractionRequest>
export const ApprovalAnswerSchemaRef = RuntimePublic12.Import('ApprovalAnswerSchemaRef')
export type ApprovalAnswerSchemaRef = Static<typeof ApprovalAnswerSchemaRef>
export const ApprovalAnswer = RuntimePublic12.Import('ApprovalAnswer')
export type ApprovalAnswer = Static<typeof ApprovalAnswer>
export const ApprovalAnswerDataRef = RuntimePublic12.Import('ApprovalAnswerDataRef')
export type ApprovalAnswerDataRef = Static<typeof ApprovalAnswerDataRef>
export const InteractionRecord = RuntimePublic12.Import('InteractionRecord')
export type InteractionRecord = Static<typeof InteractionRecord>
export const Externalsession_v1_ContentBlock = RuntimePublic12.Import('Externalsession_v1_ContentBlock')
export type Externalsession_v1_ContentBlock = Static<typeof Externalsession_v1_ContentBlock>
export const Externaljobs_ContentBlock = RuntimePublic12.Import('Externaljobs_ContentBlock')
export type Externaljobs_ContentBlock = Static<typeof Externaljobs_ContentBlock>
export const Externaljobs_JsonValue = RuntimePublic12.Import('Externaljobs_JsonValue')
export type Externaljobs_JsonValue = Static<typeof Externaljobs_JsonValue>
export const Externaljobs_Schedule = RuntimePublic12.Import('Externaljobs_Schedule')
export type Externaljobs_Schedule = Static<typeof Externaljobs_Schedule>
export const Externaljobs_JobSpec = RuntimePublic12.Import('Externaljobs_JobSpec')
export type Externaljobs_JobSpec = Static<typeof Externaljobs_JobSpec>
export const Externalagnes_v1_JobSpec = RuntimePublic12.Import('Externalagnes_v1_JobSpec')
export type Externalagnes_v1_JobSpec = Static<typeof Externalagnes_v1_JobSpec>
export const JobSpec = RuntimePublic12.Import('JobSpec')
export type JobSpec = Static<typeof JobSpec>
export const Cursor = RuntimePublic12.Import('Cursor')
export type Cursor = Static<typeof Cursor>
export const AuthorizedViewScope = RuntimePublic12.Import('AuthorizedViewScope')
export type AuthorizedViewScope = Static<typeof AuthorizedViewScope>
export const ResourceFilter = RuntimePublic12.Import('ResourceFilter')
export type ResourceFilter = Static<typeof ResourceFilter>
export const ContextTarget = RuntimePublic12.Import('ContextTarget')
export type ContextTarget = Static<typeof ContextTarget>
export const CompactionPlan = RuntimePublic12.Import('CompactionPlan')
export type CompactionPlan = Static<typeof CompactionPlan>
export const CompactionResult = RuntimePublic12.Import('CompactionResult')
export type CompactionResult = Static<typeof CompactionResult>
export const ResourceDescriptor = RuntimePublic12.Import('ResourceDescriptor')
export type ResourceDescriptor = Static<typeof ResourceDescriptor>
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
export const ShellConversationClientSubmitRequest = RuntimePublic12.Import('ShellConversationClientSubmitRequest')
export type ShellConversationClientSubmitRequest = Static<typeof ShellConversationClientSubmitRequest>
export const ShellConversationClientCancelRequest = RuntimePublic12.Import('ShellConversationClientCancelRequest')
export type ShellConversationClientCancelRequest = Static<typeof ShellConversationClientCancelRequest>
export const ShellConversationClientStatusRequest = RuntimePublic12.Import('ShellConversationClientStatusRequest')
export type ShellConversationClientStatusRequest = Static<typeof ShellConversationClientStatusRequest>
export const SessionControlClientStatusRequest = RuntimePublic12.Import('SessionControlClientStatusRequest')
export type SessionControlClientStatusRequest = Static<typeof SessionControlClientStatusRequest>
export const SessionBudgetClientReadRequest = RuntimePublic12.Import('SessionBudgetClientReadRequest')
export type SessionBudgetClientReadRequest = Static<typeof SessionBudgetClientReadRequest>
export const PermissionClientRevokeGrantRequest = RuntimePublic12.Import('PermissionClientRevokeGrantRequest')
export type PermissionClientRevokeGrantRequest = Static<typeof PermissionClientRevokeGrantRequest>
export const SessionJobsClientEnqueueRequest = RuntimePublic12.Import('SessionJobsClientEnqueueRequest')
export type SessionJobsClientEnqueueRequest = Static<typeof SessionJobsClientEnqueueRequest>
export const SessionJobsClientEnqueueResult = RuntimePublic12.Import('SessionJobsClientEnqueueResult')
export type SessionJobsClientEnqueueResult = Static<typeof SessionJobsClientEnqueueResult>
export const SessionJobsClientPollRequest = RuntimePublic12.Import('SessionJobsClientPollRequest')
export type SessionJobsClientPollRequest = Static<typeof SessionJobsClientPollRequest>
export const SessionJobsClientCancelRequest = RuntimePublic12.Import('SessionJobsClientCancelRequest')
export type SessionJobsClientCancelRequest = Static<typeof SessionJobsClientCancelRequest>
export const SessionJobsClientCancelResult = RuntimePublic12.Import('SessionJobsClientCancelResult')
export type SessionJobsClientCancelResult = Static<typeof SessionJobsClientCancelResult>
export const SessionJobsClientCreateRequest = RuntimePublic12.Import('SessionJobsClientCreateRequest')
export type SessionJobsClientCreateRequest = Static<typeof SessionJobsClientCreateRequest>
export const SessionJobsClientUpdateRequest = RuntimePublic12.Import('SessionJobsClientUpdateRequest')
export type SessionJobsClientUpdateRequest = Static<typeof SessionJobsClientUpdateRequest>
export const SessionJobsClientInspectRequest = RuntimePublic12.Import('SessionJobsClientInspectRequest')
export type SessionJobsClientInspectRequest = Static<typeof SessionJobsClientInspectRequest>
export const PageJobOccurrence = RuntimePublic12.Import('PageJobOccurrence')
export type PageJobOccurrence = Page<JobOccurrence>
export const SessionJobsClientInspectResult = RuntimePublic12.Import('SessionJobsClientInspectResult')
export type SessionJobsClientInspectResult = Omit<Static<typeof SessionJobsClientInspectResult>, "occurrences"> & { "occurrences": PageJobOccurrence }
export const SessionJobsClientCancelDefinitionRequest = RuntimePublic12.Import('SessionJobsClientCancelDefinitionRequest')
export type SessionJobsClientCancelDefinitionRequest = Static<typeof SessionJobsClientCancelDefinitionRequest>
export const InteractionClientPendingRequest = RuntimePublic12.Import('InteractionClientPendingRequest')
export type InteractionClientPendingRequest = Static<typeof InteractionClientPendingRequest>
export const PageInteractionRecord = RuntimePublic12.Import('PageInteractionRecord')
export type PageInteractionRecord = Page<InteractionRecord>
export const InteractionClientPendingResult = RuntimePublic12.Import('InteractionClientPendingResult')
export type InteractionClientPendingResult = PageInteractionRecord
export const InteractionClientRespondRequest = RuntimePublic12.Import('InteractionClientRespondRequest')
export type InteractionClientRespondRequest = Static<typeof InteractionClientRespondRequest>
export const ArtifactReadStreamCancelRequest = RuntimePublic12.Import('ArtifactReadStreamCancelRequest')
export type ArtifactReadStreamCancelRequest = Static<typeof ArtifactReadStreamCancelRequest>
export const ArtifactClientOpenDownloadRequest = RuntimePublic12.Import('ArtifactClientOpenDownloadRequest')
export type ArtifactClientOpenDownloadRequest = Static<typeof ArtifactClientOpenDownloadRequest>
export const ArtifactClientReadRangeRequest = RuntimePublic12.Import('ArtifactClientReadRangeRequest')
export type ArtifactClientReadRangeRequest = Static<typeof ArtifactClientReadRangeRequest>
export const ArtifactClientOpenStreamRequest = RuntimePublic12.Import('ArtifactClientOpenStreamRequest')
export type ArtifactClientOpenStreamRequest = Static<typeof ArtifactClientOpenStreamRequest>
export const ContextViewRequest = RuntimePublic12.Import('ContextViewRequest')
export type ContextViewRequest = Static<typeof ContextViewRequest>
export const ContextPrepareViewRequest = RuntimePublic12.Import('ContextPrepareViewRequest')
export type ContextPrepareViewRequest = Static<typeof ContextPrepareViewRequest>
export const ContextRefreshRequest = RuntimePublic12.Import('ContextRefreshRequest')
export type ContextRefreshRequest = Static<typeof ContextRefreshRequest>
export const ContextRefreshResult = RuntimePublic12.Import('ContextRefreshResult')
export type ContextRefreshResult = Static<typeof ContextRefreshResult>
export const CompactionPlanRequest = RuntimePublic12.Import('CompactionPlanRequest')
export type CompactionPlanRequest = Static<typeof CompactionPlanRequest>
export const CompactionPreparePlanRequest = RuntimePublic12.Import('CompactionPreparePlanRequest')
export type CompactionPreparePlanRequest = Static<typeof CompactionPreparePlanRequest>
export const CompactionExecuteRequest = RuntimePublic12.Import('CompactionExecuteRequest')
export type CompactionExecuteRequest = Static<typeof CompactionExecuteRequest>
export const CompactionApplyRequest = RuntimePublic12.Import('CompactionApplyRequest')
export type CompactionApplyRequest = Static<typeof CompactionApplyRequest>
export const CompactionApplyResult = RuntimePublic12.Import('CompactionApplyResult')
export type CompactionApplyResult = Static<typeof CompactionApplyResult>
export const CompactionExpandRequest = RuntimePublic12.Import('CompactionExpandRequest')
export type CompactionExpandRequest = Static<typeof CompactionExpandRequest>
export const PageContextItem = RuntimePublic12.Import('PageContextItem')
export type PageContextItem = Page<ContextItem>
export const CompactionExpandResult = RuntimePublic12.Import('CompactionExpandResult')
export type CompactionExpandResult = PageContextItem
export const ModelPrepareRequest = RuntimePublic12.Import('ModelPrepareRequest')
export type ModelPrepareRequest = Static<typeof ModelPrepareRequest>
export const ModelPrepareResult = RuntimePublic12.Import('ModelPrepareResult')
export type ModelPrepareResult = Static<typeof ModelPrepareResult>
export const ModelPrepareRequestRequest = RuntimePublic12.Import('ModelPrepareRequestRequest')
export type ModelPrepareRequestRequest = Static<typeof ModelPrepareRequestRequest>
export const ModelPrepareRequestResult = RuntimePublic12.Import('ModelPrepareRequestResult')
export type ModelPrepareRequestResult = Static<typeof ModelPrepareRequestResult>
export const ModelInferRequest = RuntimePublic12.Import('ModelInferRequest')
export type ModelInferRequest = Static<typeof ModelInferRequest>
export const ModelAdapterInvokeRequest = RuntimePublic12.Import('ModelAdapterInvokeRequest')
export type ModelAdapterInvokeRequest = Static<typeof ModelAdapterInvokeRequest>
export const ModelAdapterReconcileRequest = RuntimePublic12.Import('ModelAdapterReconcileRequest')
export type ModelAdapterReconcileRequest = Static<typeof ModelAdapterReconcileRequest>
export const ResourcesListRequest = RuntimePublic12.Import('ResourcesListRequest')
export type ResourcesListRequest = Static<typeof ResourcesListRequest>
export const PageResourceDescriptor = RuntimePublic12.Import('PageResourceDescriptor')
export type PageResourceDescriptor = Page<ResourceDescriptor>
export const ResourcesListResult = RuntimePublic12.Import('ResourcesListResult')
export type ResourcesListResult = PageResourceDescriptor
export const ResourcesDescribeRequest = RuntimePublic12.Import('ResourcesDescribeRequest')
export type ResourcesDescribeRequest = Static<typeof ResourcesDescribeRequest>
export const ResourcesRegisterRequest = RuntimePublic12.Import('ResourcesRegisterRequest')
export type ResourcesRegisterRequest = Static<typeof ResourcesRegisterRequest>
export const ResourcesRegisterResult = RuntimePublic12.Import('ResourcesRegisterResult')
export type ResourcesRegisterResult = Static<typeof ResourcesRegisterResult>
export const ResourcesRemoveRequest = RuntimePublic12.Import('ResourcesRemoveRequest')
export type ResourcesRemoveRequest = Static<typeof ResourcesRemoveRequest>
export const ResourcesRemoveResult = RuntimePublic12.Import('ResourcesRemoveResult')
export type ResourcesRemoveResult = Static<typeof ResourcesRemoveResult>
export const ResourcesRetainRequest = RuntimePublic12.Import('ResourcesRetainRequest')
export type ResourcesRetainRequest = Static<typeof ResourcesRetainRequest>
export const ResourcesReleaseRequest = RuntimePublic12.Import('ResourcesReleaseRequest')
export type ResourcesReleaseRequest = Static<typeof ResourcesReleaseRequest>
export const ResourcesReleaseResult = RuntimePublic12.Import('ResourcesReleaseResult')
export type ResourcesReleaseResult = Static<typeof ResourcesReleaseResult>
export const McpConnectResult = RuntimePublic12.Import('McpConnectResult')
export type McpConnectResult = Static<typeof McpConnectResult>
export const McpCallRequest = RuntimePublic12.Import('McpCallRequest')
export type McpCallRequest = Static<typeof McpCallRequest>
export const McpCallResult = RuntimePublic12.Import('McpCallResult')
export type McpCallResult = Static<typeof McpCallResult>
export const McpReadRequest = RuntimePublic12.Import('McpReadRequest')
export type McpReadRequest = Static<typeof McpReadRequest>
export const McpReadResult = RuntimePublic12.Import('McpReadResult')
export type McpReadResult = Static<typeof McpReadResult>
export const ToolsDescribeRequest = RuntimePublic12.Import('ToolsDescribeRequest')
export type ToolsDescribeRequest = Static<typeof ToolsDescribeRequest>
export const ToolsInspectRequest = RuntimePublic12.Import('ToolsInspectRequest')
export type ToolsInspectRequest = Static<typeof ToolsInspectRequest>
export const ToolsInspectResult = RuntimePublic12.Import('ToolsInspectResult')
export type ToolsInspectResult = Static<typeof ToolsInspectResult>
export const ToolsClassifyRequest = RuntimePublic12.Import('ToolsClassifyRequest')
export type ToolsClassifyRequest = Static<typeof ToolsClassifyRequest>
export const ToolsCatalogRequest = RuntimePublic12.Import('ToolsCatalogRequest')
export type ToolsCatalogRequest = Static<typeof ToolsCatalogRequest>
export const ToolsUpdatePlanResult = RuntimePublic12.Import('ToolsUpdatePlanResult')
export type ToolsUpdatePlanResult = Static<typeof ToolsUpdatePlanResult>
export const ToolsRequestCompactionRequest = RuntimePublic12.Import('ToolsRequestCompactionRequest')
export type ToolsRequestCompactionRequest = Static<typeof ToolsRequestCompactionRequest>
export const ToolsRequestCompactionResult = RuntimePublic12.Import('ToolsRequestCompactionResult')
export type ToolsRequestCompactionResult = Static<typeof ToolsRequestCompactionResult>
export const ToolsCancelRequest = RuntimePublic12.Import('ToolsCancelRequest')
export type ToolsCancelRequest = Static<typeof ToolsCancelRequest>
export const ToolsCancelResult = RuntimePublic12.Import('ToolsCancelResult')
export type ToolsCancelResult = Static<typeof ToolsCancelResult>
