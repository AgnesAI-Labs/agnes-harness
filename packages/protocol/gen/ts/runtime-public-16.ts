// generated from schema by tools/gen.ts — do not edit
import { Type, type Static } from '@sinclair/typebox'
import { FormatRegistry } from '@sinclair/typebox'

if (!FormatRegistry.Has('date-time')) FormatRegistry.Set('date-time', (value) => { const parts = value.split(/t/i); if (parts.length !== 2) return false; const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(parts[0] ?? ''); const time = /^(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)(z|([+-])(\d{2}):(\d{2}))$/i.exec(parts[1] ?? ''); if (!date || !time) return false; const year = Number(date[1]), month = Number(date[2]), day = Number(date[3]); const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0); const days = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; if (month < 1 || month > 12 || day < 1 || day > (days[month] ?? 0)) return false; const hour = Number(time[1]), minute = Number(time[2]), second = Number(time[3]); const offsetHour = Number(time[6] || 0), offsetMinute = Number(time[7] || 0); if (hour > 23 || minute > 59 || offsetHour > 23 || offsetMinute > 59) return false; if (second < 60) return true; const sign = time[5] === '-' ? -1 : 1; const utcMinute = minute - offsetMinute * sign; const utcHour = hour - offsetHour * sign - (utcMinute < 0 ? 1 : 0); return (utcHour === 23 || utcHour === -1) && (utcMinute === 59 || utcMinute === -1) && second < 61; })

export const JsonValue = Type.Recursive((This) => Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String(), Type.Array(This, { minItems: 0, maxItems: 10000 }), Type.Record(Type.String(), This)]))
export type JsonValue = Static<typeof JsonValue>

export const Externalsession_v1_JsonValue = Type.Recursive((This) => Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String(), Type.Array(This), Type.Record(Type.String(), This)]))
export type Externalsession_v1_JsonValue = Static<typeof Externalsession_v1_JsonValue>

export const RuntimePublic16 = Type.Module({
  "Id": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }),
  "UInt53": Type.Integer({ minimum: 0, maximum: 9007199254740991 }),
  "Timestamp": Type.String({ pattern: "Z$", format: "date-time" }),
  "TypeId": Type.String({ minLength: 1, maxLength: 256, pattern: "^[a-z][a-z0-9.-]*/[a-zA-Z0-9._/-]+@[1-9][0-9]*$" }),
  "Digest": Type.String({ pattern: "^[a-f0-9]{64}$" }),
  "SchemaRef": Type.Object({ "typeId": Type.Ref('TypeId'), "revision": Type.Ref('UInt53'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "BlobRef": Type.Object({ "authorityId": Type.Ref('Id'), "blobId": Type.Ref('Id'), "digest": Type.Ref('Digest'), "bytes": Type.Ref('UInt53'), "mediaType": Type.String(), "pinId": Type.Ref('Id') }, { additionalProperties: false }),
  "DataRef": Type.Union([Type.Object({ "kind": Type.Literal('inline'), "schema": Type.Ref('SchemaRef'), "value": JsonValue, "digest": Type.Ref('Digest'), "bytes": Type.Ref('UInt53') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('blob'), "schema": Type.Ref('SchemaRef'), "blob": Type.Ref('BlobRef') }, { additionalProperties: false })]),
  "RuntimeErrorCode": Type.Union([Type.Literal('invalid_input'), Type.Literal('denied'), Type.Literal('incompatible'), Type.Literal('quota'), Type.Literal('cancelled'), Type.Literal('timeout'), Type.Literal('retryable'), Type.Literal('unknown_effect'), Type.Literal('conflict'), Type.Literal('internal')]),
  "OwnerRef": Type.Object({ "kind": Type.Union([Type.Literal('run'), Type.Literal('action'), Type.Literal('job'), Type.Literal('reconciliation')]), "id": Type.Ref('Id') }, { additionalProperties: false }),
  "RetryAdvice": Type.Union([Type.Object({ "kind": Type.Literal('never') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('retry_read'), "notBefore": Type.Optional(Type.Ref('Timestamp')) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('retry_same_action'), "notBefore": Type.Optional(Type.Ref('Timestamp')) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('reconcile'), "ownerRef": Type.Ref('OwnerRef') }, { additionalProperties: false })]),
  "RuntimeError": Type.Object({ "code": Type.Ref('RuntimeErrorCode'), "detailCode": Type.String(), "message": Type.String(), "retryAdvice": Type.Ref('RetryAdvice'), "diagnosticId": Type.Ref('Id'), "safeDetail": Type.Optional(JsonValue) }, { additionalProperties: false }),
  "HookEventName": Type.Union([Type.Literal('tool_call'), Type.Literal('approval_request'), Type.Literal('tool_result'), Type.Literal('context'), Type.Literal('before_request'), Type.Literal('request_error'), Type.Literal('format_deviation'), Type.Literal('before_compact'), Type.Literal('compact'), Type.Literal('session_start'), Type.Literal('shutdown'), Type.Literal('subagent_start'), Type.Literal('subagent_end'), Type.Literal('resources_discover'), Type.Literal('before_step'), Type.Literal('turn_stopping')]),
  "HookResultSet": Type.Object({ "stageId": Type.Ref('Id'), "event": Type.Ref('HookEventName'), "registrationDigest": Type.Ref('Digest'), "inputDigest": Type.Ref('Digest'), "entries": Type.Array(Type.Object({ "registrationId": Type.Ref('Id'), "ordinal": Type.Ref('UInt53'), "outcome": Type.Union([Type.Literal('applied'), Type.Literal('failed-open'), Type.Literal('denied')]), "output": Type.Union([Type.Ref('DataRef'), Type.Null()]), "diagnosticId": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false }), { maxItems: 10000 }), "output": Type.Ref('DataRef'), "digest": Type.Ref('Digest'), "sourceActionId": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false }),
  "ScopeRef": Type.Union([Type.Object({ "installationId": Type.Ref('Id'), "kind": Type.Literal('installation') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "kind": Type.Literal('runtime') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "kind": Type.Literal('workspace') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "kind": Type.Literal('session') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "runId": Type.Ref('Id'), "kind": Type.Literal('run') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "runId": Type.Ref('Id'), "kind": Type.Literal('action'), "actionId": Type.Ref('Id') }, { additionalProperties: false })]),
  "ApprovalRequest": Type.Object({ "kind": Type.Literal('approval'), "title": Type.String(), "body": Type.String(), "approvalHookResults": Type.Optional(Type.Ref('HookResultSet')), "allowedGrantScopes": Type.Optional(Type.Array(Type.Union([Type.Literal('once'), Type.Literal('session'), Type.Literal('permanent')]), { maxItems: 10000 })), "actionRef": Type.String(), "inputDigest": Type.Ref('Digest'), "policyDecisionRef": Type.String(), "scope": Type.Ref('ScopeRef'), "allowedResponders": Type.Array(Type.String(), { maxItems: 10000 }), "expiresAt": Type.Ref('Timestamp'), "idempotencyKey": Type.String() }, { additionalProperties: false }),
  "Revision": Type.Ref('UInt53'),
  "DomainObjectRef": Type.Object({ "authorityId": Type.Ref('Id'), "typeId": Type.Ref('TypeId'), "id": Type.Ref('Id'), "revision": Type.Ref('Revision') }, { additionalProperties: false }),
  "ThinkingLevel": Type.Union([Type.Literal('off'), Type.Literal('minimal'), Type.Literal('low'), Type.Literal('medium'), Type.Literal('high'), Type.Literal('xhigh'), Type.Literal('max')]),
  "ContentBlock": Type.Union([Type.Object({ "type": Type.Literal('text'), "text": Type.String({ maxLength: 1048576 }) }, { additionalProperties: false }), Type.Object({ "type": Type.Literal('image'), "data": Type.String(), "mimeType": Type.String({ maxLength: 128 }) }, { additionalProperties: false }), Type.Object({ "type": Type.Literal('resource_link'), "uri": Type.String({ maxLength: 4096 }), "name": Type.Optional(Type.String({ maxLength: 256 })), "mimeType": Type.Optional(Type.String({ maxLength: 128 })) }, { additionalProperties: false })]),
  "SlotName": Type.Union([Type.Literal('primary'), Type.Literal('escalation'), Type.Literal('fast'), Type.Literal('compaction'), Type.Literal('verifier'), Type.Literal('image'), Type.Literal('video')]),
  "SessionControlCommand": Type.Union([Type.Object({ "kind": Type.Union([Type.Literal('prompt'), Type.Literal('steer'), Type.Literal('follow-up')]), "content": Type.Array(Type.Ref('ContentBlock'), { maxItems: 10000 }) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('compact'), "instructions": Type.Union([Type.String(), Type.Null()]) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('fork'), "atNativeSeq": Type.Ref('UInt53'), "childSessionId": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('set-preset'), "presetId": Type.Ref('Id'), "presetDigest": Type.Ref('Digest'), "apply": Type.Union([Type.Literal('next-request'), Type.Literal('next-run')]) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('set-model'), "slot": Type.Ref('SlotName'), "route": Type.String(), "model": Type.String(), "thinking": Type.Union([Type.Ref('ThinkingLevel'), Type.Null()]) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('set-yolo'), "enabled": Type.Boolean() }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('cancel'), "runId": Type.Ref('Id'), "reason": Type.String() }, { additionalProperties: false })]),
  "SessionControlRequest": Type.Object({ "sessionId": Type.Ref('Id'), "requestId": Type.Ref('Id'), "expectedRevision": Type.Union([Type.Ref('UInt53'), Type.Null()]), "command": Type.Ref('SessionControlCommand') }, { additionalProperties: false }),
  "SessionControlBoundary": Type.Object({ "kind": Type.Union([Type.Literal('immediate'), Type.Literal('next-request'), Type.Literal('next-turn'), Type.Literal('quiet-step'), Type.Literal('quiet-turn'), Type.Literal('next-run')]), "revision": Type.Ref('UInt53'), "runId": Type.Union([Type.Ref('Id'), Type.Null()]), "afterRequestId": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false }),
  "CompactOutcome": Type.Union([Type.Object({ "state": Type.Literal('completed'), "endSeq": Type.Integer({ minimum: 1 }) }, { additionalProperties: false }), Type.Object({ "state": Type.Literal('failed'), "endSeq": Type.Integer({ minimum: 1 }) }, { additionalProperties: false }), Type.Object({ "state": Type.Literal('unknown') }, { additionalProperties: false })]),
  "SessionControlResult": Type.Object({ "sessionId": Type.Ref('Id'), "requestId": Type.Ref('Id'), "status": Type.Union([Type.Literal('accepted'), Type.Literal('applied'), Type.Literal('rejected')]), "revision": Type.Ref('UInt53'), "effective": Type.Union([Type.Ref('SessionControlBoundary'), Type.Null()]), "runId": Type.Union([Type.Ref('Id'), Type.Null()]), "childSessionId": Type.Union([Type.Ref('Id'), Type.Null()]), "compact": Type.Union([Type.Ref('CompactOutcome'), Type.Null()]), "error": Type.Union([Type.Ref('RuntimeError'), Type.Null()]) }, { additionalProperties: false }),
  "ApprovalRespondRequest": Type.Union([Type.Object({ "interactionId": Type.Ref('Id'), "responseId": Type.Ref('Id'), "expectedVersion": Type.Ref('UInt53'), "decision": Type.Literal('approve'), "actionDigest": Type.Ref('Digest'), "grantScope": Type.Optional(Type.Union([Type.Literal('once'), Type.Literal('session'), Type.Literal('permanent')])) }, { additionalProperties: false }), Type.Object({ "interactionId": Type.Ref('Id'), "responseId": Type.Ref('Id'), "expectedVersion": Type.Ref('UInt53'), "decision": Type.Literal('deny'), "actionDigest": Type.Ref('Digest') }, { additionalProperties: false })]),
  "QuestionField": Type.Union([Type.Object({ "id": Type.Ref('Id'), "kind": Type.Literal('text'), "label": Type.String({ maxLength: 8192 }), "required": Type.Boolean(), "multiline": Type.Boolean(), "maxLength": Type.Ref('UInt53') }, { additionalProperties: false }), Type.Object({ "id": Type.Ref('Id'), "kind": Type.Literal('singleChoice'), "label": Type.String({ maxLength: 8192 }), "required": Type.Boolean(), "options": Type.Array(Type.Object({ "id": Type.Ref('Id'), "label": Type.String({ maxLength: 8192 }) }, { additionalProperties: false }), { minItems: 1, maxItems: 10000 }) }, { additionalProperties: false }), Type.Object({ "id": Type.Ref('Id'), "kind": Type.Literal('multiChoice'), "label": Type.String({ maxLength: 8192 }), "required": Type.Boolean(), "options": Type.Array(Type.Object({ "id": Type.Ref('Id'), "label": Type.String({ maxLength: 8192 }) }, { additionalProperties: false }), { minItems: 1, maxItems: 10000 }), "minItems": Type.Ref('UInt53'), "maxItems": Type.Ref('UInt53') }, { additionalProperties: false }), Type.Object({ "id": Type.Ref('Id'), "kind": Type.Literal('confirm'), "label": Type.String({ maxLength: 8192 }), "required": Type.Literal(true), "statement": Type.String({ maxLength: 8192 }) }, { additionalProperties: false }), Type.Object({ "id": Type.Ref('Id'), "kind": Type.Literal('custom'), "label": Type.String({ maxLength: 8192 }), "required": Type.Boolean(), "fieldSchema": Type.Ref('SchemaRef'), "rendererKey": Type.Ref('Id') }, { additionalProperties: false })]),
  "QuestionRequest": Type.Object({ "kind": Type.Literal('question'), "body": Type.String({ maxLength: 262144 }), "answerSchema": Type.Ref('SchemaRef'), "fields": Type.Array(Type.Ref('QuestionField'), { minItems: 0, maxItems: 10000 }), "allowedResponders": Type.Array(Type.Ref('Id'), { minItems: 0, maxItems: 10000 }), "expiresAt": Type.Ref('Timestamp'), "idempotencyKey": Type.Ref('Id'), "title": Type.String({ maxLength: 8192 }) }, { additionalProperties: false }),
  "InteractionRequest": Type.Union([Type.Ref('QuestionRequest'), Type.Ref('ApprovalRequest')]),
  "InteractionRecord": Type.Union([Type.Object({ "interactionId": Type.Ref('Id'), "owner": Type.Object({ "runId": Type.Ref('Id'), "actionId": Type.Ref('Id') }, { additionalProperties: false }), "request": Type.Ref('InteractionRequest'), "version": Type.Ref('UInt53'), "createdAt": Type.Ref('Timestamp'), "updatedAt": Type.Ref('Timestamp'), "status": Type.Literal('answered'), "terminationReason": Type.Union([Type.String({ maxLength: 8192 }), Type.Null()]), "resolution": Type.Object({ "responseId": Type.Ref('Id'), "actorRef": Type.Ref('Id'), "answer": Type.Ref('DataRef'), "committedAt": Type.Ref('Timestamp'), "evidence": Type.Union([Type.Object({ "kind": Type.Literal('human'), "authenticationRef": Type.Ref('DataRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('system'), "policyDecisionRef": Type.Ref('DataRef') }, { additionalProperties: false })]) }, { additionalProperties: false }) }, { additionalProperties: false }), Type.Object({ "interactionId": Type.Ref('Id'), "owner": Type.Object({ "runId": Type.Ref('Id'), "actionId": Type.Ref('Id') }, { additionalProperties: false }), "request": Type.Ref('InteractionRequest'), "version": Type.Ref('UInt53'), "createdAt": Type.Ref('Timestamp'), "updatedAt": Type.Ref('Timestamp'), "status": Type.Union([Type.Literal('pending'), Type.Literal('cancelled'), Type.Literal('expired')]), "terminationReason": Type.Union([Type.String({ maxLength: 8192 }), Type.Null()]), "resolution": Type.Null() }, { additionalProperties: false })]),
  "Externalsession_v1_ContentBlock": Type.Union([Type.Object({ "type": Type.Literal('text'), "text": Type.String({ maxLength: 1048576 }) }, { additionalProperties: false }), Type.Object({ "type": Type.Literal('image'), "data": Type.String(), "mimeType": Type.String({ maxLength: 128 }) }, { additionalProperties: false }), Type.Object({ "type": Type.Literal('resource_link'), "uri": Type.String({ maxLength: 4096 }), "name": Type.Optional(Type.String({ maxLength: 256 })), "mimeType": Type.Optional(Type.String({ maxLength: 128 })) }, { additionalProperties: false })]),
  "Externalagnes_v1_ApprovalGrantRecord": Type.Object({ "grantId": Type.String({ minLength: 1, maxLength: 128 }), "profileHash": Type.String({ pattern: "^sha256-[a-f0-9]{64}$" }), "actorId": Type.String({ minLength: 1, maxLength: 256 }), "actorOrg": Type.String({ minLength: 1, maxLength: 256 }), "toolId": Type.String({ minLength: 1, maxLength: 128 }), "scope": Type.String({ minLength: 1, maxLength: 256 }), "policyVersion": Type.String({ minLength: 1, maxLength: 64 }), "createdAt": Type.String({ format: "date-time" }), "revokedAt": Type.Optional(Type.String({ format: "date-time" })) }, { additionalProperties: false }),
  "ApprovalGrantRecord": Type.Ref('Externalagnes_v1_ApprovalGrantRecord'),
  "Externaljobs_ContentBlock": Type.Ref('Externalsession_v1_ContentBlock'),
  "Externaljobs_JsonValue": Externalsession_v1_JsonValue,
  "Externaljobs_Schedule": Type.Union([Type.Object({ "kind": Type.Literal('once') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('at'), "at": Type.Integer({ minimum: 0 }) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('every'), "everyMs": Type.Integer({ minimum: 1000 }), "anchorMs": Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('cron'), "expr": Type.String({ maxLength: 128 }), "tz": Type.Optional(Type.String({ maxLength: 64 })), "staggerMs": Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false })]),
  "Externaljobs_JobSpec": Type.Object({ "idempotencyKey": Type.String({ maxLength: 256 }), "sessionKey": Type.String({ maxLength: 512 }), "payload": Type.Union([Type.Object({ "prompt": Type.Union([Type.String({ maxLength: 65536 }), Type.Array(Type.Ref('Externaljobs_ContentBlock'))]), "delivery": Type.Optional(Type.Union([Type.Literal('steer'), Type.Literal('follow_up')])) }, { additionalProperties: false }), Type.Object({ "command": Type.Object({ "method": Type.String({ pattern: "^(?:resume|_agnes/v1/[A-Za-z][A-Za-z0-9./_-]*)$" }), "params": Type.Ref('Externaljobs_JsonValue') }, { additionalProperties: false }) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('directory.sync'), "channel": Type.String({ minLength: 1, maxLength: 64 }) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('shell'), "command": Type.String({ maxLength: 65536 }), "cwd": Type.String({ maxLength: 4096 }) }, { additionalProperties: false })]), "schedule": Type.Ref('Externaljobs_Schedule'), "budget": Type.Optional(Type.Number({ minimum: 0 })), "protected": Type.Optional(Type.Boolean()), "maxAttempts": Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) }, { additionalProperties: false }),
  "Externalagnes_v1_JobSpec": Type.Ref('Externaljobs_JobSpec'),
  "JobSpec": Type.Ref('Externalagnes_v1_JobSpec'),
  "SkinTokenValue": Type.String({ minLength: 1, maxLength: 256, pattern: "^(?!.*url\\()[^;{}@]*$" }),
  "Cursor": Type.String(),
  "DomainActionRef": Type.Object({ "viewId": Type.String(), "actionKey": Type.String(), "viewRevision": Type.Number() }, { additionalProperties: false }),
  "CommandHandle": Type.Object({ "commandId": Type.String(), "requestId": Type.String(), "revision": Type.Number(), "status": Type.Union([Type.Literal('accepted'), Type.Literal('running'), Type.Literal('succeeded'), Type.Literal('failed'), Type.Literal('cancelled'), Type.Literal('unknown_effect')]), "result": Type.Union([Type.Ref('DataRef'), Type.Null()]), "error": Type.Union([Type.Ref('RuntimeError'), Type.Null()]) }, { additionalProperties: false }),
  "ProtocolRange": Type.Object({ "major": Type.Number(), "minMinor": Type.Number(), "maxMinor": Type.Number() }, { additionalProperties: false }),
  "ViewSchemaRange": Type.Object({ "typeId": Type.String(), "minRevision": Type.Number(), "maxRevision": Type.Number() }, { additionalProperties: false }),
  "NegotiatedClientCapabilities": Type.Object({ "clientInstanceId": Type.String(), "target": Type.Union([Type.Literal('web'), Type.Literal('tui'), Type.Literal('im'), Type.Literal('sdk')]), "protocols": Type.Array(Type.Ref('ProtocolRange'), { maxItems: 10000 }), "viewSchemaRanges": Type.Array(Type.Ref('ViewSchemaRange'), { maxItems: 10000 }), "renderKeys": Type.Array(Type.String(), { maxItems: 10000 }), "features": Type.Array(Type.String(), { maxItems: 10000 }), "capabilitiesRevision": Type.Number(), "interaction": Type.Object({ "text": Type.Boolean(), "singleChoice": Type.Boolean(), "multiChoice": Type.Boolean(), "confirm": Type.Boolean(), "complexFormLink": Type.Boolean() }, { additionalProperties: false }), "files": Type.Object({ "link": Type.Boolean(), "upload": Type.Boolean(), "maxUploadBytes": Type.Number(), "allowedMimes": Type.Array(Type.String(), { maxItems: 10000 }) }, { additionalProperties: false }), "display": Type.Object({ "plainText": Type.Boolean(), "markdown": Type.Boolean(), "maxTextBytes": Type.Number(), "inlinePreviewMimes": Type.Array(Type.String(), { maxItems: 10000 }) }, { additionalProperties: false }), "negotiatedSession": Type.String(), "effectivePolicyRevision": Type.Number() }, { additionalProperties: false }),
  "InteractionResponseStatus": Type.Object({ "interactionId": Type.Ref('Id'), "responseId": Type.Ref('Id'), "status": Type.Union([Type.Literal('accepted'), Type.Literal('applied'), Type.Literal('rejected')]), "version": Type.Ref('UInt53'), "result": Type.Union([Type.Ref('InteractionRecord'), Type.Null()]), "error": Type.Union([Type.Ref('RuntimeError'), Type.Null()]) }, { additionalProperties: false }),
  "InteractionFormLink": Type.Object({ "url": Type.String(), "expiresAt": Type.Ref('Timestamp'), "interactionId": Type.Ref('Id'), "version": Type.Ref('UInt53') }, { additionalProperties: false }),
  "ArtifactDownloadTicket": Type.Object({ "url": Type.String(), "expiresAt": Type.Ref('Timestamp'), "artifactId": Type.Ref('Id'), "version": Type.Ref('UInt53'), "grantRevision": Type.Ref('UInt53') }, { additionalProperties: false }),
  "ClientModule": Type.Object({ "moduleId": Type.String(), "packageId": Type.String(), "packageDigest": Type.Ref('Digest'), "assetDigest": Type.Ref('Digest'), "entryPath": Type.String(), "ownerToken": Type.String(), "authorApiMajor": Type.Number(), "targets": Type.Array(Type.Union([Type.Literal('web'), Type.Literal('tui'), Type.Literal('im'), Type.Literal('sdk')]), { maxItems: 10000 }), "schemas": Type.Array(Type.Ref('SchemaRef'), { maxItems: 10000 }), "requiredFeatures": Type.Array(Type.String(), { maxItems: 10000 }), "styles": Type.Array(Type.Union([Type.Object({ "kind": Type.Literal('stylesheet'), "path": Type.String(), "assetDigest": Type.Ref('Digest'), "bytes": Type.Number(), "entryPath": Type.String() }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('skin'), "skin": Type.Object({ "id": Type.String(), "name": Type.String(), "tokens": Type.Optional(Type.Intersect([Type.Record(Type.String(), Type.Object({ "light": Type.Ref('SkinTokenValue'), "dark": Type.Ref('SkinTokenValue') }, { additionalProperties: false })), Type.Object({})])) }, { additionalProperties: false }), "path": Type.String(), "assetDigest": Type.Ref('Digest'), "bytes": Type.Number(), "entryPath": Type.String() }, { additionalProperties: false })]), { maxItems: 10000 }) }, { additionalProperties: false }),
  "ClientWelcome": Type.Object({ "negotiatedSession": Type.String(), "wireVersion": Type.Object({ "major": Type.Number(), "minor": Type.Number() }, { additionalProperties: false }), "catalogRevision": Type.Number(), "capabilities": Type.Ref('NegotiatedClientCapabilities'), "domainSchemas": Type.Array(Type.Ref('SchemaRef'), { maxItems: 10000 }), "modules": Type.Array(Type.Ref('ClientModule'), { maxItems: 10000 }), "mode": Type.Union([Type.Literal('compatible'), Type.Literal('degraded'), Type.Literal('reload-required'), Type.Literal('incompatible')]), "reasons": Type.Array(Type.Object({ "code": Type.String(), "message": Type.String(), "moduleId": Type.Union([Type.String(), Type.Null()]) }, { additionalProperties: false }), { maxItems: 10000 }) }, { additionalProperties: false }),
  "JobTarget": Type.Union([Type.Object({ "kind": Type.Literal('pin'), "releaseSetId": Type.Ref('Id'), "bindingId": Type.Ref('Id'), "presetRef": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('follow'), "routeId": Type.Ref('Id'), "presetRef": Type.Ref('Id') }, { additionalProperties: false })]),
  "JobSchedule": Type.Union([Type.Object({ "kind": Type.Literal('once'), "at": Type.Ref('Timestamp') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('rrule'), "rrule": Type.String(), "timezone": Type.String(), "startsAt": Type.Ref('Timestamp'), "ambiguousLocalTime": Type.Union([Type.Literal('earlier'), Type.Literal('later')]), "nonexistentLocalTime": Type.Union([Type.Literal('skip'), Type.Literal('next-valid')]) }, { additionalProperties: false })]),
  "JobPolicy": Type.Object({ "missed": Type.Union([Type.Literal('skip'), Type.Literal('latest'), Type.Literal('catch-up')]), "maxCatchUp": Type.Ref('UInt53'), "concurrency": Type.Union([Type.Literal('forbid'), Type.Literal('queue'), Type.Literal('parallel')]), "maxConcurrent": Type.Ref('UInt53'), "maxAttempts": Type.Ref('UInt53'), "retryDelayMs": Type.Ref('UInt53'), "retryMaxDelayMs": Type.Ref('UInt53') }, { additionalProperties: false }),
  "JobEdit": Type.Object({ "schedule": Type.Optional(Type.Ref('JobSchedule')), "policy": Type.Optional(Type.Ref('JobPolicy')), "target": Type.Optional(Type.Ref('JobTarget')), "inputRef": Type.Optional(Type.Ref('DataRef')), "budgetAccount": Type.Optional(Type.Ref('DomainObjectRef')), "status": Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('paused')])) }, { additionalProperties: false }),
  "DomainCommandClientSubmitRequest": Type.Object({ "action": Type.Ref('DomainActionRef'), "input": Type.Ref('DataRef'), "requestId": Type.String(), "expectedRevision": Type.Number() }, { additionalProperties: false }),
  "ShellConversationClientCreateRequest": Type.Object({ "workspaceId": Type.String(), "presetId": Type.String(), "requestId": Type.String() }, { additionalProperties: false }),
  "ShellConversationClientCreateResult": Type.Object({ "sessionId": Type.String() }, { additionalProperties: false }),
  "ShellConversationClientSubmitRequest": Type.Object({ "sessionId": Type.String(), "kind": Type.Union([Type.Literal('prompt'), Type.Literal('follow-up')]), "content": Type.Array(Type.Ref('ContentBlock'), { maxItems: 10000 }), "requestId": Type.String(), "expectedGeneration": Type.Number() }, { additionalProperties: false }),
  "ShellConversationClientCancelRequest": Type.Object({ "sessionId": Type.String(), "runId": Type.String(), "requestId": Type.String() }, { additionalProperties: false }),
  "PermissionClientRevokeGrantRequest": Type.Object({ "sessionId": Type.Ref('Id'), "toolId": Type.String(), "scope": Type.String(), "policyVersion": Type.String(), "grantId": Type.Ref('Id'), "requestId": Type.Ref('Id') }, { additionalProperties: false }),
  "SessionJobsClientEnqueueRequest": Type.Object({ "requestId": Type.Ref('Id'), "spec": Type.Ref('JobSpec') }, { additionalProperties: false }),
  "SessionJobsClientEnqueueResult": Type.Object({ "jobId": Type.Ref('Id') }, { additionalProperties: false }),
  "SessionJobsClientCancelRequest": Type.Object({ "jobId": Type.Ref('Id'), "requestId": Type.Ref('Id') }, { additionalProperties: false }),
  "SessionJobsClientCancelResult": Type.Object({ "jobId": Type.Ref('Id'), "cancelRequested": Type.Boolean() }, { additionalProperties: false }),
  "SessionJobsClientCreateRequest": Type.Object({ "requestId": Type.Ref('Id'), "schedule": Type.Ref('JobSchedule'), "policy": Type.Ref('JobPolicy'), "target": Type.Ref('JobTarget'), "inputRef": Type.Ref('DataRef'), "budgetAccount": Type.Ref('DomainObjectRef') }, { additionalProperties: false }),
  "SessionJobsClientUpdateRequest": Type.Object({ "requestId": Type.Ref('Id'), "id": Type.Ref('Id'), "expectedRevision": Type.Ref('Revision'), "changes": Type.Ref('JobEdit') }, { additionalProperties: false }),
  "SessionJobsClientCancelDefinitionRequest": Type.Object({ "requestId": Type.Ref('Id'), "id": Type.Ref('Id'), "expectedRevision": Type.Ref('Revision'), "reason": Type.String(), "cancelActive": Type.Boolean() }, { additionalProperties: false }),
  "InteractionClientRespondRequest": Type.Object({ "interactionId": Type.Ref('Id'), "responseId": Type.Ref('Id'), "expectedVersion": Type.Ref('UInt53'), "answer": Type.Ref('DataRef') }, { additionalProperties: false }),
  "ArtifactClientOpenDownloadRequest": Type.Object({ "artifactId": Type.Ref('Id'), "version": Type.Ref('UInt53'), "disposition": Type.Union([Type.Literal('inline'), Type.Literal('attachment')]) }, { additionalProperties: false }),
  "ClientInteractionFormLinkInput": Type.Object({ "interactionId": Type.Ref('Id'), "expectedVersion": Type.Ref('UInt53') }, { additionalProperties: false }),
  "ClientCallHeader": Type.Object({ "negotiatedSession": Type.Ref('Id'), "clientInstanceId": Type.Ref('Id'), "catalogRevision": Type.Ref('UInt53'), "callId": Type.Ref('Id') }, { additionalProperties: false }),
  "ClientCommandCall": Type.Union([Type.Object({ "operation": Type.Literal('conversation.create'), "input": Type.Ref('ShellConversationClientCreateRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('conversation.submit'), "input": Type.Ref('ShellConversationClientSubmitRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('conversation.cancel'), "input": Type.Ref('ShellConversationClientCancelRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('domain.submit'), "input": Type.Ref('DomainCommandClientSubmitRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('control.submit'), "input": Type.Ref('SessionControlRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('permission.revokeGrant'), "input": Type.Ref('PermissionClientRevokeGrantRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('jobs.enqueue'), "input": Type.Ref('SessionJobsClientEnqueueRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('jobs.cancel'), "input": Type.Ref('SessionJobsClientCancelRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('jobs.create'), "input": Type.Ref('SessionJobsClientCreateRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('jobs.update'), "input": Type.Ref('SessionJobsClientUpdateRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('jobs.cancelDefinition'), "input": Type.Ref('SessionJobsClientCancelDefinitionRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('interaction.respond'), "input": Type.Ref('InteractionClientRespondRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('interaction.formLink'), "input": Type.Ref('ClientInteractionFormLinkInput') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('approval.respond'), "input": Type.Ref('ApprovalRespondRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('approval.formLink'), "input": Type.Ref('ClientInteractionFormLinkInput') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('artifact.openDownload'), "input": Type.Ref('ArtifactClientOpenDownloadRequest') }, { additionalProperties: false })]),
  "ClientCommandValue": Type.Union([Type.Object({ "operation": Type.Literal('conversation.create'), "value": Type.Ref('ShellConversationClientCreateResult') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('conversation.submit'), "value": Type.Ref('CommandHandle') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('conversation.cancel'), "value": Type.Ref('CommandHandle') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('domain.submit'), "value": Type.Ref('CommandHandle') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('control.submit'), "value": Type.Ref('SessionControlResult') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('permission.revokeGrant'), "value": Type.Ref('ApprovalGrantRecord') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('jobs.enqueue'), "value": Type.Ref('SessionJobsClientEnqueueResult') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('jobs.cancel'), "value": Type.Ref('SessionJobsClientCancelResult') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('jobs.create'), "value": Type.Ref('CommandHandle') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('jobs.update'), "value": Type.Ref('CommandHandle') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('jobs.cancelDefinition'), "value": Type.Ref('CommandHandle') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('interaction.respond'), "value": Type.Ref('InteractionResponseStatus') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('interaction.formLink'), "value": Type.Ref('InteractionFormLink') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('approval.respond'), "value": Type.Ref('InteractionResponseStatus') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('approval.formLink'), "value": Type.Ref('InteractionFormLink') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('artifact.openDownload'), "value": Type.Ref('ArtifactDownloadTicket') }, { additionalProperties: false })]),
  "ClientCommandRequest": Object.assign(Type.Object({ "header": Type.Ref('ClientCallHeader'), "call": Type.Ref('ClientCommandCall') }, { additionalProperties: false }), {"x-max-canonical-json-bytes":1048576}),
  "ClientCommandReply": Object.assign(Type.Object({ "header": Type.Ref('ClientCallHeader'), "reply": Type.Ref('ClientCommandValue') }, { additionalProperties: false }), {"x-max-canonical-json-bytes":1048576}),
  "ClientBootstrapRejected": Object.assign(Type.Object({ "mode": Type.Literal('incompatible'), "reasonCode": Object.assign(Type.String(), {"x-max-utf8-bytes":256}), "message": Object.assign(Type.String(), {"x-max-utf8-bytes":1024}), "supportedProtocols": Type.Array(Type.Ref('ProtocolRange'), { maxItems: 16 }) }, { additionalProperties: false }), {"x-max-canonical-json-bytes":65536}),
  "ClientCatalogPageState": Type.Object({ "nextCursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "complete": Type.Boolean() }, { additionalProperties: false }),
  "ClientBootstrapAccepted": Type.Object({ "welcome": Type.Ref('ClientWelcome'), "catalogPage": Type.Ref('ClientCatalogPageState') }, { additionalProperties: false }),
  "ClientBootstrapResult": Object.assign(Type.Union([Type.Ref('ClientBootstrapRejected'), Type.Ref('ClientBootstrapAccepted')]), {"x-max-canonical-json-bytes":1048576}),
  "ClientCatalogPageRequest": Type.Object({ "negotiatedSession": Type.Ref('Id'), "clientInstanceId": Type.Ref('Id'), "catalogRevision": Type.Ref('UInt53'), "cursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "limit": Type.Integer({ minimum: 1, maximum: 128 }) }, { additionalProperties: false }),
  "ClientCatalogPageResult": Object.assign(Type.Object({ "catalogRevision": Type.Ref('UInt53'), "modules": Type.Array(Type.Ref('ClientModule'), { maxItems: 128 }), "domainSchemas": Type.Array(Type.Ref('SchemaRef'), { maxItems: 128 }), "nextCursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "complete": Type.Boolean() }, { additionalProperties: false }), {"x-max-canonical-json-bytes":1048576}),
  "ClientInteractionChange": Type.Union([Type.Object({ "kind": Type.Literal('upsert'), "record": Type.Ref('InteractionRecord') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('remove'), "interactionId": Type.Ref('Id'), "version": Type.Ref('UInt53'), "reason": Object.assign(Type.String(), {"x-max-utf8-bytes":1024}) }, { additionalProperties: false })]),
})

export const Id = RuntimePublic16.Import('Id')
export type Id = Static<typeof Id>
export const UInt53 = RuntimePublic16.Import('UInt53')
export type UInt53 = Static<typeof UInt53>
export const Timestamp = RuntimePublic16.Import('Timestamp')
export type Timestamp = Static<typeof Timestamp>
export const TypeId = RuntimePublic16.Import('TypeId')
export type TypeId = Static<typeof TypeId>
export const Digest = RuntimePublic16.Import('Digest')
export type Digest = Static<typeof Digest>
export const SchemaRef = RuntimePublic16.Import('SchemaRef')
export type SchemaRef = Static<typeof SchemaRef>
export const BlobRef = RuntimePublic16.Import('BlobRef')
export type BlobRef = Static<typeof BlobRef>
export const DataRef = RuntimePublic16.Import('DataRef')
export type DataRef = Static<typeof DataRef>
export const RuntimeErrorCode = RuntimePublic16.Import('RuntimeErrorCode')
export type RuntimeErrorCode = Static<typeof RuntimeErrorCode>
export const OwnerRef = RuntimePublic16.Import('OwnerRef')
export type OwnerRef = Static<typeof OwnerRef>
export const RetryAdvice = RuntimePublic16.Import('RetryAdvice')
export type RetryAdvice = Static<typeof RetryAdvice>
export const RuntimeError = RuntimePublic16.Import('RuntimeError')
export type RuntimeError = Static<typeof RuntimeError>
export const HookEventName = RuntimePublic16.Import('HookEventName')
export type HookEventName = Static<typeof HookEventName>
export const HookResultSet = RuntimePublic16.Import('HookResultSet')
export type HookResultSet = Static<typeof HookResultSet>
export const ScopeRef = RuntimePublic16.Import('ScopeRef')
export type ScopeRef = Static<typeof ScopeRef>
export const ApprovalRequest = RuntimePublic16.Import('ApprovalRequest')
export type ApprovalRequest = Static<typeof ApprovalRequest>
export const Revision = RuntimePublic16.Import('Revision')
export type Revision = Static<typeof Revision>
export const DomainObjectRef = RuntimePublic16.Import('DomainObjectRef')
export type DomainObjectRef = Static<typeof DomainObjectRef>
export const ThinkingLevel = RuntimePublic16.Import('ThinkingLevel')
export type ThinkingLevel = Static<typeof ThinkingLevel>
export const ContentBlock = RuntimePublic16.Import('ContentBlock')
export type ContentBlock = Static<typeof ContentBlock>
export const SlotName = RuntimePublic16.Import('SlotName')
export type SlotName = Static<typeof SlotName>
export const SessionControlCommand = RuntimePublic16.Import('SessionControlCommand')
export type SessionControlCommand = Static<typeof SessionControlCommand>
export const SessionControlRequest = RuntimePublic16.Import('SessionControlRequest')
export type SessionControlRequest = Static<typeof SessionControlRequest>
export const SessionControlBoundary = RuntimePublic16.Import('SessionControlBoundary')
export type SessionControlBoundary = Static<typeof SessionControlBoundary>
export const CompactOutcome = RuntimePublic16.Import('CompactOutcome')
export type CompactOutcome = Static<typeof CompactOutcome>
export const SessionControlResult = RuntimePublic16.Import('SessionControlResult')
export type SessionControlResult = Static<typeof SessionControlResult>
export const ApprovalRespondRequest = RuntimePublic16.Import('ApprovalRespondRequest')
export type ApprovalRespondRequest = Static<typeof ApprovalRespondRequest>
export const QuestionField = RuntimePublic16.Import('QuestionField')
export type QuestionField = Static<typeof QuestionField>
export const QuestionRequest = RuntimePublic16.Import('QuestionRequest')
export type QuestionRequest = Static<typeof QuestionRequest>
export const InteractionRequest = RuntimePublic16.Import('InteractionRequest')
export type InteractionRequest = Static<typeof InteractionRequest>
export const InteractionRecord = RuntimePublic16.Import('InteractionRecord')
export type InteractionRecord = Static<typeof InteractionRecord>
export const Externalsession_v1_ContentBlock = RuntimePublic16.Import('Externalsession_v1_ContentBlock')
export type Externalsession_v1_ContentBlock = Static<typeof Externalsession_v1_ContentBlock>
export const Externalagnes_v1_ApprovalGrantRecord = RuntimePublic16.Import('Externalagnes_v1_ApprovalGrantRecord')
export type Externalagnes_v1_ApprovalGrantRecord = Static<typeof Externalagnes_v1_ApprovalGrantRecord>
export const ApprovalGrantRecord = RuntimePublic16.Import('ApprovalGrantRecord')
export type ApprovalGrantRecord = Static<typeof ApprovalGrantRecord>
export const Externaljobs_ContentBlock = RuntimePublic16.Import('Externaljobs_ContentBlock')
export type Externaljobs_ContentBlock = Static<typeof Externaljobs_ContentBlock>
export const Externaljobs_JsonValue = RuntimePublic16.Import('Externaljobs_JsonValue')
export type Externaljobs_JsonValue = Static<typeof Externaljobs_JsonValue>
export const Externaljobs_Schedule = RuntimePublic16.Import('Externaljobs_Schedule')
export type Externaljobs_Schedule = Static<typeof Externaljobs_Schedule>
export const Externaljobs_JobSpec = RuntimePublic16.Import('Externaljobs_JobSpec')
export type Externaljobs_JobSpec = Static<typeof Externaljobs_JobSpec>
export const Externalagnes_v1_JobSpec = RuntimePublic16.Import('Externalagnes_v1_JobSpec')
export type Externalagnes_v1_JobSpec = Static<typeof Externalagnes_v1_JobSpec>
export const JobSpec = RuntimePublic16.Import('JobSpec')
export type JobSpec = Static<typeof JobSpec>
export const SkinTokenValue = RuntimePublic16.Import('SkinTokenValue')
export type SkinTokenValue = Static<typeof SkinTokenValue>
export const Cursor = RuntimePublic16.Import('Cursor')
export type Cursor = Static<typeof Cursor>
export const DomainActionRef = RuntimePublic16.Import('DomainActionRef')
export type DomainActionRef = Static<typeof DomainActionRef>
export const CommandHandle = RuntimePublic16.Import('CommandHandle')
export type CommandHandle = Static<typeof CommandHandle>
export const ProtocolRange = RuntimePublic16.Import('ProtocolRange')
export type ProtocolRange = Static<typeof ProtocolRange>
export const ViewSchemaRange = RuntimePublic16.Import('ViewSchemaRange')
export type ViewSchemaRange = Static<typeof ViewSchemaRange>
export const NegotiatedClientCapabilities = RuntimePublic16.Import('NegotiatedClientCapabilities')
export type NegotiatedClientCapabilities = Static<typeof NegotiatedClientCapabilities>
export const InteractionResponseStatus = RuntimePublic16.Import('InteractionResponseStatus')
export type InteractionResponseStatus = Static<typeof InteractionResponseStatus>
export const InteractionFormLink = RuntimePublic16.Import('InteractionFormLink')
export type InteractionFormLink = Static<typeof InteractionFormLink>
export const ArtifactDownloadTicket = RuntimePublic16.Import('ArtifactDownloadTicket')
export type ArtifactDownloadTicket = Static<typeof ArtifactDownloadTicket>
export const ClientModule = RuntimePublic16.Import('ClientModule')
export type ClientModule = Static<typeof ClientModule>
export const ClientWelcome = RuntimePublic16.Import('ClientWelcome')
export type ClientWelcome = Static<typeof ClientWelcome>
export const JobTarget = RuntimePublic16.Import('JobTarget')
export type JobTarget = Static<typeof JobTarget>
export const JobSchedule = RuntimePublic16.Import('JobSchedule')
export type JobSchedule = Static<typeof JobSchedule>
export const JobPolicy = RuntimePublic16.Import('JobPolicy')
export type JobPolicy = Static<typeof JobPolicy>
export const JobEdit = RuntimePublic16.Import('JobEdit')
export type JobEdit = Static<typeof JobEdit>
export const DomainCommandClientSubmitRequest = RuntimePublic16.Import('DomainCommandClientSubmitRequest')
export type DomainCommandClientSubmitRequest = Static<typeof DomainCommandClientSubmitRequest>
export const ShellConversationClientCreateRequest = RuntimePublic16.Import('ShellConversationClientCreateRequest')
export type ShellConversationClientCreateRequest = Static<typeof ShellConversationClientCreateRequest>
export const ShellConversationClientCreateResult = RuntimePublic16.Import('ShellConversationClientCreateResult')
export type ShellConversationClientCreateResult = Static<typeof ShellConversationClientCreateResult>
export const ShellConversationClientSubmitRequest = RuntimePublic16.Import('ShellConversationClientSubmitRequest')
export type ShellConversationClientSubmitRequest = Static<typeof ShellConversationClientSubmitRequest>
export const ShellConversationClientCancelRequest = RuntimePublic16.Import('ShellConversationClientCancelRequest')
export type ShellConversationClientCancelRequest = Static<typeof ShellConversationClientCancelRequest>
export const PermissionClientRevokeGrantRequest = RuntimePublic16.Import('PermissionClientRevokeGrantRequest')
export type PermissionClientRevokeGrantRequest = Static<typeof PermissionClientRevokeGrantRequest>
export const SessionJobsClientEnqueueRequest = RuntimePublic16.Import('SessionJobsClientEnqueueRequest')
export type SessionJobsClientEnqueueRequest = Static<typeof SessionJobsClientEnqueueRequest>
export const SessionJobsClientEnqueueResult = RuntimePublic16.Import('SessionJobsClientEnqueueResult')
export type SessionJobsClientEnqueueResult = Static<typeof SessionJobsClientEnqueueResult>
export const SessionJobsClientCancelRequest = RuntimePublic16.Import('SessionJobsClientCancelRequest')
export type SessionJobsClientCancelRequest = Static<typeof SessionJobsClientCancelRequest>
export const SessionJobsClientCancelResult = RuntimePublic16.Import('SessionJobsClientCancelResult')
export type SessionJobsClientCancelResult = Static<typeof SessionJobsClientCancelResult>
export const SessionJobsClientCreateRequest = RuntimePublic16.Import('SessionJobsClientCreateRequest')
export type SessionJobsClientCreateRequest = Static<typeof SessionJobsClientCreateRequest>
export const SessionJobsClientUpdateRequest = RuntimePublic16.Import('SessionJobsClientUpdateRequest')
export type SessionJobsClientUpdateRequest = Static<typeof SessionJobsClientUpdateRequest>
export const SessionJobsClientCancelDefinitionRequest = RuntimePublic16.Import('SessionJobsClientCancelDefinitionRequest')
export type SessionJobsClientCancelDefinitionRequest = Static<typeof SessionJobsClientCancelDefinitionRequest>
export const InteractionClientRespondRequest = RuntimePublic16.Import('InteractionClientRespondRequest')
export type InteractionClientRespondRequest = Static<typeof InteractionClientRespondRequest>
export const ArtifactClientOpenDownloadRequest = RuntimePublic16.Import('ArtifactClientOpenDownloadRequest')
export type ArtifactClientOpenDownloadRequest = Static<typeof ArtifactClientOpenDownloadRequest>
export const ClientInteractionFormLinkInput = RuntimePublic16.Import('ClientInteractionFormLinkInput')
export type ClientInteractionFormLinkInput = Static<typeof ClientInteractionFormLinkInput>
export const ClientCallHeader = RuntimePublic16.Import('ClientCallHeader')
export type ClientCallHeader = Static<typeof ClientCallHeader>
export const ClientCommandCall = RuntimePublic16.Import('ClientCommandCall')
export type ClientCommandCall = Static<typeof ClientCommandCall>
export const ClientCommandValue = RuntimePublic16.Import('ClientCommandValue')
export type ClientCommandValue = Static<typeof ClientCommandValue>
export const ClientCommandRequest = RuntimePublic16.Import('ClientCommandRequest')
export type ClientCommandRequest = Static<typeof ClientCommandRequest>
export const ClientCommandReply = RuntimePublic16.Import('ClientCommandReply')
export type ClientCommandReply = Static<typeof ClientCommandReply>
export const ClientBootstrapRejected = RuntimePublic16.Import('ClientBootstrapRejected')
export type ClientBootstrapRejected = Static<typeof ClientBootstrapRejected>
export const ClientCatalogPageState = RuntimePublic16.Import('ClientCatalogPageState')
export type ClientCatalogPageState = Static<typeof ClientCatalogPageState>
export const ClientBootstrapAccepted = RuntimePublic16.Import('ClientBootstrapAccepted')
export type ClientBootstrapAccepted = Static<typeof ClientBootstrapAccepted>
export const ClientBootstrapResult = RuntimePublic16.Import('ClientBootstrapResult')
export type ClientBootstrapResult = Static<typeof ClientBootstrapResult>
export const ClientCatalogPageRequest = RuntimePublic16.Import('ClientCatalogPageRequest')
export type ClientCatalogPageRequest = Static<typeof ClientCatalogPageRequest>
export const ClientCatalogPageResult = RuntimePublic16.Import('ClientCatalogPageResult')
export type ClientCatalogPageResult = Static<typeof ClientCatalogPageResult>
export const ClientInteractionChange = RuntimePublic16.Import('ClientInteractionChange')
export type ClientInteractionChange = Static<typeof ClientInteractionChange>
