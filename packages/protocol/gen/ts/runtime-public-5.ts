// generated from schema by tools/gen.ts — do not edit
import { Type, type Static } from '@sinclair/typebox'
import { FormatRegistry } from '@sinclair/typebox'

if (!FormatRegistry.Has('date-time')) FormatRegistry.Set('date-time', (value) => { const parts = value.split(/t/i); if (parts.length !== 2) return false; const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(parts[0] ?? ''); const time = /^(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)(z|([+-])(\d{2}):(\d{2}))$/i.exec(parts[1] ?? ''); if (!date || !time) return false; const year = Number(date[1]), month = Number(date[2]), day = Number(date[3]); const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0); const days = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; if (month < 1 || month > 12 || day < 1 || day > (days[month] ?? 0)) return false; const hour = Number(time[1]), minute = Number(time[2]), second = Number(time[3]); const offsetHour = Number(time[6] || 0), offsetMinute = Number(time[7] || 0); if (hour > 23 || minute > 59 || offsetHour > 23 || offsetMinute > 59) return false; if (second < 60) return true; const sign = time[5] === '-' ? -1 : 1; const utcMinute = minute - offsetMinute * sign; const utcHour = hour - offsetHour * sign - (utcMinute < 0 ? 1 : 0); return (utcHour === 23 || utcHour === -1) && (utcMinute === 59 || utcMinute === -1) && second < 61; })

export const JsonValue = Type.Recursive((This) => Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String(), Type.Array(This, { minItems: 0, maxItems: 10000 }), Type.Record(Type.String(), This)]))
export type JsonValue = Static<typeof JsonValue>

export const Externalsession_v1_JsonValue = Type.Recursive((This) => Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String(), Type.Array(This), Type.Record(Type.String(), This)]))
export type Externalsession_v1_JsonValue = Static<typeof Externalsession_v1_JsonValue>

export const Externalagnes_v1_UISpan = Type.Recursive((This) => Type.Object({ "id": Type.String({ maxLength: 128 }), "kind": Type.Union([Type.Literal('turn'), Type.Literal('step'), Type.Literal('generation'), Type.Literal('tool'), Type.Literal('subagent'), Type.Literal('compaction'), Type.Literal('approval'), Type.Literal('other')]), "name": Type.String({ maxLength: 256 }), "status": Type.Union([Type.Literal('running'), Type.Literal('waiting'), Type.Literal('completed'), Type.Literal('failed'), Type.Literal('cancelled')]), "startSeq": Type.Integer({ minimum: 1 }), "startedAt": Type.String({ format: "date-time" }), "endSeq": Type.Optional(Type.Integer({ minimum: 1 })), "endedAt": Type.Optional(Type.String({ format: "date-time" })), "durationMs": Type.Optional(Type.Integer({ minimum: 0 })), "ttftMs": Type.Optional(Type.Integer({ minimum: 0 })), "purpose": Type.Optional(Type.Union([Type.Literal('inference'), Type.Literal('compaction'), Type.Literal('verifier'), Type.Literal('subagent'), Type.Literal('media'), Type.Literal('tool'), Type.Literal('title'), Type.Literal('approval-guardian')])), "model": Type.Optional(Type.String({ maxLength: 256 })), "effectId": Type.Optional(Type.String({ maxLength: 128 })), "toolUseId": Type.Optional(Type.String({ maxLength: 128 })), "childSessionKey": Type.Optional(Type.String({ maxLength: 512 })), "nodeIds": Type.Optional(Type.Array(Type.String())), "callSeq": Type.Optional(Type.Integer({ minimum: 1 })), "error": Type.Optional(Type.Object({ "code": Type.Optional(Type.String({ maxLength: 64 })), "message": Type.Optional(Type.String({ maxLength: 4096 })) }, { additionalProperties: false })), "children": Type.Array(This) }, { additionalProperties: false }))
export type Externalagnes_v1_UISpan = Static<typeof Externalagnes_v1_UISpan>

export const RuntimePublic5 = Type.Module({
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
  "Money": Type.Object({ "currency": Type.String(), "scale": Type.Literal(6), "units": Type.String() }, { additionalProperties: false }),
  "ResourceRef": Type.Object({ "resourceId": Type.Ref('Id'), "version": Type.String(), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "ArtifactVersion": Type.Integer({ minimum: 1, maximum: 9007199254740991 }),
  "ArtifactRef": Type.Object({ "artifactId": Type.Ref('Id'), "version": Type.Ref('ArtifactVersion') }, { additionalProperties: false }),
  "Revision": Type.Ref('UInt53'),
  "DomainObjectRef": Type.Object({ "authorityId": Type.Ref('Id'), "typeId": Type.Ref('TypeId'), "id": Type.Ref('Id'), "revision": Type.Ref('Revision') }, { additionalProperties: false }),
  "ToolDeferredRef": Type.Object({ "jobRef": Type.Ref('DomainObjectRef'), "pollAfterMs": Type.Ref('UInt53'), "deadline": Type.Ref('Timestamp') }, { additionalProperties: false }),
  "ToolModelResult": Type.Object({ "output": Type.Ref('DataRef'), "artifacts": Type.Array(Type.Ref('ArtifactRef'), { maxItems: 10000 }), "provenance": Type.Ref('Provenance'), "isError": Type.Optional(Type.Boolean()), "terminate": Type.Optional(Type.Boolean()), "deferred": Type.Optional(Type.Ref('ToolDeferredRef')) }, { additionalProperties: false }),
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
  "SourceRange": Type.Object({ "session": Type.Ref('SessionRef'), "fromSeq": Type.Ref('UInt53'), "toSeq": Type.Ref('UInt53'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "ContextItem": Type.Object({ "id": Type.Ref('Id'), "kind": Type.Union([Type.Literal('message'), Type.Literal('tool-call'), Type.Literal('tool-result'), Type.Literal('skill'), Type.Literal('resource'), Type.Literal('summary'), Type.Literal('memory')]), "body": Type.Ref('DataRef'), "sourceRefs": Type.Array(Type.Ref('PublicRef'), { maxItems: 10000 }), "provenance": Type.Ref('Provenance'), "trust": Type.Union([Type.Literal('system'), Type.Literal('user'), Type.Literal('external'), Type.Literal('derived')]), "tokenEstimate": Type.Ref('UInt53'), "protected": Type.Boolean(), "toolPairRef": Type.Union([Type.Ref('Id'), Type.Null()]), "sourceRanges": Type.Array(Type.Ref('SourceRange'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "ContextView": Type.Object({ "viewId": Type.Ref('Id'), "format": Type.String(), "schema": Type.Ref('SchemaRef'), "baseRevision": Type.Ref('Revision'), "items": Type.Array(Type.Ref('ContextItem'), { maxItems: 10000 }), "tokenEstimate": Type.Ref('UInt53'), "protectedRefs": Type.Array(Type.Ref('PublicRef'), { maxItems: 10000 }), "inputDigest": Type.Ref('Digest'), "digest": Type.Ref('Digest'), "runtimeInstructionRefs": Type.Array(Type.Ref('DataRef'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "ThinkingLevel": Type.Union([Type.Literal('off'), Type.Literal('minimal'), Type.Literal('low'), Type.Literal('medium'), Type.Literal('high'), Type.Literal('xhigh'), Type.Literal('max')]),
  "GenerationOptions": Type.Object({ "maxOutputTokens": Type.Ref('UInt53'), "temperature": Type.Optional(Type.Number()), "seed": Type.Optional(Type.Ref('UInt53')), "thinking": Type.Union([Type.Ref('ThinkingLevel'), Type.Null()]) }, { additionalProperties: false }),
  "ExactQuantity": Type.Object({ "unit": Type.String(), "value": Type.String() }, { additionalProperties: false }),
  "UsageFactRef": Type.Object({ "authorityId": Type.Ref('Id'), "usageId": Type.Ref('Id'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "PricingQuoteInput": Type.Object({ "usageUnits": Type.Array(Type.Ref('ExactQuantity'), { maxItems: 10000 }), "model": Type.String(), "region": Type.Union([Type.String(), Type.Null()]), "priceVersion": Type.Ref('Id'), "currency": Type.String() }, { additionalProperties: false }),
  "PriceLine": Type.Object({ "unit": Type.Ref('Id'), "quantity": Type.String({ minLength: 1, maxLength: 256 }), "unitPrice": Type.Ref('Money'), "amount": Type.Ref('Money'), "ruleId": Type.Ref('Id') }, { additionalProperties: false }),
  "PriceQuote": Type.Object({ "quoteId": Type.Ref('Id'), "priceVersion": Type.Ref('Id'), "inputDigest": Type.Ref('Digest'), "lineItems": Type.Array(Type.Ref('PriceLine'), { maxItems: 10000 }), "amount": Type.Ref('Money'), "rounding": Type.Literal('half-even') }, { additionalProperties: false }),
  "QuestionField": Type.Union([Type.Object({ "id": Type.Ref('Id'), "kind": Type.Literal('text'), "label": Type.String({ maxLength: 8192 }), "required": Type.Boolean(), "multiline": Type.Boolean(), "maxLength": Type.Ref('UInt53') }, { additionalProperties: false }), Type.Object({ "id": Type.Ref('Id'), "kind": Type.Literal('singleChoice'), "label": Type.String({ maxLength: 8192 }), "required": Type.Boolean(), "options": Type.Array(Type.Object({ "id": Type.Ref('Id'), "label": Type.String({ maxLength: 8192 }) }, { additionalProperties: false }), { minItems: 1, maxItems: 10000 }) }, { additionalProperties: false }), Type.Object({ "id": Type.Ref('Id'), "kind": Type.Literal('multiChoice'), "label": Type.String({ maxLength: 8192 }), "required": Type.Boolean(), "options": Type.Array(Type.Object({ "id": Type.Ref('Id'), "label": Type.String({ maxLength: 8192 }) }, { additionalProperties: false }), { minItems: 1, maxItems: 10000 }), "minItems": Type.Ref('UInt53'), "maxItems": Type.Ref('UInt53') }, { additionalProperties: false }), Type.Object({ "id": Type.Ref('Id'), "kind": Type.Literal('confirm'), "label": Type.String({ maxLength: 8192 }), "required": Type.Literal(true), "statement": Type.String({ maxLength: 8192 }) }, { additionalProperties: false }), Type.Object({ "id": Type.Ref('Id'), "kind": Type.Literal('custom'), "label": Type.String({ maxLength: 8192 }), "required": Type.Boolean(), "fieldSchema": Type.Ref('SchemaRef'), "rendererKey": Type.Ref('Id') }, { additionalProperties: false })]),
  "QuestionRequest": Type.Object({ "kind": Type.Literal('question'), "body": Type.String({ maxLength: 262144 }), "answerSchema": Type.Ref('SchemaRef'), "fields": Type.Array(Type.Ref('QuestionField'), { minItems: 0, maxItems: 10000 }), "allowedResponders": Type.Array(Type.Ref('Id'), { minItems: 0, maxItems: 10000 }), "expiresAt": Type.Ref('Timestamp'), "idempotencyKey": Type.Ref('Id'), "title": Type.String({ maxLength: 8192 }) }, { additionalProperties: false }),
  "InteractionRequest": Type.Union([Type.Ref('QuestionRequest'), Type.Ref('ApprovalRequest')]),
  "ApprovalAnswerSchemaRef": Type.Object({ "typeId": Type.Literal('agh.interaction/approval-answer@1'), "revision": Type.Literal(1), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "ApprovalAnswer": Type.Union([Type.Object({ "decision": Type.Literal('approve'), "intentDigest": Type.Ref('Digest'), "grantScope": Type.Union([Type.Literal('once'), Type.Literal('session'), Type.Literal('permanent')]) }, { additionalProperties: false }), Type.Object({ "decision": Type.Literal('deny'), "intentDigest": Type.Ref('Digest') }, { additionalProperties: false })]),
  "ApprovalAnswerDataRef": Type.Union([Type.Object({ "kind": Type.Literal('inline'), "schema": Type.Ref('ApprovalAnswerSchemaRef'), "value": Type.Ref('ApprovalAnswer'), "digest": Type.Ref('Digest'), "bytes": Type.Ref('UInt53') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('blob'), "schema": Type.Ref('ApprovalAnswerSchemaRef'), "blob": Type.Ref('BlobRef') }, { additionalProperties: false })]),
  "InteractionRecord": Type.Union([Type.Object({ "interactionId": Type.Ref('Id'), "owner": Type.Object({ "runId": Type.Ref('Id'), "actionId": Type.Ref('Id') }, { additionalProperties: false }), "request": Type.Ref('InteractionRequest'), "version": Type.Integer({ minimum: 1, maximum: 9007199254740991 }), "createdAt": Type.Ref('Timestamp'), "updatedAt": Type.Ref('Timestamp'), "status": Type.Literal('pending'), "terminationReason": Type.Null(), "resolution": Type.Null() }, { additionalProperties: false }), Type.Object({ "interactionId": Type.Ref('Id'), "owner": Type.Object({ "runId": Type.Ref('Id'), "actionId": Type.Ref('Id') }, { additionalProperties: false }), "request": Type.Ref('ApprovalRequest'), "version": Type.Integer({ minimum: 1, maximum: 9007199254740991 }), "createdAt": Type.Ref('Timestamp'), "updatedAt": Type.Ref('Timestamp'), "status": Type.Literal('answered'), "terminationReason": Type.Null(), "resolution": Type.Object({ "responseId": Type.Ref('Id'), "actorRef": Type.Ref('Id'), "answer": Type.Ref('ApprovalAnswerDataRef'), "committedAt": Type.Ref('Timestamp'), "evidence": Type.Union([Type.Object({ "kind": Type.Literal('human'), "authenticationRef": Type.Ref('DataRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('system'), "policyDecisionRef": Type.Ref('DataRef') }, { additionalProperties: false })]) }, { additionalProperties: false }) }, { additionalProperties: false }), Type.Object({ "interactionId": Type.Ref('Id'), "owner": Type.Object({ "runId": Type.Ref('Id'), "actionId": Type.Ref('Id') }, { additionalProperties: false }), "request": Type.Ref('QuestionRequest'), "version": Type.Integer({ minimum: 1, maximum: 9007199254740991 }), "createdAt": Type.Ref('Timestamp'), "updatedAt": Type.Ref('Timestamp'), "status": Type.Literal('answered'), "terminationReason": Type.Null(), "resolution": Type.Object({ "responseId": Type.Ref('Id'), "actorRef": Type.Ref('Id'), "answer": Type.Ref('DataRef'), "committedAt": Type.Ref('Timestamp'), "evidence": Type.Union([Type.Object({ "kind": Type.Literal('human'), "authenticationRef": Type.Ref('DataRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('system'), "policyDecisionRef": Type.Ref('DataRef') }, { additionalProperties: false })]) }, { additionalProperties: false }) }, { additionalProperties: false }), Type.Object({ "interactionId": Type.Ref('Id'), "owner": Type.Object({ "runId": Type.Ref('Id'), "actionId": Type.Ref('Id') }, { additionalProperties: false }), "request": Type.Ref('InteractionRequest'), "version": Type.Integer({ minimum: 1, maximum: 9007199254740991 }), "createdAt": Type.Ref('Timestamp'), "updatedAt": Type.Ref('Timestamp'), "status": Type.Union([Type.Literal('cancelled'), Type.Literal('expired')]), "terminationReason": Object.assign(Type.String({ minLength: 1 }), {"x-max-utf8-bytes":8192}), "resolution": Type.Null() }, { additionalProperties: false })]),
  "ModelOutput": Type.Object({ "outputRef": Type.Ref('DataRef'), "finishReason": Type.Union([Type.Literal('stop'), Type.Literal('length'), Type.Literal('tool-calls'), Type.Literal('filtered'), Type.Literal('cancelled'), Type.Literal('error')]), "usageFactRefs": Type.Array(Type.Ref('UsageFactRef'), { minItems: 0, maxItems: 10000 }), "providerReceipt": Type.Union([Type.Ref('DataRef'), Type.Null()]), "actualModel": Type.String({ maxLength: 8192 }) }, { additionalProperties: false }),
  "ProviderResponseEvidence": Type.Object({ "status": Type.Optional(Type.Ref('UInt53')), "id": Type.Optional(Type.String({ maxLength: 128 })), "model": Type.Optional(Type.String({ maxLength: 256 })), "headers": Type.Optional(Type.Intersect([Type.Record(Type.String({ pattern: '^[a-z0-9-]{1,64}$' }), Type.String({ maxLength: 256 }), { additionalProperties: false, maxProperties: 16 }), Type.Object({})])), "headerNames": Type.Optional(Type.Array(Type.String({ maxLength: 128 }), { maxItems: 64 })) }, { additionalProperties: false }),
  "RunTaintRecordValue": Type.Object({ "runId": Type.Ref('Id'), "sourceSeq": Type.Ref('UInt53'), "clearedThroughSeq": Type.Ref('UInt53') }, { additionalProperties: false }),
  "TaintSourceIdentity": Type.Union([Type.Object({ "kind": Type.Literal('steer'), "commandId": Type.Ref('Id'), "messageFactId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('tool-result'), "actionId": Type.Ref('Id'), "viewId": Type.Ref('Id'), "sourceReceiptId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('simple-loop-instructions'), "actionId": Type.Ref('Id'), "preparedId": Type.Ref('Id'), "inputDigest": Type.Ref('Digest') }, { additionalProperties: false })]),
  "RunTaintSourceRecordValue": Type.Object({ "runId": Type.Ref('Id'), "sourceId": Type.Ref('Id'), "sourceSeq": Type.Integer({ minimum: 1, maximum: 9007199254740991 }), "identity": Type.Ref('TaintSourceIdentity'), "sourceRefs": Type.Array(Type.Ref('PublicRef'), { maxItems: 10000 }), "sourceDigest": Type.Ref('Digest') }, { additionalProperties: false }),
  "ApprovalTaintAckRecordValue": Type.Object({ "runId": Type.Ref('Id'), "interaction": Type.Ref('DomainReference'), "responseId": Type.Ref('Id'), "actionId": Type.Ref('Id'), "preparationId": Type.Ref('Id'), "policyFactsRef": Type.Ref('DataRef'), "confirmedThroughSeq": Type.Ref('UInt53'), "before": Type.Ref('TaintSnapshot'), "after": Type.Ref('TaintSnapshot') }, { additionalProperties: false }),
  "PolicyDecision": Type.Object({ "decisionId": Type.Ref('Id'), "decision": Type.Union([Type.Literal('allow'), Type.Literal('deny'), Type.Literal('ask')]), "principalRef": Type.Ref('Id'), "scope": Type.Ref('ScopeRef'), "inputDigest": Type.Ref('Digest'), "policyRevision": Type.Ref('Revision'), "factsRef": Type.Ref('DataRef'), "conditions": Type.Ref('DataRef'), "reasonCodes": Type.Array(Type.String(), { maxItems: 10000 }), "approvalSpec": Type.Union([Type.Ref('ApprovalRequest'), Type.Null()]), "validUntil": Type.Ref('Timestamp') }, { additionalProperties: false }),
  "Externalagnes_v1_UIOperationState": Type.Union([Type.Null(), Type.Object({ "turn": Type.Integer(), "step": Type.Integer(), "phase": Type.String({ maxLength: 32 }), "parked": Type.Optional(Type.Object({ "ticket": Type.String(), "expiresAt": Type.String() }, { additionalProperties: false })) }, { additionalProperties: false })]),
  "Externalsession_v1_ContentBlock": Type.Union([Type.Object({ "type": Type.Literal('text'), "text": Type.String({ maxLength: 1048576 }) }, { additionalProperties: false }), Type.Object({ "type": Type.Literal('image'), "data": Type.String(), "mimeType": Type.String({ maxLength: 128 }) }, { additionalProperties: false }), Type.Object({ "type": Type.Literal('resource_link'), "uri": Type.String({ maxLength: 4096 }), "name": Type.Optional(Type.String({ maxLength: 256 })), "mimeType": Type.Optional(Type.String({ maxLength: 128 })) }, { additionalProperties: false })]),
  "Externalagnes_v1_ContentBlock": Type.Ref('Externalsession_v1_ContentBlock'),
  "Externalagnes_v1_JsonValue": Externalsession_v1_JsonValue,
  "Externalagnes_v1_SlotFillView": Type.Object({ "slot": Type.Union([Type.Literal('tool.card.inline'), Type.Literal('sidebar.action'), Type.Literal('status.line'), Type.Literal('notification')]), "extId": Type.String({ maxLength: 128 }), "payload": Type.Ref('Externalagnes_v1_JsonValue'), "requestSeq": Type.Optional(Type.Integer({ minimum: 1 })) }, { additionalProperties: false }),
  "Externalmodel_TokenCounts": Type.Object({ "input": Type.Integer({ minimum: 0 }), "output": Type.Integer({ minimum: 0 }), "cacheRead": Type.Integer({ minimum: 0 }), "cacheWrite": Type.Integer({ minimum: 0 }), "reasoning": Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }),
  "Externalsession_v1_Billing": Type.Object({ "usdMicros": Type.Integer({ minimum: 0 }), "source": Type.Union([Type.Literal('gateway'), Type.Literal('estimated')]), "subscription": Type.Boolean() }, { additionalProperties: false }),
  "Externalsession_v1_ArtifactRef": Type.Object({ "sha256": Type.String({ pattern: "^[0-9a-f]{64}$" }), "size": Type.Integer({ minimum: 0 }), "mime": Type.String({ maxLength: 128 }) }, { additionalProperties: false }),
  "Externalagnes_v1_ArtifactRef": Type.Ref('Externalsession_v1_ArtifactRef'),
  "Externalagnes_v1_UINode": Type.Union([Type.Object({ "kind": Type.Literal('user'), "id": Type.String(), "seq": Type.Integer(), "content": Type.Array(Type.Ref('Externalagnes_v1_ContentBlock')), "actorLabel": Type.Optional(Type.String({ maxLength: 128 })) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('assistant'), "id": Type.String(), "seq": Type.Integer(), "text": Type.String(), "thinking": Type.Optional(Type.String()), "streaming": Type.Optional(Type.Boolean()), "effectId": Type.Optional(Type.String({ maxLength: 128 })), "lostChars": Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('tool'), "id": Type.String(), "seq": Type.Integer(), "toolUseId": Type.String(), "name": Type.String(), "status": Type.Union([Type.Literal('planned'), Type.Literal('awaiting_approval'), Type.Literal('running'), Type.Literal('completed'), Type.Literal('failed'), Type.Literal('cancelled')]), "summary": Type.String({ maxLength: 512 }), "argsPreview": Type.Optional(Type.String({ maxLength: 2048 })), "resultPreview": Type.Optional(Type.String({ maxLength: 4096 })), "resultSeq": Type.Optional(Type.Integer({ minimum: 1 })), "enforcement": Type.Optional(Type.Object({ "level": Type.Union([Type.Literal('full'), Type.Literal('partial'), Type.Literal('none')]), "scope": Type.Array(Type.Union([Type.Literal('file'), Type.Literal('network'), Type.Literal('process')])) }, { additionalProperties: false })), "depth": Type.Optional(Type.Integer({ minimum: 0 })), "children": Type.Optional(Type.Array(Type.String())), "slots": Type.Optional(Type.Array(Type.Ref('Externalagnes_v1_SlotFillView'))) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('approval'), "id": Type.String(), "seq": Type.Integer(), "state": Type.Union([Type.Literal('pending'), Type.Literal('decided'), Type.Literal('expired')]), "summary": Type.String({ maxLength: 4096 }), "risk": Type.Union([Type.Literal('destructive'), Type.Literal('always'), Type.Literal('budget'), Type.Literal('unknown')]), "options": Type.Array(Type.Union([Type.Literal('allow_once'), Type.Literal('allow_always'), Type.Literal('allow_permanent'), Type.Literal('reject_once')])), "ticket": Type.Optional(Type.String()), "expiresAt": Type.Optional(Type.String()), "requestSeq": Type.Optional(Type.Integer()), "decision": Type.Optional(Type.Object({ "verdict": Type.String(), "via": Type.String(), "byLabel": Type.Optional(Type.String()) }, { additionalProperties: false })) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('cost'), "id": Type.String(), "seq": Type.Integer(), "credits": Type.Optional(Type.Number()), "source": Type.Union([Type.Literal('gateway'), Type.Literal('estimated')]), "purpose": Type.Optional(Type.String()), "tokens": Type.Optional(Type.Ref('Externalmodel_TokenCounts')), "billing": Type.Optional(Type.Ref('Externalsession_v1_Billing')), "model": Type.Optional(Type.String({ maxLength: 256 })), "interrupted": Type.Optional(Type.Boolean()), "timing": Type.Optional(Type.Object({ "ttftMs": Type.Optional(Type.Integer({ minimum: 0 })), "durationMs": Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false })) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('artifact'), "id": Type.String(), "seq": Type.Integer(), "name": Type.String({ maxLength: 256 }), "ref": Type.Ref('Externalagnes_v1_ArtifactRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('compaction'), "id": Type.String(), "seq": Type.Integer(), "range": Type.Array(Type.Integer(), { minItems: 2, maxItems: 2 }), "tokensBefore": Type.Optional(Type.Integer()), "tokensAfter": Type.Optional(Type.Integer()), "summary": Type.Optional(Type.String()), "customInstructions": Type.Optional(Type.String()) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('slot'), "id": Type.String(), "seq": Type.Optional(Type.Integer()), "fill": Type.Ref('Externalagnes_v1_SlotFillView') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('context-sections'), "id": Type.String(), "seq": Type.Integer(), "sections": Type.Array(Type.Object({ "id": Type.String({ maxLength: 256 }), "order": Type.Integer(), "source": Type.String({ maxLength: 256 }), "tokens": Type.Integer({ minimum: 0 }) }, { additionalProperties: false })) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('contribute-conflict'), "id": Type.String(), "seq": Type.Integer(), "key": Type.String({ maxLength: 256 }), "ops": Type.Array(Type.String({ maxLength: 128 })) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('context'), "id": Type.String(), "seq": Type.Integer(), "text": Type.String() }, { additionalProperties: false })]),
  "Externalagnes_v1_UITurnCall": Type.Object({ "id": Type.String({ maxLength: 128 }), "seq": Type.Integer({ minimum: 1 }), "purpose": Type.Union([Type.Literal('inference'), Type.Literal('compaction'), Type.Literal('verifier'), Type.Literal('subagent'), Type.Literal('media'), Type.Literal('tool'), Type.Literal('title'), Type.Literal('approval-guardian')]), "model": Type.String({ maxLength: 256 }), "tokens": Type.Optional(Type.Ref('Externalmodel_TokenCounts')), "credits": Type.Optional(Type.Number({ minimum: 0 })), "creditSource": Type.Union([Type.Literal('gateway'), Type.Literal('estimated')]), "billing": Type.Optional(Type.Ref('Externalsession_v1_Billing')), "interrupted": Type.Optional(Type.Boolean()), "timing": Type.Optional(Type.Object({ "ttftMs": Type.Optional(Type.Integer({ minimum: 0 })), "durationMs": Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false })), "adjustment": Type.Optional(Type.Object({ "of": Type.Integer({ minimum: 1 }), "delta": Type.Number(), "usdMicrosDelta": Type.Optional(Type.Integer()), "reason": Type.String({ maxLength: 512 }) }, { additionalProperties: false })) }, { additionalProperties: false }),
  "Externalagnes_v1_UITurnUsage": Type.Object({ "totals": Type.Object({ "input": Type.Integer({ minimum: 0 }), "output": Type.Integer({ minimum: 0 }), "cacheRead": Type.Integer({ minimum: 0 }), "cacheWrite": Type.Integer({ minimum: 0 }), "reasoning": Type.Integer({ minimum: 0 }) }, { additionalProperties: false }), "cost": Type.Optional(Type.Ref('Externalsession_v1_Billing')), "credits": Type.Optional(Type.Object({ "amount": Type.Number({ minimum: 0 }), "source": Type.Union([Type.Literal('gateway'), Type.Literal('estimated')]), "complete": Type.Boolean() }, { additionalProperties: false })), "reasoningComplete": Type.Boolean(), "billingComplete": Type.Boolean(), "calls": Type.Array(Type.Ref('Externalagnes_v1_UITurnCall')) }, { additionalProperties: false }),
  "Externalagnes_v1_UITurn": Type.Object({ "id": Type.String({ maxLength: 128 }), "turn": Type.Integer({ minimum: 1 }), "startSeq": Type.Integer({ minimum: 1 }), "endSeq": Type.Optional(Type.Integer({ minimum: 1 })), "startedAt": Type.String({ format: "date-time" }), "endedAt": Type.Optional(Type.String({ format: "date-time" })), "durationMs": Type.Optional(Type.Integer({ minimum: 0 })), "status": Type.Union([Type.Literal('running'), Type.Literal('waiting'), Type.Literal('completed'), Type.Literal('failed'), Type.Literal('cancelled')]), "reason": Type.Optional(Type.Union([Type.Literal('completed'), Type.Literal('aborted'), Type.Literal('error'), Type.Literal('parked'), Type.Literal('blocked'), Type.Literal('budget'), Type.Literal('max_steps'), Type.Literal('interrupted')])), "error": Type.Optional(Type.Object({ "code": Type.String({ maxLength: 64 }), "message": Type.String({ maxLength: 4096 }) }, { additionalProperties: false })), "nodeIds": Type.Array(Type.String()), "finalAssistantId": Type.Optional(Type.String()), "finalModel": Type.Optional(Type.String({ maxLength: 256 })), "usage": Type.Ref('Externalagnes_v1_UITurnUsage'), "inherited": Type.Boolean(), "forkable": Type.Boolean(), "trace": Type.Optional(Externalagnes_v1_UISpan) }, { additionalProperties: false }),
  "Externalsession_v1_BudgetState": Type.Union([Type.Null(), Type.Object({ "slot": Type.String({ maxLength: 32 }), "escalate": Type.Boolean(), "creditsUsed": Type.Number({ minimum: 0 }), "creditsCap": Type.Union([Type.Number({ minimum: 0 }), Type.Null()]), "lastPreflight": Type.Optional(Type.Object({ "tokens": Type.Integer({ minimum: 0 }), "source": Type.Union([Type.Literal('count'), Type.Literal('estimate')]), "boundHash": Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" })), "at": Type.Optional(Type.String()), "seq": Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false })) }, { additionalProperties: false })]),
  "Externalagnes_v1_BudgetState": Type.Ref('Externalsession_v1_BudgetState'),
  "Externalmodel_ThinkingLevel": Type.Union([Type.Literal('off'), Type.Literal('minimal'), Type.Literal('low'), Type.Literal('medium'), Type.Literal('high'), Type.Literal('xhigh'), Type.Literal('max')]),
  "Externalmodel_ModelSettings": Type.Object({ "thinking": Type.Optional(Type.Ref('Externalmodel_ThinkingLevel')), "contextWindow": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })) }, { additionalProperties: false }),
  "Externalagnes_v1_UsageView": Type.Object({ "totals": Type.Object({ "input": Type.Integer({ minimum: 0 }), "output": Type.Integer({ minimum: 0 }), "cacheRead": Type.Integer({ minimum: 0 }), "cacheWrite": Type.Integer({ minimum: 0 }), "reasoning": Type.Integer({ minimum: 0 }) }, { additionalProperties: false }), "cost": Type.Optional(Type.Ref('Externalsession_v1_Billing')), "credits": Type.Optional(Type.Object({ "amount": Type.Number({ minimum: 0 }), "source": Type.Union([Type.Literal('gateway'), Type.Literal('estimated')]), "complete": Type.Boolean() }, { additionalProperties: false })), "reasoningComplete": Type.Optional(Type.Boolean()), "billingComplete": Type.Optional(Type.Boolean()), "context": Type.Object({ "tokens": Type.Integer({ minimum: 0 }), "window": Type.Integer({ minimum: 1 }), "autoCompact": Type.Boolean(), "source": Type.Optional(Type.Literal('estimated')) }, { additionalProperties: false }), "model": Type.Object({ "settings": Type.Optional(Type.Ref('Externalmodel_ModelSettings')), "route": Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,63}$" }), "id": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001F\\u007F-\\u009F\\u2028\\u2029]+$" }), "thinking": Type.Ref('Externalmodel_ThinkingLevel'), "maxTokens": Type.Optional(Type.Integer({ minimum: 1 })) }, { additionalProperties: false }), "cache": Type.Optional(Type.Object({ "hitRate": Type.Optional(Type.Number({ minimum: 0, maximum: 1 })), "lastInvalidation": Type.Optional(Type.Object({ "seq": Type.Integer({ minimum: 1 }), "reprocessedTokens": Type.Integer({ minimum: 0 }), "cause": Type.Union([Type.Literal('compaction'), Type.Literal('system-changed'), Type.Literal('history-changed')]) }, { additionalProperties: false })) }, { additionalProperties: false })) }, { additionalProperties: false }),
  "Externalagnes_v1_UITimeline": Type.Object({ "yolo": Type.Optional(Type.Boolean()), "sessionId": Type.String(), "upto": Type.Integer({ minimum: 0 }), "generation": Type.Integer({ minimum: 1 }), "opState": Type.Ref('Externalagnes_v1_UIOperationState'), "nodes": Type.Array(Type.Ref('Externalagnes_v1_UINode')), "turns": Type.Array(Type.Ref('Externalagnes_v1_UITurn')), "budget": Type.Optional(Type.Ref('Externalagnes_v1_BudgetState')), "usage": Type.Optional(Type.Ref('Externalagnes_v1_UsageView')) }, { additionalProperties: false }),
  "Externalagnes_v1_UIHistoryCursor": Type.String({ minLength: 1, maxLength: 2048 }),
  "Externalagnes_v1_UIHistoryInfo": Type.Union([Type.Object({ "hasEarlier": Type.Literal(true), "cursor": Type.Ref('Externalagnes_v1_UIHistoryCursor'), "startIndex": Type.Integer({ minimum: 0, maximum: 9007199254740991 }), "totalNodes": Type.Integer({ minimum: 0, maximum: 9007199254740991 }) }, { additionalProperties: false }), Type.Object({ "hasEarlier": Type.Literal(false), "startIndex": Type.Integer({ minimum: 0, maximum: 9007199254740991 }), "totalNodes": Type.Integer({ minimum: 0, maximum: 9007199254740991 }) }, { additionalProperties: false })]),
  "Externalagnes_v1_UIOpeningResult": Type.Object({ "timeline": Type.Ref('Externalagnes_v1_UITimeline'), "history": Type.Ref('Externalagnes_v1_UIHistoryInfo') }, { additionalProperties: false }),
  "UIOpeningResult": Type.Ref('Externalagnes_v1_UIOpeningResult'),
  "Externalagnes_v1_SessionBudgetResult": Type.Object({ "state": Type.Union([Type.Ref('Externalagnes_v1_BudgetState'), Type.Null()]), "ledger": Type.Array(Type.Object({ "credits": Type.Optional(Type.Number()), "creditSource": Type.Union([Type.Literal('gateway'), Type.Literal('estimated')]), "purpose": Type.Optional(Type.String()), "seq": Type.Integer({ minimum: 1 }) }, { additionalProperties: false }), { maxItems: 200 }) }, { additionalProperties: false }),
  "SessionBudgetResult": Type.Ref('Externalagnes_v1_SessionBudgetResult'),
  "Externalagnes_v1_ApprovalGrantRecord": Type.Object({ "grantId": Type.String({ minLength: 1, maxLength: 128 }), "profileHash": Type.String({ pattern: "^sha256-[a-f0-9]{64}$" }), "actorId": Type.String({ minLength: 1, maxLength: 256 }), "actorOrg": Type.String({ minLength: 1, maxLength: 256 }), "toolId": Type.String({ minLength: 1, maxLength: 128 }), "scope": Type.String({ minLength: 1, maxLength: 256 }), "policyVersion": Type.String({ minLength: 1, maxLength: 64 }), "createdAt": Type.String({ format: "date-time" }), "revokedAt": Type.Optional(Type.String({ format: "date-time" })) }, { additionalProperties: false }),
  "Externalagnes_v1_ApprovalGrantListResult": Type.Object({ "grants": Type.Array(Type.Ref('Externalagnes_v1_ApprovalGrantRecord')) }, { additionalProperties: false }),
  "ApprovalGrantListResult": Type.Ref('Externalagnes_v1_ApprovalGrantListResult'),
  "ApprovalGrantRecord": Type.Ref('Externalagnes_v1_ApprovalGrantRecord'),
  "Externaljobs_ContentBlock": Type.Ref('Externalsession_v1_ContentBlock'),
  "Externaljobs_JsonValue": Externalsession_v1_JsonValue,
  "Externaljobs_Schedule": Type.Union([Type.Object({ "kind": Type.Literal('once') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('at'), "at": Type.Integer({ minimum: 0 }) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('every'), "everyMs": Type.Integer({ minimum: 1000 }), "anchorMs": Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('cron'), "expr": Type.String({ maxLength: 128 }), "tz": Type.Optional(Type.String({ maxLength: 64 })), "staggerMs": Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false })]),
  "Externaljobs_JobSpec": Type.Object({ "idempotencyKey": Type.String({ maxLength: 256 }), "sessionKey": Type.String({ maxLength: 512 }), "payload": Type.Union([Type.Object({ "prompt": Type.Union([Type.String({ maxLength: 65536 }), Type.Array(Type.Ref('Externaljobs_ContentBlock'))]), "delivery": Type.Optional(Type.Union([Type.Literal('steer'), Type.Literal('follow_up')])) }, { additionalProperties: false }), Type.Object({ "command": Type.Object({ "method": Type.String({ pattern: "^(?:resume|_agnes/v1/[A-Za-z][A-Za-z0-9./_-]*)$" }), "params": Type.Ref('Externaljobs_JsonValue') }, { additionalProperties: false }) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('directory.sync'), "channel": Type.String({ minLength: 1, maxLength: 64 }) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('shell'), "command": Type.String({ maxLength: 65536 }), "cwd": Type.String({ maxLength: 4096 }) }, { additionalProperties: false })]), "schedule": Type.Ref('Externaljobs_Schedule'), "budget": Type.Optional(Type.Number({ minimum: 0 })), "protected": Type.Optional(Type.Boolean()), "maxAttempts": Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) }, { additionalProperties: false }),
  "Externalagnes_v1_JobSpec": Type.Ref('Externaljobs_JobSpec'),
  "JobSpec": Type.Ref('Externalagnes_v1_JobSpec'),
  "Externaljobs_JobStatus": Type.Object({ "jobId": Type.String(), "status": Type.Union([Type.Literal('waiting'), Type.Literal('delayed'), Type.Literal('active'), Type.Literal('completed'), Type.Literal('failed'), Type.Literal('dead'), Type.Literal('cancelled')]), "attempts": Type.Integer({ minimum: 0 }), "delayUntil": Type.Optional(Type.Integer({ minimum: 0 })), "leaseUntil": Type.Optional(Type.Integer({ minimum: 0 })), "stalledCounter": Type.Optional(Type.Integer({ minimum: 0 })), "result": Type.Optional(Type.Ref('Externaljobs_JsonValue')), "error": Type.Optional(Type.Object({ "code": Type.String(), "message": Type.String() }, { additionalProperties: false })), "createdAt": Type.String({ format: "date-time" }), "updatedAt": Type.String({ format: "date-time" }) }, { additionalProperties: false }),
  "Externalagnes_v1_JobStatus": Type.Ref('Externaljobs_JobStatus'),
  "JobStatus": Type.Ref('Externalagnes_v1_JobStatus'),
  "Externalextension_manifest_SkinTokenValue": Type.String({ minLength: 1, maxLength: 256, pattern: "^(?!.*url\\()[^;{}@]*$" }),
  "Externalextension_manifest_SkinContribution": Type.Object({ "id": Type.String({ minLength: 1, maxLength: 64, pattern: "^(?!(?:light|dark|system|none)$)[a-z0-9]+(?:-[a-z0-9]+)*$" }), "name": Type.String({ minLength: 1, maxLength: 64 }), "css": Type.String({ minLength: 3, maxLength: 256, pattern: "^\\./" }), "tokens": Type.Optional(Type.Intersect([Type.Record(Type.String(), Type.Object({ "light": Type.Ref('Externalextension_manifest_SkinTokenValue'), "dark": Type.Ref('Externalextension_manifest_SkinTokenValue') }, { additionalProperties: false })), Type.Object({})])) }, { additionalProperties: false }),
  "SkinContribution": Type.Ref('Externalextension_manifest_SkinContribution'),
  "SimpleModelRequest": Type.Object({ "routeId": Type.Optional(Type.Ref('Id')), "instructions": Type.Optional(Type.Array(Type.String({ maxLength: 8192 }), { minItems: 0, maxItems: 10000 })), "outputSchema": Type.Optional(Type.Ref('SchemaRef')), "toolNames": Type.Optional(Type.Array(Type.String({ maxLength: 256 }), { minItems: 0, maxItems: 10000 })), "generation": Type.Optional(Type.Ref('GenerationOptions')) }, { additionalProperties: false }),
  "SimpleToolRequest": Type.Object({ "name": Type.Ref('Id'), "input": JsonValue }, { additionalProperties: false }),
  "SimpleVisibleResult": Type.Union([Type.Object({ "status": Type.Literal('succeeded'), "receipt": Type.Ref('ActionResultView'), "value": JsonValue }, { additionalProperties: false }), Type.Object({ "status": Type.Union([Type.Literal('failed'), Type.Literal('cancelled'), Type.Literal('unknown_effect')]), "receipt": Type.Union([Type.Ref('ActionResultView'), Type.Null()]), "error": Type.Ref('RuntimeError') }, { additionalProperties: false })]),
  "SimpleModelObservation": Type.Object({ "kind": Type.Literal('model'), "result": Type.Ref('SimpleVisibleResult'), "output": Type.Union([Type.Ref('ModelOutput'), Type.Null()]), "content": JsonValue }, { additionalProperties: false }),
  "SimpleSignal": Type.Object({ "signalId": Type.Ref('Id'), "typeId": Type.Ref('TypeId'), "seq": Type.Ref('UInt53'), "payload": JsonValue }, { additionalProperties: false }),
  "SimpleObservation": Type.Union([Type.Object({ "kind": Type.Literal('start') }, { additionalProperties: false }), Type.Ref('SimpleModelObservation'), Type.Object({ "kind": Type.Literal('tools'), "results": Type.Array(Type.Object({ "request": Type.Ref('SimpleToolRequest'), "result": Type.Ref('SimpleVisibleResult'), "output": Type.Union([Type.Ref('ToolModelResult'), Type.Null()]), "content": JsonValue }, { additionalProperties: false }), { minItems: 1, maxItems: 10000 }) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('question'), "interaction": Type.Union([Type.Union([Type.Object({ "interactionId": Type.Ref('Id'), "owner": Type.Object({ "runId": Type.Ref('Id'), "actionId": Type.Ref('Id') }, { additionalProperties: false }), "request": Type.Ref('InteractionRequest'), "version": Type.Ref('UInt53'), "createdAt": Type.Ref('Timestamp'), "updatedAt": Type.Ref('Timestamp'), "status": Type.Literal('answered'), "terminationReason": Type.Union([Type.String({ maxLength: 8192 }), Type.Null()]), "resolution": Type.Object({ "responseId": Type.Ref('Id'), "actorRef": Type.Ref('Id'), "answer": Type.Ref('DataRef'), "committedAt": Type.Ref('Timestamp'), "evidence": Type.Union([Type.Object({ "kind": Type.Literal('human'), "authenticationRef": Type.Ref('DataRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('system'), "policyDecisionRef": Type.Ref('DataRef') }, { additionalProperties: false })]) }, { additionalProperties: false }) }, { additionalProperties: false }), Type.Object({ "interactionId": Type.Ref('Id'), "owner": Type.Object({ "runId": Type.Ref('Id'), "actionId": Type.Ref('Id') }, { additionalProperties: false }), "request": Type.Ref('InteractionRequest'), "version": Type.Ref('UInt53'), "createdAt": Type.Ref('Timestamp'), "updatedAt": Type.Ref('Timestamp'), "status": Type.Union([Type.Literal('cancelled'), Type.Literal('expired')]), "terminationReason": Type.Union([Type.String({ maxLength: 8192 }), Type.Null()]), "resolution": Type.Null() }, { additionalProperties: false })])]), "answer": JsonValue }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('wake'), "signals": Type.Array(Type.Ref('SimpleSignal'), { minItems: 0, maxItems: 10000 }) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('stop-continued'), "note": Type.String({ maxLength: 8192 }) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('unavailable'), "phase": Type.Union([Type.Literal('context'), Type.Literal('model-prepare'), Type.Literal('tools-prepare'), Type.Literal('question-create')]), "error": Type.Ref('RuntimeError') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('cancel-requested'), "reason": Type.String({ maxLength: 8192 }) }, { additionalProperties: false })]),
  "SimpleDecisionObservation": Type.Union([Type.Object({ "kind": Type.Literal('none') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('decision'), "result": Type.Ref('SimpleVisibleResult'), "output": Type.Union([Type.Ref('ModelOutput'), Type.Null()]), "content": JsonValue }, { additionalProperties: false })]),
  "SimpleContextValue": Type.Object({ "view": Type.Ref('ContextView'), "values": Type.Array(Type.Object({ "itemId": Type.Ref('Id'), "body": JsonValue }, { additionalProperties: false }), { minItems: 0, maxItems: 10000 }) }, { additionalProperties: false }),
})

export const Id = RuntimePublic5.Import('Id')
export type Id = Static<typeof Id>
export const UInt53 = RuntimePublic5.Import('UInt53')
export type UInt53 = Static<typeof UInt53>
export const Timestamp = RuntimePublic5.Import('Timestamp')
export type Timestamp = Static<typeof Timestamp>
export const TypeId = RuntimePublic5.Import('TypeId')
export type TypeId = Static<typeof TypeId>
export const Digest = RuntimePublic5.Import('Digest')
export type Digest = Static<typeof Digest>
export const SchemaRef = RuntimePublic5.Import('SchemaRef')
export type SchemaRef = Static<typeof SchemaRef>
export const BlobRef = RuntimePublic5.Import('BlobRef')
export type BlobRef = Static<typeof BlobRef>
export const DataRef = RuntimePublic5.Import('DataRef')
export type DataRef = Static<typeof DataRef>
export const RuntimeErrorCode = RuntimePublic5.Import('RuntimeErrorCode')
export type RuntimeErrorCode = Static<typeof RuntimeErrorCode>
export const OwnerRef = RuntimePublic5.Import('OwnerRef')
export type OwnerRef = Static<typeof OwnerRef>
export const RetryAdvice = RuntimePublic5.Import('RetryAdvice')
export type RetryAdvice = Static<typeof RetryAdvice>
export const RuntimeError = RuntimePublic5.Import('RuntimeError')
export type RuntimeError = Static<typeof RuntimeError>
export const ExternalRequestRef = RuntimePublic5.Import('ExternalRequestRef')
export type ExternalRequestRef = Static<typeof ExternalRequestRef>
export const RetentionRef = RuntimePublic5.Import('RetentionRef')
export type RetentionRef = Static<typeof RetentionRef>
export const BindingRef = RuntimePublic5.Import('BindingRef')
export type BindingRef = Static<typeof BindingRef>
export const Provenance = RuntimePublic5.Import('Provenance')
export type Provenance = Static<typeof Provenance>
export const ActionResultView = RuntimePublic5.Import('ActionResultView')
export type ActionResultView = Static<typeof ActionResultView>
export const StateAuthorityRef = RuntimePublic5.Import('StateAuthorityRef')
export type StateAuthorityRef = Static<typeof StateAuthorityRef>
export const HookEventName = RuntimePublic5.Import('HookEventName')
export type HookEventName = Static<typeof HookEventName>
export const HookResultSet = RuntimePublic5.Import('HookResultSet')
export type HookResultSet = Static<typeof HookResultSet>
export const ScopeRef = RuntimePublic5.Import('ScopeRef')
export type ScopeRef = Static<typeof ScopeRef>
export const ApprovalRequest = RuntimePublic5.Import('ApprovalRequest')
export type ApprovalRequest = Static<typeof ApprovalRequest>
export const DomainReference = RuntimePublic5.Import('DomainReference')
export type DomainReference = Static<typeof DomainReference>
export const Money = RuntimePublic5.Import('Money')
export type Money = Static<typeof Money>
export const ResourceRef = RuntimePublic5.Import('ResourceRef')
export type ResourceRef = Static<typeof ResourceRef>
export const ArtifactVersion = RuntimePublic5.Import('ArtifactVersion')
export type ArtifactVersion = Static<typeof ArtifactVersion>
export const ArtifactRef = RuntimePublic5.Import('ArtifactRef')
export type ArtifactRef = Static<typeof ArtifactRef>
export const Revision = RuntimePublic5.Import('Revision')
export type Revision = Static<typeof Revision>
export const DomainObjectRef = RuntimePublic5.Import('DomainObjectRef')
export type DomainObjectRef = Static<typeof DomainObjectRef>
export const ToolDeferredRef = RuntimePublic5.Import('ToolDeferredRef')
export type ToolDeferredRef = Static<typeof ToolDeferredRef>
export const ToolModelResult = RuntimePublic5.Import('ToolModelResult')
export type ToolModelResult = Static<typeof ToolModelResult>
export const TaintSnapshot = RuntimePublic5.Import('TaintSnapshot')
export type TaintSnapshot = Static<typeof TaintSnapshot>
export const SessionRef = RuntimePublic5.Import('SessionRef')
export type SessionRef = Static<typeof SessionRef>
export const RunRef = RuntimePublic5.Import('RunRef')
export type RunRef = Static<typeof RunRef>
export const InteractionRef = RuntimePublic5.Import('InteractionRef')
export type InteractionRef = Static<typeof InteractionRef>
export const PublicBlobReference = RuntimePublic5.Import('PublicBlobReference')
export type PublicBlobReference = Static<typeof PublicBlobReference>
export const UploadSession = RuntimePublic5.Import('UploadSession')
export type UploadSession = Static<typeof UploadSession>
export const PublicUploadReference = RuntimePublic5.Import('PublicUploadReference')
export type PublicUploadReference = Static<typeof PublicUploadReference>
export const StagedBlobRef = RuntimePublic5.Import('StagedBlobRef')
export type StagedBlobRef = Static<typeof StagedBlobRef>
export const PublicStagedBlobReference = RuntimePublic5.Import('PublicStagedBlobReference')
export type PublicStagedBlobReference = Static<typeof PublicStagedBlobReference>
export const PublicRef = RuntimePublic5.Import('PublicRef')
export type PublicRef = Static<typeof PublicRef>
export const SourceRange = RuntimePublic5.Import('SourceRange')
export type SourceRange = Static<typeof SourceRange>
export const ContextItem = RuntimePublic5.Import('ContextItem')
export type ContextItem = Static<typeof ContextItem>
export const ContextView = RuntimePublic5.Import('ContextView')
export type ContextView = Static<typeof ContextView>
export const ThinkingLevel = RuntimePublic5.Import('ThinkingLevel')
export type ThinkingLevel = Static<typeof ThinkingLevel>
export const GenerationOptions = RuntimePublic5.Import('GenerationOptions')
export type GenerationOptions = Static<typeof GenerationOptions>
export const ExactQuantity = RuntimePublic5.Import('ExactQuantity')
export type ExactQuantity = Static<typeof ExactQuantity>
export const UsageFactRef = RuntimePublic5.Import('UsageFactRef')
export type UsageFactRef = Static<typeof UsageFactRef>
export const PricingQuoteInput = RuntimePublic5.Import('PricingQuoteInput')
export type PricingQuoteInput = Static<typeof PricingQuoteInput>
export const PriceLine = RuntimePublic5.Import('PriceLine')
export type PriceLine = Static<typeof PriceLine>
export const PriceQuote = RuntimePublic5.Import('PriceQuote')
export type PriceQuote = Static<typeof PriceQuote>
export const QuestionField = RuntimePublic5.Import('QuestionField')
export type QuestionField = Static<typeof QuestionField>
export const QuestionRequest = RuntimePublic5.Import('QuestionRequest')
export type QuestionRequest = Static<typeof QuestionRequest>
export const InteractionRequest = RuntimePublic5.Import('InteractionRequest')
export type InteractionRequest = Static<typeof InteractionRequest>
export const ApprovalAnswerSchemaRef = RuntimePublic5.Import('ApprovalAnswerSchemaRef')
export type ApprovalAnswerSchemaRef = Static<typeof ApprovalAnswerSchemaRef>
export const ApprovalAnswer = RuntimePublic5.Import('ApprovalAnswer')
export type ApprovalAnswer = Static<typeof ApprovalAnswer>
export const ApprovalAnswerDataRef = RuntimePublic5.Import('ApprovalAnswerDataRef')
export type ApprovalAnswerDataRef = Static<typeof ApprovalAnswerDataRef>
export const InteractionRecord = RuntimePublic5.Import('InteractionRecord')
export type InteractionRecord = Static<typeof InteractionRecord>
export const ModelOutput = RuntimePublic5.Import('ModelOutput')
export type ModelOutput = Static<typeof ModelOutput>
export const ProviderResponseEvidence = RuntimePublic5.Import('ProviderResponseEvidence')
export type ProviderResponseEvidence = Static<typeof ProviderResponseEvidence>
export const RunTaintRecordValue = RuntimePublic5.Import('RunTaintRecordValue')
export type RunTaintRecordValue = Static<typeof RunTaintRecordValue>
export const TaintSourceIdentity = RuntimePublic5.Import('TaintSourceIdentity')
export type TaintSourceIdentity = Static<typeof TaintSourceIdentity>
export const RunTaintSourceRecordValue = RuntimePublic5.Import('RunTaintSourceRecordValue')
export type RunTaintSourceRecordValue = Static<typeof RunTaintSourceRecordValue>
export const ApprovalTaintAckRecordValue = RuntimePublic5.Import('ApprovalTaintAckRecordValue')
export type ApprovalTaintAckRecordValue = Static<typeof ApprovalTaintAckRecordValue>
export const PolicyDecision = RuntimePublic5.Import('PolicyDecision')
export type PolicyDecision = Static<typeof PolicyDecision>
export const Externalagnes_v1_UIOperationState = RuntimePublic5.Import('Externalagnes_v1_UIOperationState')
export type Externalagnes_v1_UIOperationState = Static<typeof Externalagnes_v1_UIOperationState>
export const Externalsession_v1_ContentBlock = RuntimePublic5.Import('Externalsession_v1_ContentBlock')
export type Externalsession_v1_ContentBlock = Static<typeof Externalsession_v1_ContentBlock>
export const Externalagnes_v1_ContentBlock = RuntimePublic5.Import('Externalagnes_v1_ContentBlock')
export type Externalagnes_v1_ContentBlock = Static<typeof Externalagnes_v1_ContentBlock>
export const Externalagnes_v1_JsonValue = RuntimePublic5.Import('Externalagnes_v1_JsonValue')
export type Externalagnes_v1_JsonValue = Static<typeof Externalagnes_v1_JsonValue>
export const Externalagnes_v1_SlotFillView = RuntimePublic5.Import('Externalagnes_v1_SlotFillView')
export type Externalagnes_v1_SlotFillView = Static<typeof Externalagnes_v1_SlotFillView>
export const Externalmodel_TokenCounts = RuntimePublic5.Import('Externalmodel_TokenCounts')
export type Externalmodel_TokenCounts = Static<typeof Externalmodel_TokenCounts>
export const Externalsession_v1_Billing = RuntimePublic5.Import('Externalsession_v1_Billing')
export type Externalsession_v1_Billing = Static<typeof Externalsession_v1_Billing>
export const Externalsession_v1_ArtifactRef = RuntimePublic5.Import('Externalsession_v1_ArtifactRef')
export type Externalsession_v1_ArtifactRef = Static<typeof Externalsession_v1_ArtifactRef>
export const Externalagnes_v1_ArtifactRef = RuntimePublic5.Import('Externalagnes_v1_ArtifactRef')
export type Externalagnes_v1_ArtifactRef = Static<typeof Externalagnes_v1_ArtifactRef>
export const Externalagnes_v1_UINode = RuntimePublic5.Import('Externalagnes_v1_UINode')
export type Externalagnes_v1_UINode = Static<typeof Externalagnes_v1_UINode>
export const Externalagnes_v1_UITurnCall = RuntimePublic5.Import('Externalagnes_v1_UITurnCall')
export type Externalagnes_v1_UITurnCall = Static<typeof Externalagnes_v1_UITurnCall>
export const Externalagnes_v1_UITurnUsage = RuntimePublic5.Import('Externalagnes_v1_UITurnUsage')
export type Externalagnes_v1_UITurnUsage = Static<typeof Externalagnes_v1_UITurnUsage>
export const Externalagnes_v1_UITurn = RuntimePublic5.Import('Externalagnes_v1_UITurn')
export type Externalagnes_v1_UITurn = Static<typeof Externalagnes_v1_UITurn>
export const Externalsession_v1_BudgetState = RuntimePublic5.Import('Externalsession_v1_BudgetState')
export type Externalsession_v1_BudgetState = Static<typeof Externalsession_v1_BudgetState>
export const Externalagnes_v1_BudgetState = RuntimePublic5.Import('Externalagnes_v1_BudgetState')
export type Externalagnes_v1_BudgetState = Static<typeof Externalagnes_v1_BudgetState>
export const Externalmodel_ThinkingLevel = RuntimePublic5.Import('Externalmodel_ThinkingLevel')
export type Externalmodel_ThinkingLevel = Static<typeof Externalmodel_ThinkingLevel>
export const Externalmodel_ModelSettings = RuntimePublic5.Import('Externalmodel_ModelSettings')
export type Externalmodel_ModelSettings = Static<typeof Externalmodel_ModelSettings>
export const Externalagnes_v1_UsageView = RuntimePublic5.Import('Externalagnes_v1_UsageView')
export type Externalagnes_v1_UsageView = Static<typeof Externalagnes_v1_UsageView>
export const Externalagnes_v1_UITimeline = RuntimePublic5.Import('Externalagnes_v1_UITimeline')
export type Externalagnes_v1_UITimeline = Static<typeof Externalagnes_v1_UITimeline>
export const Externalagnes_v1_UIHistoryCursor = RuntimePublic5.Import('Externalagnes_v1_UIHistoryCursor')
export type Externalagnes_v1_UIHistoryCursor = Static<typeof Externalagnes_v1_UIHistoryCursor>
export const Externalagnes_v1_UIHistoryInfo = RuntimePublic5.Import('Externalagnes_v1_UIHistoryInfo')
export type Externalagnes_v1_UIHistoryInfo = Static<typeof Externalagnes_v1_UIHistoryInfo>
export const Externalagnes_v1_UIOpeningResult = RuntimePublic5.Import('Externalagnes_v1_UIOpeningResult')
export type Externalagnes_v1_UIOpeningResult = Static<typeof Externalagnes_v1_UIOpeningResult>
export const UIOpeningResult = RuntimePublic5.Import('UIOpeningResult')
export type UIOpeningResult = Static<typeof UIOpeningResult>
export const Externalagnes_v1_SessionBudgetResult = RuntimePublic5.Import('Externalagnes_v1_SessionBudgetResult')
export type Externalagnes_v1_SessionBudgetResult = Static<typeof Externalagnes_v1_SessionBudgetResult>
export const SessionBudgetResult = RuntimePublic5.Import('SessionBudgetResult')
export type SessionBudgetResult = Static<typeof SessionBudgetResult>
export const Externalagnes_v1_ApprovalGrantRecord = RuntimePublic5.Import('Externalagnes_v1_ApprovalGrantRecord')
export type Externalagnes_v1_ApprovalGrantRecord = Static<typeof Externalagnes_v1_ApprovalGrantRecord>
export const Externalagnes_v1_ApprovalGrantListResult = RuntimePublic5.Import('Externalagnes_v1_ApprovalGrantListResult')
export type Externalagnes_v1_ApprovalGrantListResult = Static<typeof Externalagnes_v1_ApprovalGrantListResult>
export const ApprovalGrantListResult = RuntimePublic5.Import('ApprovalGrantListResult')
export type ApprovalGrantListResult = Static<typeof ApprovalGrantListResult>
export const ApprovalGrantRecord = RuntimePublic5.Import('ApprovalGrantRecord')
export type ApprovalGrantRecord = Static<typeof ApprovalGrantRecord>
export const Externaljobs_ContentBlock = RuntimePublic5.Import('Externaljobs_ContentBlock')
export type Externaljobs_ContentBlock = Static<typeof Externaljobs_ContentBlock>
export const Externaljobs_JsonValue = RuntimePublic5.Import('Externaljobs_JsonValue')
export type Externaljobs_JsonValue = Static<typeof Externaljobs_JsonValue>
export const Externaljobs_Schedule = RuntimePublic5.Import('Externaljobs_Schedule')
export type Externaljobs_Schedule = Static<typeof Externaljobs_Schedule>
export const Externaljobs_JobSpec = RuntimePublic5.Import('Externaljobs_JobSpec')
export type Externaljobs_JobSpec = Static<typeof Externaljobs_JobSpec>
export const Externalagnes_v1_JobSpec = RuntimePublic5.Import('Externalagnes_v1_JobSpec')
export type Externalagnes_v1_JobSpec = Static<typeof Externalagnes_v1_JobSpec>
export const JobSpec = RuntimePublic5.Import('JobSpec')
export type JobSpec = Static<typeof JobSpec>
export const Externaljobs_JobStatus = RuntimePublic5.Import('Externaljobs_JobStatus')
export type Externaljobs_JobStatus = Static<typeof Externaljobs_JobStatus>
export const Externalagnes_v1_JobStatus = RuntimePublic5.Import('Externalagnes_v1_JobStatus')
export type Externalagnes_v1_JobStatus = Static<typeof Externalagnes_v1_JobStatus>
export const JobStatus = RuntimePublic5.Import('JobStatus')
export type JobStatus = Static<typeof JobStatus>
export const Externalextension_manifest_SkinTokenValue = RuntimePublic5.Import('Externalextension_manifest_SkinTokenValue')
export type Externalextension_manifest_SkinTokenValue = Static<typeof Externalextension_manifest_SkinTokenValue>
export const Externalextension_manifest_SkinContribution = RuntimePublic5.Import('Externalextension_manifest_SkinContribution')
export type Externalextension_manifest_SkinContribution = Static<typeof Externalextension_manifest_SkinContribution>
export const SkinContribution = RuntimePublic5.Import('SkinContribution')
export type SkinContribution = Static<typeof SkinContribution>
export const SimpleModelRequest = RuntimePublic5.Import('SimpleModelRequest')
export type SimpleModelRequest = Static<typeof SimpleModelRequest>
export const SimpleToolRequest = RuntimePublic5.Import('SimpleToolRequest')
export type SimpleToolRequest = Static<typeof SimpleToolRequest>
export const SimpleVisibleResult = RuntimePublic5.Import('SimpleVisibleResult')
export type SimpleVisibleResult = Static<typeof SimpleVisibleResult>
export const SimpleModelObservation = RuntimePublic5.Import('SimpleModelObservation')
export type SimpleModelObservation = Static<typeof SimpleModelObservation>
export const SimpleSignal = RuntimePublic5.Import('SimpleSignal')
export type SimpleSignal = Static<typeof SimpleSignal>
export const SimpleObservation = RuntimePublic5.Import('SimpleObservation')
export type SimpleObservation = Static<typeof SimpleObservation>
export const SimpleDecisionObservation = RuntimePublic5.Import('SimpleDecisionObservation')
export type SimpleDecisionObservation = Static<typeof SimpleDecisionObservation>
export const SimpleContextValue = RuntimePublic5.Import('SimpleContextValue')
export type SimpleContextValue = Static<typeof SimpleContextValue>
