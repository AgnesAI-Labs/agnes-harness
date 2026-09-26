// generated from schema by tools/gen.ts — do not edit
import { Type, type Static } from '@sinclair/typebox'
import { FormatRegistry } from '@sinclair/typebox'

if (!FormatRegistry.Has('date-time')) FormatRegistry.Set('date-time', (value) => { const parts = value.split(/t/i); if (parts.length !== 2) return false; const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(parts[0] ?? ''); const time = /^(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)(z|([+-])(\d{2}):(\d{2}))$/i.exec(parts[1] ?? ''); if (!date || !time) return false; const year = Number(date[1]), month = Number(date[2]), day = Number(date[3]); const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0); const days = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; if (month < 1 || month > 12 || day < 1 || day > (days[month] ?? 0)) return false; const hour = Number(time[1]), minute = Number(time[2]), second = Number(time[3]); const offsetHour = Number(time[6] || 0), offsetMinute = Number(time[7] || 0); if (hour > 23 || minute > 59 || offsetHour > 23 || offsetMinute > 59) return false; if (second < 60) return true; const sign = time[5] === '-' ? -1 : 1; const utcMinute = minute - offsetMinute * sign; const utcHour = hour - offsetHour * sign - (utcMinute < 0 ? 1 : 0); return (utcHour === 23 || utcHour === -1) && (utcMinute === 59 || utcMinute === -1) && second < 61; })

export const JsonValue = Type.Recursive((This) => Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String(), Type.Array(This), Type.Record(Type.String(), This)]))
export type JsonValue = Static<typeof JsonValue>

export const ResourceControlSchema = Type.Module({
  "ResourcePermission": Type.Union([Type.Literal('resources.read'), Type.Literal('resources.skills.write'), Type.Literal('resources.reconcile'), Type.Literal('skills.refresh'), Type.Literal('skills.trust'), Type.Literal('mcp.read'), Type.Literal('mcp.tools.read'), Type.Literal('mcp.manage'), Type.Literal('mcp.trust'), Type.Literal('mcp.test'), Type.Literal('mcp.activate'), Type.Literal('mcp.reconnect'), Type.Literal('secrets.use')]),
  "ProfileId": Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-z][a-z0-9._-]{0,127}$" }),
  "ResourceId": Type.String({ minLength: 1, maxLength: 384, pattern: "^(?:skill|mcp)/[a-z0-9][a-z0-9._/-]{0,255}$" }),
  "ServerId": Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-z][a-z0-9._-]{0,127}$" }),
  "Revision": Type.String({ pattern: "^[a-f0-9]{64}$" }),
  "WorkspaceId": Type.String({ pattern: "^[a-f0-9]{64}$" }),
  "CommandId": Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" }),
  "ClientId": Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" }),
  "SourceScope": Type.Union([Type.Literal('workspace'), Type.Literal('user'), Type.Literal('package'), Type.Literal('runtime')]),
  "SkillRootKey": Type.Union([Type.Literal('workspace-agnes'), Type.Literal('user-agnes'), Type.Literal('user-agents'), Type.Literal('user-claude'), Type.Literal('user-codex'), Type.Literal('package'), Type.Literal('runtime')]),
  "SkillRootDiagnostic": Type.Object({ "code": Type.Union([Type.Literal('root-unreadable'), Type.Literal('root-unresolvable'), Type.Literal('entry-limit'), Type.Literal('root-bytes-limit'), Type.Literal('workspace-key-missing'), Type.Literal('entry-outside-root'), Type.Literal('skill-file-unreadable'), Type.Literal('skill-body-too-large'), Type.Literal('invalid-frontmatter'), Type.Literal('entries-skipped')]) }, { additionalProperties: false }),
  "SkillRootStatus": Type.Object({ "rootKey": Type.Ref('SkillRootKey'), "scope": Type.Ref('SourceScope'), "state": Type.Union([Type.Literal('ready'), Type.Literal('empty'), Type.Literal('stale'), Type.Literal('unavailable')]), "workspaceId": Type.Optional(Type.Ref('WorkspaceId')), "diagnostic": Type.Optional(Type.Ref('SkillRootDiagnostic')) }, { additionalProperties: false }),
  "SkillSourceIdentity": Type.Object({ "scope": Type.Ref('SourceScope'), "rootKey": Type.Ref('SkillRootKey'), "sourceId": Type.String({ pattern: "^[a-f0-9]{64}$" }) }, { additionalProperties: false }),
  "SkillResolution": Type.Object({ "winner": Type.Boolean(), "shadowed": Type.Array(Type.Object({ "resourceId": Type.Ref('ResourceId'), "sourceIdentity": Type.Ref('SkillSourceIdentity'), "revision": Type.Ref('Revision'), "reason": Type.Literal('lower-priority') }, { additionalProperties: false }), { maxItems: 32 }) }, { additionalProperties: false }),
  "TrustState": Type.Union([Type.Literal('untrusted'), Type.Literal('trusted'), Type.Literal('rejected')]),
  "DesiredState": Type.Union([Type.Literal('enabled'), Type.Literal('disabled')]),
  "ActualState": Type.Union([Type.Literal('unavailable'), Type.Literal('disabled'), Type.Literal('preparing'), Type.Literal('ready'), Type.Literal('degraded')]),
  "SafeError": Type.Object({ "code": Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Z][A-Z0-9_]{0,63}$" }), "message": Type.String({ minLength: 1, maxLength: 256 }) }, { additionalProperties: false }),
  "SkillDescriptor": Type.Object({ "kind": Type.Literal('skill'), "resourceId": Type.Ref('ResourceId'), "name": Type.String({ minLength: 1, maxLength: 128 }), "description": Type.Optional(Type.String({ maxLength: 1024 })), "revision": Type.Ref('Revision'), "sourceIdentity": Type.Ref('SkillSourceIdentity'), "priority": Type.Integer({ minimum: 50, maximum: 500 }), "resolution": Type.Ref('SkillResolution'), "trust": Type.Ref('TrustState'), "desired": Type.Ref('DesiredState'), "actual": Type.Ref('ActualState'), "stale": Type.Boolean(), "lastSafeError": Type.Optional(Type.Ref('SafeError')), "workspaceId": Type.Optional(Type.Ref('WorkspaceId')) }, { additionalProperties: false }),
  "McpEnvName": Type.String({ pattern: "^(?!(?:PATH|HOME|SHELL|NODE_OPTIONS|LD_PRELOAD|DYLD_INSERT_LIBRARIES)$)[A-Z][A-Z0-9_]{0,63}$" }),
  "McpStdioTransport": Type.Object({ "kind": Type.Literal('stdio'), "executable": Type.String({ minLength: 1, maxLength: 512, pattern: "^(?!(?:.*[/\\\\])?(?:[sS][hH]|[bB][aA][sS][hH]|[zZ][sS][hH]|[fF][iI][sS][hH]|[cC][mM][dD]|[pP][oO][wW][eE][rR][sS][hH][eE][lL][lL]|[pP][wW][sS][hH])(?:\\.[eE][xX][eE])?$)(?:[^\\x00-\\x1f\\x7f\\s]+|(?:/|[a-zA-Z]:[/\\\\]|\\\\\\\\)[^\\x00-\\x1f\\x7f]+)$" }), "args": Type.Array(Type.String({ maxLength: 512, pattern: "^(?!-c$|/c$)[^\\x00\\r\\n]+$" }), { maxItems: 32 }) }, { additionalProperties: false }),
  "McpHttpTransport": Type.Object({ "kind": Type.Literal('http'), "url": Type.String({ minLength: 8, maxLength: 2048, pattern: "^https?://(?![^/]*@)(?![^#?]*\\?(?:[^#]*&)?(?:token|key|secret|credential|password)=)[^\\s#?]+(?:/[^\\s#?]*)?(?:\\?[^\\s#]*)?$" }) }, { additionalProperties: false }),
  "McpSseTransport": Type.Object({ "kind": Type.Literal('sse'), "url": Type.String({ minLength: 8, maxLength: 2048, pattern: "^https?://(?![^/]*@)(?![^#?]*\\?(?:[^#]*&)?(?:token|key|secret|credential|password)=)[^\\s#?]+(?:/[^\\s#?]*)?(?:\\?[^\\s#]*)?$" }) }, { additionalProperties: false }),
  "McpSecretBinding": Type.Union([Type.Object({ "kind": Type.Literal('none') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('stdio-env'), "env": Type.Record(Type.String({ pattern: '^(?!(?:PATH|HOME|SHELL|NODE_OPTIONS|LD_PRELOAD|DYLD_INSERT_LIBRARIES)$)[A-Z][A-Z0-9_]{0,63}$' }), Type.Ref('SecretRef'), { additionalProperties: false, minProperties: 1, maxProperties: 16 }) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('http-bearer'), "credentialRef": Type.Ref('SecretRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('http-header'), "headerName": Type.Union([Type.Literal('x-api-key'), Type.Literal('x-api-token')]), "credentialRef": Type.Ref('SecretRef') }, { additionalProperties: false })]),
  "McpStdioSecretBinding": Type.Union([Type.Object({ "kind": Type.Literal('none') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('stdio-env'), "env": Type.Record(Type.String({ pattern: '^(?!(?:PATH|HOME|SHELL|NODE_OPTIONS|LD_PRELOAD|DYLD_INSERT_LIBRARIES)$)[A-Z][A-Z0-9_]{0,63}$' }), Type.Ref('SecretRef'), { additionalProperties: false, minProperties: 1, maxProperties: 16 }) }, { additionalProperties: false })]),
  "McpOAuthSecretBinding": Type.Object({ "kind": Type.Literal('oauth'), "staticClientId": Type.Optional(Type.String({ minLength: 1, maxLength: 512 })) }, { additionalProperties: false }),
  "McpHttpSecretBinding": Type.Union([Type.Object({ "kind": Type.Literal('none') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('http-bearer'), "credentialRef": Type.Ref('SecretRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('http-header'), "headerName": Type.Union([Type.Literal('x-api-key'), Type.Literal('x-api-token')]), "credentialRef": Type.Ref('SecretRef') }, { additionalProperties: false }), Type.Ref('McpOAuthSecretBinding')]),
  "McpToolPolicy": Type.Object({ "allow": Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z][A-Za-z0-9_.-]{0,127}$" }), { maxItems: 128, uniqueItems: true })) }, { additionalProperties: false }),
  "McpServerDefinitionInput": Type.Union([Type.Object({ "serverId": Type.Ref('ServerId'), "displayName": Type.String({ minLength: 1, maxLength: 128 }), "transport": Type.Ref('McpStdioTransport'), "secretBinding": Type.Ref('McpStdioSecretBinding'), "toolPolicy": Type.Optional(Type.Ref('McpToolPolicy')) }, { additionalProperties: false }), Type.Object({ "serverId": Type.Ref('ServerId'), "displayName": Type.String({ minLength: 1, maxLength: 128 }), "transport": Type.Ref('McpHttpTransport'), "secretBinding": Type.Ref('McpHttpSecretBinding'), "toolPolicy": Type.Optional(Type.Ref('McpToolPolicy')) }, { additionalProperties: false }), Type.Object({ "serverId": Type.Ref('ServerId'), "displayName": Type.String({ minLength: 1, maxLength: 128 }), "transport": Type.Ref('McpSseTransport'), "secretBinding": Type.Ref('McpHttpSecretBinding'), "toolPolicy": Type.Optional(Type.Ref('McpToolPolicy')) }, { additionalProperties: false })]),
  "McpServerDescriptor": Type.Object({ "kind": Type.Literal('mcp'), "resourceId": Type.Ref('ResourceId'), "serverId": Type.Ref('ServerId'), "displayName": Type.String({ minLength: 1, maxLength: 128 }), "revision": Type.Ref('Revision'), "definition": Type.Ref('McpServerDefinitionInput'), "transportKind": Type.Union([Type.Literal('stdio'), Type.Literal('http'), Type.Literal('sse')]), "secretBindingKind": Type.Union([Type.Literal('none'), Type.Literal('stdio-env'), Type.Literal('http-bearer'), Type.Literal('http-header'), Type.Literal('oauth')]), "trust": Type.Ref('TrustState'), "desired": Type.Ref('DesiredState'), "actual": Type.Ref('ActualState'), "source": Type.Union([Type.Literal('managed'), Type.Literal('legacy-preset')]), "lastSafeError": Type.Optional(Type.Ref('SafeError')), "authorizationStatus": Type.Optional(Type.Union([Type.Union([Type.Literal('pending'), Type.Literal('authorized'), Type.Literal('needs-reconnect'), Type.Literal('error')]), Type.Null()])) }, { additionalProperties: false }),
  "McpStatus": Type.Object({ "serverId": Type.Ref('ServerId'), "connectionState": Type.Union([Type.Literal('disabled'), Type.Literal('connecting'), Type.Literal('ready'), Type.Literal('degraded'), Type.Literal('unavailable')]), "observedRevision": Type.Union([Type.Ref('Revision'), Type.Null()]), "catalogRevision": Type.Union([Type.Ref('Revision'), Type.Null()]), "toolCount": Type.Integer({ minimum: 0, maximum: 10000 }), "observedAt": Type.String({ format: "date-time" }), "lastSafeError": Type.Optional(Type.Ref('SafeError')) }, { additionalProperties: false }),
  "McpInputSchema": Type.Object({ "type": Type.Literal('object'), "properties": Type.Optional(Type.Record(Type.String(), JsonValue)), "required": Type.Optional(Type.Array(Type.String())), "description": Type.Optional(Type.String({ maxLength: 2048 })) }, { additionalProperties: JsonValue }),
  "McpTool": Type.Object({ "name": Type.String({ minLength: 1, maxLength: 128 }), "description": Type.String({ maxLength: 1024 }), "inputSchema": Type.Ref('McpInputSchema') }, { additionalProperties: false }),
  "McpToolCatalogPage": Type.Object({ "serverId": Type.Ref('ServerId'), "catalogRevision": Type.Ref('Revision'), "items": Type.Array(Type.Ref('McpTool'), { maxItems: 100 }), "nextCursor": Type.Optional(Type.String({ maxLength: 256 })) }, { additionalProperties: false }),
  "ResourceOperationReceipt": Type.Object({ "operationId": Type.String({ minLength: 1, maxLength: 128 }), "state": Type.Union([Type.Literal('received'), Type.Literal('running'), Type.Literal('succeeded'), Type.Literal('failed'), Type.Literal('cancelled')]) }, { additionalProperties: false }),
  "ResourceOperation": Type.Object({ "operationId": Type.String({ minLength: 1, maxLength: 128 }), "kind": Type.String({ minLength: 1, maxLength: 64 }), "state": Type.Union([Type.Literal('received'), Type.Literal('running'), Type.Literal('succeeded'), Type.Literal('failed'), Type.Literal('cancelled')]), "profile": Type.Ref('ProfileId'), "target": Type.Ref('ResourceId'), "revision": Type.Ref('Revision'), "createdAt": Type.String({ format: "date-time" }), "updatedAt": Type.String({ format: "date-time" }), "progress": Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })), "result": Type.Optional(Type.Object({ "toolCount": Type.Optional(Type.Integer({ minimum: 0 })), "catalogRevision": Type.Optional(Type.Ref('Revision')) }, { additionalProperties: false })), "lastSafeError": Type.Optional(Type.Ref('SafeError')) }, { additionalProperties: false }),
  "ResourceDescriptor": Type.Union([Type.Ref('SkillDescriptor'), Type.Ref('McpServerDescriptor')]),
  "ResourceListParams": Type.Object({ "profile": Type.Ref('ProfileId'), "kind": Type.Optional(Type.Union([Type.Literal('skill'), Type.Literal('mcp')])), "cursor": Type.Optional(Type.String({ maxLength: 256 })), "workspaceId": Type.Optional(Type.Ref('WorkspaceId')) }, { additionalProperties: false }),
  "ResourceListResult": Type.Object({ "items": Type.Array(Type.Ref('ResourceDescriptor'), { maxItems: 100 }), "nextCursor": Type.Optional(Type.String({ maxLength: 256 })), "skillRoots": Type.Optional(Type.Array(Type.Ref('SkillRootStatus'), { maxItems: 64 })) }, { additionalProperties: false }),
  "ResourceGetParams": Type.Object({ "profile": Type.Ref('ProfileId'), "resourceId": Type.Ref('ResourceId') }, { additionalProperties: false }),
  "ResourceDesiredSetParams": Type.Object({ "profile": Type.Ref('ProfileId'), "resourceId": Type.String({ pattern: "^skill/" }), "state": Type.Ref('DesiredState'), "expectedRevision": Type.Optional(Type.Ref('Revision')), "config": Type.Optional(Type.Object({ "kind": Type.Literal('none') }, { additionalProperties: false })), "clientId": Type.Ref('ClientId'), "commandId": Type.Ref('CommandId') }, { additionalProperties: false }),
  "ResourceOperationGetParams": Type.Object({ "profile": Type.Ref('ProfileId'), "operationId": Type.String({ minLength: 1, maxLength: 128 }) }, { additionalProperties: false }),
  "ResourceOperationCancelParams": Type.Object({ "profile": Type.Ref('ProfileId'), "operationId": Type.String({ minLength: 1, maxLength: 128 }), "clientId": Type.Ref('ClientId'), "commandId": Type.Ref('CommandId') }, { additionalProperties: false }),
  "SkillRefreshParams": Type.Object({ "profile": Type.Ref('ProfileId'), "rootKey": Type.Optional(Type.Ref('SkillRootKey')), "workspaceId": Type.Optional(Type.Ref('WorkspaceId')), "reinstall": Type.Optional(Type.Object({ "resourceId": Type.String({ pattern: "^skill/" }), "expectedRevision": Type.Ref('Revision') }, { additionalProperties: false })), "clientId": Type.Ref('ClientId'), "commandId": Type.Ref('CommandId') }, { additionalProperties: false }),
  "SkillTrustSetParams": Type.Object({ "profile": Type.Ref('ProfileId'), "resourceId": Type.String({ pattern: "^skill/" }), "expectedRevision": Type.Ref('Revision'), "trust": Type.Union([Type.Literal('trusted'), Type.Literal('rejected')]), "clientId": Type.Ref('ClientId'), "commandId": Type.Ref('CommandId') }, { additionalProperties: false }),
  "SkillRemoveParams": Type.Object({ "profile": Type.Ref('ProfileId'), "resourceId": Type.String({ pattern: "^skill/" }), "expectedRevision": Type.Ref('Revision'), "clientId": Type.Ref('ClientId'), "commandId": Type.Ref('CommandId') }, { additionalProperties: false }),
  "SkillPrioritySetParams": Type.Object({ "profile": Type.Ref('ProfileId'), "resourceId": Type.String({ pattern: "^skill/" }), "expectedRevision": Type.Ref('Revision'), "clientId": Type.Ref('ClientId'), "commandId": Type.Ref('CommandId'), "priority": Type.Union([Type.Integer({ minimum: 50, maximum: 500 }), Type.Null()]), "expectedPriority": Type.Integer({ minimum: 50, maximum: 500 }) }, { additionalProperties: false }),
  "McpServerListParams": Type.Object({ "profile": Type.Ref('ProfileId'), "cursor": Type.Optional(Type.String({ maxLength: 256 })) }, { additionalProperties: false }),
  "McpServerListResult": Type.Object({ "items": Type.Array(Type.Ref('McpServerDescriptor'), { maxItems: 100 }), "nextCursor": Type.Optional(Type.String({ maxLength: 256 })) }, { additionalProperties: false }),
  "McpServerGetParams": Type.Object({ "profile": Type.Ref('ProfileId'), "serverId": Type.Ref('ServerId') }, { additionalProperties: false }),
  "McpServerCreateParams": Type.Object({ "profile": Type.Ref('ProfileId'), "definition": Type.Ref('McpServerDefinitionInput'), "clientId": Type.Ref('ClientId'), "commandId": Type.Ref('CommandId') }, { additionalProperties: false }),
  "McpServerUpdateParams": Type.Object({ "profile": Type.Ref('ProfileId'), "serverId": Type.Ref('ServerId'), "expectedRevision": Type.Ref('Revision'), "definition": Type.Ref('McpServerDefinitionInput'), "clientId": Type.Ref('ClientId'), "commandId": Type.Ref('CommandId') }, { additionalProperties: false }),
  "McpServerRemoveParams": Type.Object({ "profile": Type.Ref('ProfileId'), "serverId": Type.Ref('ServerId'), "expectedRevision": Type.Ref('Revision'), "clientId": Type.Ref('ClientId'), "commandId": Type.Ref('CommandId') }, { additionalProperties: false }),
  "McpTrustSetParams": Type.Object({ "profile": Type.Ref('ProfileId'), "serverId": Type.Ref('ServerId'), "expectedRevision": Type.Ref('Revision'), "trust": Type.Union([Type.Literal('trusted'), Type.Literal('rejected')]), "clientId": Type.Ref('ClientId'), "commandId": Type.Ref('CommandId') }, { additionalProperties: false }),
  "McpServerTestParams": Type.Object({ "profile": Type.Ref('ProfileId'), "serverId": Type.Ref('ServerId'), "expectedRevision": Type.Ref('Revision'), "clientId": Type.Ref('ClientId'), "commandId": Type.Ref('CommandId') }, { additionalProperties: false }),
  "McpServerEnableParams": Type.Object({ "profile": Type.Ref('ProfileId'), "serverId": Type.Ref('ServerId'), "expectedRevision": Type.Ref('Revision'), "clientId": Type.Ref('ClientId'), "commandId": Type.Ref('CommandId') }, { additionalProperties: false }),
  "McpServerDisableParams": Type.Object({ "profile": Type.Ref('ProfileId'), "serverId": Type.Ref('ServerId'), "expectedRevision": Type.Ref('Revision'), "clientId": Type.Ref('ClientId'), "commandId": Type.Ref('CommandId') }, { additionalProperties: false }),
  "McpServerReconnectParams": Type.Object({ "profile": Type.Ref('ProfileId'), "serverId": Type.Ref('ServerId'), "expectedRevision": Type.Ref('Revision'), "clientId": Type.Ref('ClientId'), "commandId": Type.Ref('CommandId') }, { additionalProperties: false }),
  "McpToolsListParams": Type.Object({ "profile": Type.Ref('ProfileId'), "serverId": Type.Ref('ServerId'), "cursor": Type.Optional(Type.String({ maxLength: 256 })) }, { additionalProperties: false }),
  "McpOAuthStatusSetParams": Type.Object({ "profile": Type.Ref('ProfileId'), "serverId": Type.Ref('ServerId'), "status": Type.Union([Type.Literal('authorized'), Type.Literal('needs-reconnect'), Type.Literal('error')]) }, { additionalProperties: false }),
  "McpOAuthStatusResult": Type.Object({ "authorizationStatus": Type.Union([Type.Union([Type.Literal('pending'), Type.Literal('authorized'), Type.Literal('needs-reconnect'), Type.Literal('error')]), Type.Null()]), "lastSafeError": Type.Optional(Type.Ref('SafeError')) }, { additionalProperties: false }),
  "SecretRef": Type.String({ pattern: "^secret://[a-z0-9-]+/[a-z0-9._-]+$" }),
})

export const ResourcePermission = ResourceControlSchema.Import('ResourcePermission')
export type ResourcePermission = Static<typeof ResourcePermission>
export const ProfileId = ResourceControlSchema.Import('ProfileId')
export type ProfileId = Static<typeof ProfileId>
export const ResourceId = ResourceControlSchema.Import('ResourceId')
export type ResourceId = Static<typeof ResourceId>
export const ServerId = ResourceControlSchema.Import('ServerId')
export type ServerId = Static<typeof ServerId>
export const Revision = ResourceControlSchema.Import('Revision')
export type Revision = Static<typeof Revision>
export const WorkspaceId = ResourceControlSchema.Import('WorkspaceId')
export type WorkspaceId = Static<typeof WorkspaceId>
export const CommandId = ResourceControlSchema.Import('CommandId')
export type CommandId = Static<typeof CommandId>
export const ClientId = ResourceControlSchema.Import('ClientId')
export type ClientId = Static<typeof ClientId>
export const SourceScope = ResourceControlSchema.Import('SourceScope')
export type SourceScope = Static<typeof SourceScope>
export const SkillRootKey = ResourceControlSchema.Import('SkillRootKey')
export type SkillRootKey = Static<typeof SkillRootKey>
export const SkillRootDiagnostic = ResourceControlSchema.Import('SkillRootDiagnostic')
export type SkillRootDiagnostic = Static<typeof SkillRootDiagnostic>
export const SkillRootStatus = ResourceControlSchema.Import('SkillRootStatus')
export type SkillRootStatus = Static<typeof SkillRootStatus>
export const SkillSourceIdentity = ResourceControlSchema.Import('SkillSourceIdentity')
export type SkillSourceIdentity = Static<typeof SkillSourceIdentity>
export const SkillResolution = ResourceControlSchema.Import('SkillResolution')
export type SkillResolution = Static<typeof SkillResolution>
export const TrustState = ResourceControlSchema.Import('TrustState')
export type TrustState = Static<typeof TrustState>
export const DesiredState = ResourceControlSchema.Import('DesiredState')
export type DesiredState = Static<typeof DesiredState>
export const ActualState = ResourceControlSchema.Import('ActualState')
export type ActualState = Static<typeof ActualState>
export const SafeError = ResourceControlSchema.Import('SafeError')
export type SafeError = Static<typeof SafeError>
export const SkillDescriptor = ResourceControlSchema.Import('SkillDescriptor')
export type SkillDescriptor = Static<typeof SkillDescriptor>
export const McpEnvName = ResourceControlSchema.Import('McpEnvName')
export type McpEnvName = Static<typeof McpEnvName>
export const McpStdioTransport = ResourceControlSchema.Import('McpStdioTransport')
export type McpStdioTransport = Static<typeof McpStdioTransport>
export const McpHttpTransport = ResourceControlSchema.Import('McpHttpTransport')
export type McpHttpTransport = Static<typeof McpHttpTransport>
export const McpSseTransport = ResourceControlSchema.Import('McpSseTransport')
export type McpSseTransport = Static<typeof McpSseTransport>
export const McpSecretBinding = ResourceControlSchema.Import('McpSecretBinding')
export type McpSecretBinding = Static<typeof McpSecretBinding>
export const McpStdioSecretBinding = ResourceControlSchema.Import('McpStdioSecretBinding')
export type McpStdioSecretBinding = Static<typeof McpStdioSecretBinding>
export const McpOAuthSecretBinding = ResourceControlSchema.Import('McpOAuthSecretBinding')
export type McpOAuthSecretBinding = Static<typeof McpOAuthSecretBinding>
export const McpHttpSecretBinding = ResourceControlSchema.Import('McpHttpSecretBinding')
export type McpHttpSecretBinding = Static<typeof McpHttpSecretBinding>
export const McpToolPolicy = ResourceControlSchema.Import('McpToolPolicy')
export type McpToolPolicy = Static<typeof McpToolPolicy>
export const McpServerDefinitionInput = ResourceControlSchema.Import('McpServerDefinitionInput')
export type McpServerDefinitionInput = Static<typeof McpServerDefinitionInput>
export const McpServerDescriptor = ResourceControlSchema.Import('McpServerDescriptor')
export type McpServerDescriptor = Static<typeof McpServerDescriptor>
export const McpStatus = ResourceControlSchema.Import('McpStatus')
export type McpStatus = Static<typeof McpStatus>
export const McpInputSchema = ResourceControlSchema.Import('McpInputSchema')
export type McpInputSchema = Static<typeof McpInputSchema>
export const McpTool = ResourceControlSchema.Import('McpTool')
export type McpTool = Static<typeof McpTool>
export const McpToolCatalogPage = ResourceControlSchema.Import('McpToolCatalogPage')
export type McpToolCatalogPage = Static<typeof McpToolCatalogPage>
export const ResourceOperationReceipt = ResourceControlSchema.Import('ResourceOperationReceipt')
export type ResourceOperationReceipt = Static<typeof ResourceOperationReceipt>
export const ResourceOperation = ResourceControlSchema.Import('ResourceOperation')
export type ResourceOperation = Static<typeof ResourceOperation>
export const ResourceDescriptor = ResourceControlSchema.Import('ResourceDescriptor')
export type ResourceDescriptor = Static<typeof ResourceDescriptor>
export const ResourceListParams = ResourceControlSchema.Import('ResourceListParams')
export type ResourceListParams = Static<typeof ResourceListParams>
export const ResourceListResult = ResourceControlSchema.Import('ResourceListResult')
export type ResourceListResult = Static<typeof ResourceListResult>
export const ResourceGetParams = ResourceControlSchema.Import('ResourceGetParams')
export type ResourceGetParams = Static<typeof ResourceGetParams>
export const ResourceDesiredSetParams = ResourceControlSchema.Import('ResourceDesiredSetParams')
export type ResourceDesiredSetParams = Static<typeof ResourceDesiredSetParams>
export const ResourceOperationGetParams = ResourceControlSchema.Import('ResourceOperationGetParams')
export type ResourceOperationGetParams = Static<typeof ResourceOperationGetParams>
export const ResourceOperationCancelParams = ResourceControlSchema.Import('ResourceOperationCancelParams')
export type ResourceOperationCancelParams = Static<typeof ResourceOperationCancelParams>
export const SkillRefreshParams = ResourceControlSchema.Import('SkillRefreshParams')
export type SkillRefreshParams = Static<typeof SkillRefreshParams>
export const SkillTrustSetParams = ResourceControlSchema.Import('SkillTrustSetParams')
export type SkillTrustSetParams = Static<typeof SkillTrustSetParams>
export const SkillRemoveParams = ResourceControlSchema.Import('SkillRemoveParams')
export type SkillRemoveParams = Static<typeof SkillRemoveParams>
export const SkillPrioritySetParams = ResourceControlSchema.Import('SkillPrioritySetParams')
export type SkillPrioritySetParams = Static<typeof SkillPrioritySetParams>
export const McpServerListParams = ResourceControlSchema.Import('McpServerListParams')
export type McpServerListParams = Static<typeof McpServerListParams>
export const McpServerListResult = ResourceControlSchema.Import('McpServerListResult')
export type McpServerListResult = Static<typeof McpServerListResult>
export const McpServerGetParams = ResourceControlSchema.Import('McpServerGetParams')
export type McpServerGetParams = Static<typeof McpServerGetParams>
export const McpServerCreateParams = ResourceControlSchema.Import('McpServerCreateParams')
export type McpServerCreateParams = Static<typeof McpServerCreateParams>
export const McpServerUpdateParams = ResourceControlSchema.Import('McpServerUpdateParams')
export type McpServerUpdateParams = Static<typeof McpServerUpdateParams>
export const McpServerRemoveParams = ResourceControlSchema.Import('McpServerRemoveParams')
export type McpServerRemoveParams = Static<typeof McpServerRemoveParams>
export const McpTrustSetParams = ResourceControlSchema.Import('McpTrustSetParams')
export type McpTrustSetParams = Static<typeof McpTrustSetParams>
export const McpServerTestParams = ResourceControlSchema.Import('McpServerTestParams')
export type McpServerTestParams = Static<typeof McpServerTestParams>
export const McpServerEnableParams = ResourceControlSchema.Import('McpServerEnableParams')
export type McpServerEnableParams = Static<typeof McpServerEnableParams>
export const McpServerDisableParams = ResourceControlSchema.Import('McpServerDisableParams')
export type McpServerDisableParams = Static<typeof McpServerDisableParams>
export const McpServerReconnectParams = ResourceControlSchema.Import('McpServerReconnectParams')
export type McpServerReconnectParams = Static<typeof McpServerReconnectParams>
export const McpToolsListParams = ResourceControlSchema.Import('McpToolsListParams')
export type McpToolsListParams = Static<typeof McpToolsListParams>
export const McpOAuthStatusSetParams = ResourceControlSchema.Import('McpOAuthStatusSetParams')
export type McpOAuthStatusSetParams = Static<typeof McpOAuthStatusSetParams>
export const McpOAuthStatusResult = ResourceControlSchema.Import('McpOAuthStatusResult')
export type McpOAuthStatusResult = Static<typeof McpOAuthStatusResult>
export const SecretRef = ResourceControlSchema.Import('SecretRef')
export type SecretRef = Static<typeof SecretRef>
