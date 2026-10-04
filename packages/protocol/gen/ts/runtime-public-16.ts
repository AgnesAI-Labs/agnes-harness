import type { Page } from './runtime-public.js'
// generated from schema by tools/gen.ts — do not edit
import { Type, type Static } from '@sinclair/typebox'
import { FormatRegistry } from '@sinclair/typebox'

if (!FormatRegistry.Has('date-time')) FormatRegistry.Set('date-time', (value) => { const parts = value.split(/t/i); if (parts.length !== 2) return false; const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(parts[0] ?? ''); const time = /^(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)(z|([+-])(\d{2}):(\d{2}))$/i.exec(parts[1] ?? ''); if (!date || !time) return false; const year = Number(date[1]), month = Number(date[2]), day = Number(date[3]); const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0); const days = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; if (month < 1 || month > 12 || day < 1 || day > (days[month] ?? 0)) return false; const hour = Number(time[1]), minute = Number(time[2]), second = Number(time[3]); const offsetHour = Number(time[6] || 0), offsetMinute = Number(time[7] || 0); if (hour > 23 || minute > 59 || offsetHour > 23 || offsetMinute > 59) return false; if (second < 60) return true; const sign = time[5] === '-' ? -1 : 1; const utcMinute = minute - offsetMinute * sign; const utcHour = hour - offsetHour * sign - (utcMinute < 0 ? 1 : 0); return (utcHour === 23 || utcHour === -1) && (utcMinute === 59 || utcMinute === -1) && second < 61; })

export const JsonValue = Type.Recursive((This) => Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String(), Type.Array(This, { minItems: 0, maxItems: 10000 }), Type.Record(Type.String(), This)]))
export type JsonValue = Static<typeof JsonValue>

export const RuntimePublic16 = Type.Module({
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
  "ScopeRef": Type.Union([Type.Object({ "installationId": Type.Ref('Id'), "kind": Type.Literal('installation') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "kind": Type.Literal('runtime') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "kind": Type.Literal('workspace') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "kind": Type.Literal('session') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "runId": Type.Ref('Id'), "kind": Type.Literal('run') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "runId": Type.Ref('Id'), "kind": Type.Literal('action'), "actionId": Type.Ref('Id') }, { additionalProperties: false })]),
  "ArtifactVersion": Type.Integer({ minimum: 1, maximum: 9007199254740991 }),
  "ArtifactReadStreamEndResult": Type.Object({ "bytes": Type.Ref('UInt53'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "Cursor": Type.String(),
  "AuthorizedViewScope": Type.Union([Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "kind": Type.Literal('workspace') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "kind": Type.Literal('session') }, { additionalProperties: false })]),
  "DomainQuery": Type.Object({ "domainType": Type.String(), "query": Type.Ref('DataRef'), "scope": Type.Ref('ScopeRef'), "cursor": Type.Union([Type.String(), Type.Null()]), "limit": Type.Integer({ minimum: 1, maximum: 500 }) }, { additionalProperties: false }),
  "ApprovalGrantBindingInput": Type.Object({ "sessionId": Type.Ref('Id'), "toolId": Type.String(), "scope": Type.String(), "policyVersion": Type.String() }, { additionalProperties: false }),
  "DomainCommandClientCommandStatusRequest": Type.String(),
  "ShellConversationClientOpenRequest": Type.Object({ "sessionId": Type.String(), "limit": Type.Number() }, { additionalProperties: false }),
  "ShellConversationClientHistoryRequest": Type.Object({ "sessionId": Type.String(), "cursor": Type.String(), "limit": Type.Number() }, { additionalProperties: false }),
  "ShellConversationClientStatusRequest": Type.String(),
  "SessionControlClientStatusRequest": Type.Object({ "sessionId": Type.Ref('Id'), "requestId": Type.Ref('Id') }, { additionalProperties: false }),
  "SessionBudgetClientReadRequest": Type.Object({ "sessionId": Type.Ref('Id') }, { additionalProperties: false }),
  "SessionJobsClientPollRequest": Type.Object({ "jobId": Type.Ref('Id') }, { additionalProperties: false }),
  "SessionJobsClientInspectRequest": Type.Object({ "id": Type.Ref('Id'), "cursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "limit": Type.Ref('UInt53') }, { additionalProperties: false }),
  "InteractionClientPendingRequest": Type.Object({ "scope": Type.Ref('AuthorizedViewScope'), "cursor": Type.Optional(Type.Ref('Cursor')), "limit": Type.Optional(Type.Ref('UInt53')) }, { additionalProperties: false }),
  "ArtifactDescribeInput": Type.Object({ "artifactId": Type.Ref('Id'), "version": Type.Ref('ArtifactVersion') }, { additionalProperties: false }),
  "ClientCallHeader": Type.Object({ "negotiatedSession": Type.Ref('Id'), "clientInstanceId": Type.Ref('Id'), "catalogRevision": Type.Ref('UInt53'), "callId": Type.Ref('Id') }, { additionalProperties: false }),
  "ClientCatalogStatusRequest": Type.Object({ "header": Type.Ref('ClientCallHeader') }, { additionalProperties: false }),
  "ClientArtifactStreamStatusRequest": Type.Object({ "header": Type.Ref('ClientCallHeader'), "streamId": Type.Ref('Id') }, { additionalProperties: false }),
  "ConversationListRequest": Type.Object({ "scope": Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "kind": Type.Literal('workspace') }, { additionalProperties: false }), "text": Type.Union([Object.assign(Type.String(), {"x-max-utf8-bytes":1024}), Type.Null()]), "cursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "limit": Type.Integer({ minimum: 1, maximum: 128 }) }, { additionalProperties: false }),
  "ClientQueryCall": Type.Union([Type.Object({ "operation": Type.Literal('conversation.open'), "input": Type.Ref('ShellConversationClientOpenRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('conversation.history'), "input": Type.Ref('ShellConversationClientHistoryRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('conversation.status'), "input": Type.Ref('ShellConversationClientStatusRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('domain.query'), "input": Type.Ref('DomainQuery') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('domain.commandStatus'), "input": Type.Ref('DomainCommandClientCommandStatusRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('control.read'), "input": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('control.status'), "input": Type.Ref('SessionControlClientStatusRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('budget.read'), "input": Type.Ref('SessionBudgetClientReadRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('permission.listGrants'), "input": Type.Ref('ApprovalGrantBindingInput') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('jobs.poll'), "input": Type.Ref('SessionJobsClientPollRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('jobs.inspect'), "input": Type.Ref('SessionJobsClientInspectRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('jobs.commandStatus'), "input": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('interaction.pending'), "input": Type.Ref('InteractionClientPendingRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('interaction.read'), "input": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('interaction.responseStatus'), "input": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('approval.read'), "input": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('approval.responseStatus'), "input": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('artifact.describe'), "input": Type.Ref('ArtifactDescribeInput') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('transport.catalogStatus'), "input": Type.Ref('ClientCatalogStatusRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('transport.streamStatus'), "input": Type.Ref('ClientArtifactStreamStatusRequest') }, { additionalProperties: false }), Type.Object({ "operation": Type.Literal('conversation.list'), "input": Type.Ref('ConversationListRequest') }, { additionalProperties: false })]),
  "ClientCatalogStatusResult": Type.Object({ "catalogRevision": Type.Ref('UInt53'), "mode": Type.Union([Type.Literal('compatible'), Type.Literal('degraded'), Type.Literal('reload-required')]), "reasonCode": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false }),
  "ClientArtifactStreamStatusResult": Type.Union([Type.Object({ "streamId": Type.Ref('Id'), "state": Type.Literal('streaming'), "bytes": Type.Ref('UInt53'), "summary": Type.Null(), "error": Type.Null() }, { additionalProperties: false }), Type.Object({ "streamId": Type.Ref('Id'), "state": Type.Literal('succeeded'), "bytes": Type.Ref('UInt53'), "summary": Type.Ref('ArtifactReadStreamEndResult'), "error": Type.Null() }, { additionalProperties: false }), Type.Object({ "streamId": Type.Ref('Id'), "state": Type.Union([Type.Literal('failed'), Type.Literal('cancelled')]), "bytes": Type.Ref('UInt53'), "summary": Type.Null(), "error": Type.Ref('RuntimeError') }, { additionalProperties: false }), Type.Object({ "streamId": Type.Ref('Id'), "state": Type.Literal('unknown'), "bytes": Type.Null(), "summary": Type.Null(), "error": Type.Null() }, { additionalProperties: false })]),
  "ConversationSummary": Type.Object({ "sessionId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "title": Object.assign(Type.String(), {"x-max-utf8-bytes":8192}), "updatedAt": Type.Ref('Timestamp'), "revision": Type.Ref('UInt53') }, { additionalProperties: false }),
  "PageConversationSummary": Type.Object({ "items": Type.Array(Type.Ref('ConversationSummary'), { maxItems: 128 }), "snapshot": Type.Ref('Id'), "nextCursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "complete": Type.Boolean() }, { additionalProperties: false }),
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
export const ScopeRef = RuntimePublic16.Import('ScopeRef')
export type ScopeRef = Static<typeof ScopeRef>
export const ArtifactVersion = RuntimePublic16.Import('ArtifactVersion')
export type ArtifactVersion = Static<typeof ArtifactVersion>
export const ArtifactReadStreamEndResult = RuntimePublic16.Import('ArtifactReadStreamEndResult')
export type ArtifactReadStreamEndResult = Static<typeof ArtifactReadStreamEndResult>
export const Cursor = RuntimePublic16.Import('Cursor')
export type Cursor = Static<typeof Cursor>
export const AuthorizedViewScope = RuntimePublic16.Import('AuthorizedViewScope')
export type AuthorizedViewScope = Static<typeof AuthorizedViewScope>
export const DomainQuery = RuntimePublic16.Import('DomainQuery')
export type DomainQuery = Static<typeof DomainQuery>
export const ApprovalGrantBindingInput = RuntimePublic16.Import('ApprovalGrantBindingInput')
export type ApprovalGrantBindingInput = Static<typeof ApprovalGrantBindingInput>
export const DomainCommandClientCommandStatusRequest = RuntimePublic16.Import('DomainCommandClientCommandStatusRequest')
export type DomainCommandClientCommandStatusRequest = Static<typeof DomainCommandClientCommandStatusRequest>
export const ShellConversationClientOpenRequest = RuntimePublic16.Import('ShellConversationClientOpenRequest')
export type ShellConversationClientOpenRequest = Static<typeof ShellConversationClientOpenRequest>
export const ShellConversationClientHistoryRequest = RuntimePublic16.Import('ShellConversationClientHistoryRequest')
export type ShellConversationClientHistoryRequest = Static<typeof ShellConversationClientHistoryRequest>
export const ShellConversationClientStatusRequest = RuntimePublic16.Import('ShellConversationClientStatusRequest')
export type ShellConversationClientStatusRequest = Static<typeof ShellConversationClientStatusRequest>
export const SessionControlClientStatusRequest = RuntimePublic16.Import('SessionControlClientStatusRequest')
export type SessionControlClientStatusRequest = Static<typeof SessionControlClientStatusRequest>
export const SessionBudgetClientReadRequest = RuntimePublic16.Import('SessionBudgetClientReadRequest')
export type SessionBudgetClientReadRequest = Static<typeof SessionBudgetClientReadRequest>
export const SessionJobsClientPollRequest = RuntimePublic16.Import('SessionJobsClientPollRequest')
export type SessionJobsClientPollRequest = Static<typeof SessionJobsClientPollRequest>
export const SessionJobsClientInspectRequest = RuntimePublic16.Import('SessionJobsClientInspectRequest')
export type SessionJobsClientInspectRequest = Static<typeof SessionJobsClientInspectRequest>
export const InteractionClientPendingRequest = RuntimePublic16.Import('InteractionClientPendingRequest')
export type InteractionClientPendingRequest = Static<typeof InteractionClientPendingRequest>
export const ArtifactDescribeInput = RuntimePublic16.Import('ArtifactDescribeInput')
export type ArtifactDescribeInput = Static<typeof ArtifactDescribeInput>
export const ClientCallHeader = RuntimePublic16.Import('ClientCallHeader')
export type ClientCallHeader = Static<typeof ClientCallHeader>
export const ClientCatalogStatusRequest = RuntimePublic16.Import('ClientCatalogStatusRequest')
export type ClientCatalogStatusRequest = Static<typeof ClientCatalogStatusRequest>
export const ClientArtifactStreamStatusRequest = RuntimePublic16.Import('ClientArtifactStreamStatusRequest')
export type ClientArtifactStreamStatusRequest = Static<typeof ClientArtifactStreamStatusRequest>
export const ConversationListRequest = RuntimePublic16.Import('ConversationListRequest')
export type ConversationListRequest = Static<typeof ConversationListRequest>
export const ClientQueryCall = RuntimePublic16.Import('ClientQueryCall')
export type ClientQueryCall = Static<typeof ClientQueryCall>
export const ClientCatalogStatusResult = RuntimePublic16.Import('ClientCatalogStatusResult')
export type ClientCatalogStatusResult = Static<typeof ClientCatalogStatusResult>
export const ClientArtifactStreamStatusResult = RuntimePublic16.Import('ClientArtifactStreamStatusResult')
export type ClientArtifactStreamStatusResult = Static<typeof ClientArtifactStreamStatusResult>
export const ConversationSummary = RuntimePublic16.Import('ConversationSummary')
export type ConversationSummary = Static<typeof ConversationSummary>
export const PageConversationSummary = RuntimePublic16.Import('PageConversationSummary')
export type PageConversationSummary = Page<ConversationSummary>
