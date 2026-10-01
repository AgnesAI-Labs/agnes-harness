// generated from schema by tools/gen.ts — do not edit
import { Type, type Static } from '@sinclair/typebox'

export const JsonValue = Type.Recursive((This) => Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String(), Type.Array(This, { minItems: 0, maxItems: 10000 }), Type.Record(Type.String(), This)]))
export type JsonValue = Static<typeof JsonValue>

export const RuntimePublic17 = Type.Module({
  "Id": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }),
  "UInt53": Type.Integer({ minimum: 0, maximum: 9007199254740991 }),
  "TypeId": Type.String({ minLength: 1, maxLength: 256, pattern: "^[a-z][a-z0-9.-]*/[a-zA-Z0-9._/-]+@[1-9][0-9]*$" }),
  "Digest": Type.String({ pattern: "^[a-f0-9]{64}$" }),
  "SchemaRef": Type.Object({ "typeId": Type.Ref('TypeId'), "revision": Type.Ref('UInt53'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "BlobRef": Type.Object({ "authorityId": Type.Ref('Id'), "blobId": Type.Ref('Id'), "digest": Type.Ref('Digest'), "bytes": Type.Ref('UInt53'), "mediaType": Type.String(), "pinId": Type.Ref('Id') }, { additionalProperties: false }),
  "DataRef": Type.Union([Type.Object({ "kind": Type.Literal('inline'), "schema": Type.Ref('SchemaRef'), "value": JsonValue, "digest": Type.Ref('Digest'), "bytes": Type.Ref('UInt53') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('blob'), "schema": Type.Ref('SchemaRef'), "blob": Type.Ref('BlobRef') }, { additionalProperties: false })]),
  "ScopeRef": Type.Union([Type.Object({ "installationId": Type.Ref('Id'), "kind": Type.Literal('installation') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "kind": Type.Literal('runtime') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "kind": Type.Literal('workspace') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "kind": Type.Literal('session') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "runId": Type.Ref('Id'), "kind": Type.Literal('run') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "runId": Type.Ref('Id'), "kind": Type.Literal('action'), "actionId": Type.Ref('Id') }, { additionalProperties: false })]),
  "ArtifactVersion": Type.Integer({ minimum: 1, maximum: 9007199254740991 }),
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
  "ClientQueryRequest": Object.assign(Type.Object({ "header": Type.Ref('ClientCallHeader'), "call": Type.Ref('ClientQueryCall') }, { additionalProperties: false }), {"x-max-canonical-json-bytes":1048576}),
})

export const Id = RuntimePublic17.Import('Id')
export type Id = Static<typeof Id>
export const UInt53 = RuntimePublic17.Import('UInt53')
export type UInt53 = Static<typeof UInt53>
export const TypeId = RuntimePublic17.Import('TypeId')
export type TypeId = Static<typeof TypeId>
export const Digest = RuntimePublic17.Import('Digest')
export type Digest = Static<typeof Digest>
export const SchemaRef = RuntimePublic17.Import('SchemaRef')
export type SchemaRef = Static<typeof SchemaRef>
export const BlobRef = RuntimePublic17.Import('BlobRef')
export type BlobRef = Static<typeof BlobRef>
export const DataRef = RuntimePublic17.Import('DataRef')
export type DataRef = Static<typeof DataRef>
export const ScopeRef = RuntimePublic17.Import('ScopeRef')
export type ScopeRef = Static<typeof ScopeRef>
export const ArtifactVersion = RuntimePublic17.Import('ArtifactVersion')
export type ArtifactVersion = Static<typeof ArtifactVersion>
export const Cursor = RuntimePublic17.Import('Cursor')
export type Cursor = Static<typeof Cursor>
export const AuthorizedViewScope = RuntimePublic17.Import('AuthorizedViewScope')
export type AuthorizedViewScope = Static<typeof AuthorizedViewScope>
export const DomainQuery = RuntimePublic17.Import('DomainQuery')
export type DomainQuery = Static<typeof DomainQuery>
export const ApprovalGrantBindingInput = RuntimePublic17.Import('ApprovalGrantBindingInput')
export type ApprovalGrantBindingInput = Static<typeof ApprovalGrantBindingInput>
export const DomainCommandClientCommandStatusRequest = RuntimePublic17.Import('DomainCommandClientCommandStatusRequest')
export type DomainCommandClientCommandStatusRequest = Static<typeof DomainCommandClientCommandStatusRequest>
export const ShellConversationClientOpenRequest = RuntimePublic17.Import('ShellConversationClientOpenRequest')
export type ShellConversationClientOpenRequest = Static<typeof ShellConversationClientOpenRequest>
export const ShellConversationClientHistoryRequest = RuntimePublic17.Import('ShellConversationClientHistoryRequest')
export type ShellConversationClientHistoryRequest = Static<typeof ShellConversationClientHistoryRequest>
export const ShellConversationClientStatusRequest = RuntimePublic17.Import('ShellConversationClientStatusRequest')
export type ShellConversationClientStatusRequest = Static<typeof ShellConversationClientStatusRequest>
export const SessionControlClientStatusRequest = RuntimePublic17.Import('SessionControlClientStatusRequest')
export type SessionControlClientStatusRequest = Static<typeof SessionControlClientStatusRequest>
export const SessionBudgetClientReadRequest = RuntimePublic17.Import('SessionBudgetClientReadRequest')
export type SessionBudgetClientReadRequest = Static<typeof SessionBudgetClientReadRequest>
export const SessionJobsClientPollRequest = RuntimePublic17.Import('SessionJobsClientPollRequest')
export type SessionJobsClientPollRequest = Static<typeof SessionJobsClientPollRequest>
export const SessionJobsClientInspectRequest = RuntimePublic17.Import('SessionJobsClientInspectRequest')
export type SessionJobsClientInspectRequest = Static<typeof SessionJobsClientInspectRequest>
export const InteractionClientPendingRequest = RuntimePublic17.Import('InteractionClientPendingRequest')
export type InteractionClientPendingRequest = Static<typeof InteractionClientPendingRequest>
export const ArtifactDescribeInput = RuntimePublic17.Import('ArtifactDescribeInput')
export type ArtifactDescribeInput = Static<typeof ArtifactDescribeInput>
export const ClientCallHeader = RuntimePublic17.Import('ClientCallHeader')
export type ClientCallHeader = Static<typeof ClientCallHeader>
export const ClientCatalogStatusRequest = RuntimePublic17.Import('ClientCatalogStatusRequest')
export type ClientCatalogStatusRequest = Static<typeof ClientCatalogStatusRequest>
export const ClientArtifactStreamStatusRequest = RuntimePublic17.Import('ClientArtifactStreamStatusRequest')
export type ClientArtifactStreamStatusRequest = Static<typeof ClientArtifactStreamStatusRequest>
export const ConversationListRequest = RuntimePublic17.Import('ConversationListRequest')
export type ConversationListRequest = Static<typeof ConversationListRequest>
export const ClientQueryCall = RuntimePublic17.Import('ClientQueryCall')
export type ClientQueryCall = Static<typeof ClientQueryCall>
export const ClientQueryRequest = RuntimePublic17.Import('ClientQueryRequest')
export type ClientQueryRequest = Static<typeof ClientQueryRequest>
