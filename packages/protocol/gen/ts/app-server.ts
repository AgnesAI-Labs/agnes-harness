// generated from schema by tools/gen.ts — do not edit
import { Type, type Static } from '@sinclair/typebox'

export const JsonValue = Type.Recursive((This) => Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String(), Type.Array(This), Type.Record(Type.String(), This)]))
export type JsonValue = Static<typeof JsonValue>

export const AppServerV1 = Type.Module({
  "AppServerErrorCause": Type.Object({ "code": Type.Union([Type.Literal('CONFIG_AUTH_BUSY'), Type.Literal('CONFIG_AUTH_CANCELLED'), Type.Literal('CONFIG_AUTH_EXPIRED'), Type.Literal('CONFIG_AUTH_FAILED'), Type.Literal('CONFIG_AUTH_UNAVAILABLE'), Type.Literal('CONFIG_CREDENTIAL_INVALID'), Type.Literal('CONFIG_CREDENTIAL_NO_SPACE'), Type.Literal('CONFIG_CREDENTIAL_PERMISSIONS'), Type.Literal('CONFIG_CREDENTIAL_READ_ONLY'), Type.Literal('CONFIG_CREDENTIAL_REJECTED'), Type.Literal('CONFIG_CREDENTIAL_REQUIRED'), Type.Literal('CONFIG_CREDENTIAL_STORE'), Type.Literal('CONFIG_ENDPOINT_OVERRIDE_UNSUPPORTED'), Type.Literal('CONFIG_FAILED'), Type.Literal('CONFIG_INVALID_INPUT'), Type.Literal('CONFIG_INVALID_STATE'), Type.Literal('CONFIG_MODEL_UNAVAILABLE'), Type.Literal('CONFIG_PERSIST_FAILED'), Type.Literal('CONFIG_PROVIDER_UNAVAILABLE'), Type.Literal('CONFIG_REVISION_CONFLICT'), Type.Literal('CONFIG_SUBSCRIPTION_AUTH'), Type.Literal('CONFIG_SUBSCRIPTION_FAILED'), Type.Literal('CONFIG_SUBSCRIPTION_MODEL'), Type.Literal('CONFIG_SUBSCRIPTION_QUOTA'), Type.Literal('CONFIG_SUBSCRIPTION_RATE_LIMIT'), Type.Literal('CONFIG_SUBSCRIPTION_TIMEOUT'), Type.Literal('CONFIG_TEST_FAILED'), Type.Literal('CONFIG_UNKNOWN_PROVIDER'), Type.Literal('E_GENERATION_BINDING_CONFLICT'), Type.Literal('E_GENERATION_DISPOSE'), Type.Literal('E_GENERATION_FACTORY_INCOMPATIBLE'), Type.Literal('E_GENERATION_FACTORY_UNAVAILABLE'), Type.Literal('E_GENERATION_INCOMPATIBLE'), Type.Literal('E_GENERATION_LOOP_INCOMPATIBLE'), Type.Literal('E_GENERATION_MIGRATION_UNAVAILABLE'), Type.Literal('E_GENERATION_PIN_MISSING'), Type.Literal('E_GENERATION_RESOURCE_INTEGRITY'), Type.Literal('E_GENERATION_RESTART_REQUIRED'), Type.Literal('E_GENERATION_SESSION_OPEN'), Type.Literal('E_GENERATION_SKILLS'), Type.Literal('E_GENERATION_TARGET_MISSING'), Type.Literal('E_PROVIDER_DUPLICATE'), Type.Literal('E_PROVIDER_INCOMPATIBLE'), Type.Literal('E_PROVIDER_INVALID'), Type.Literal('E_PROVIDER_UNAVAILABLE'), Type.Literal('E_PROVIDER_UNKNOWN'), Type.Literal('SEARCH_FAILED'), Type.Literal('SEARCH_INVALID'), Type.Literal('SEARCH_NOT_CONFIGURED'), Type.Literal('SEARCH_RATE_LIMITED'), Type.Literal('SEARCH_ROUTE'), Type.Literal('SEARCH_TIMEOUT'), Type.Literal('E_PACKAGE_PROVENANCE'), Type.Literal('E_PACKAGE_SOURCE_POLICY'), Type.Literal('E_MCP_SANDBOX_UNAVAILABLE'), Type.Literal('E_PACKAGE_INTEGRITY')]) }, { additionalProperties: false }),
  "AppServerError": Type.Object({ "code": Type.Integer(), "message": Type.String({ maxLength: 256 }), "data": Type.Object({ "code": Type.String({ maxLength: 128 }), "messageKey": Type.Union([Type.Literal('appServer.errors.internal'), Type.Literal('appServer.errors.invalidRequest'), Type.Literal('appServer.errors.invalidParams'), Type.Literal('appServer.errors.methodNotFound'), Type.Literal('appServer.errors.forbidden'), Type.Literal('appServer.errors.auth'), Type.Literal('appServer.errors.busy'), Type.Literal('appServer.errors.notFound'), Type.Literal('appServer.errors.conflict'), Type.Literal('appServer.errors.timeout'), Type.Literal('appServer.errors.unavailable'), Type.Literal('appServer.errors.credentialRequired'), Type.Literal('appServer.errors.credentialRejected'), Type.Literal('appServer.errors.credentialStore'), Type.Literal('appServer.errors.provider'), Type.Literal('appServer.errors.generation'), Type.Literal('appServer.errors.rejected')]), "diagnosticId": Type.String({ pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$" }), "cause": Type.Optional(Type.Ref('AppServerErrorCause')) }) }, { additionalProperties: false }),
  "AdminEmpty": Type.Object({  }, { additionalProperties: false }),
  "AdminBundlesSave": Type.Object({ "revision": Type.Integer({ minimum: 0 }), "bundles": Type.Array(Type.String({ maxLength: 512 }), { maxItems: 64 }) }, { additionalProperties: false }),
  "AdminBundlesResult": Type.Object({ "revision": Type.Integer({ minimum: 0 }), "bundles": Type.Array(Type.String({ maxLength: 512 }), { maxItems: 64 }), "effect": Type.Literal('restart-required'), "catalog": Type.Optional(Type.Array(Type.Object({ "id": Type.String({ maxLength: 512 }), "sourcePackage": Type.String({ maxLength: 256 }) }, { additionalProperties: false }), { maxItems: 4096 })) }, { additionalProperties: false }),
  "AdminCompositionParams": Type.Object({ "preset": Type.Optional(Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$" })) }, { additionalProperties: false }),
  "AdminCompositionResult": Type.Object({ "status": Type.Union([Type.Literal('live'), Type.Literal('desired')]), "validation": Type.Literal('static'), "selection": Type.Record(Type.String(), JsonValue), "rows": Type.Array(JsonValue, { maxItems: 4096 }), "sessions": Type.Array(JsonValue, { maxItems: 4096 }), "profile": Type.Optional(Type.String({ maxLength: 4096 })), "preset": Type.Optional(Type.String({ maxLength: 4096 })), "hash": Type.Optional(Type.String({ maxLength: 4096 })), "bundles": Type.Optional(Type.Array(Type.String({ maxLength: 512 }), { maxItems: 64 })), "sessionBundles": Type.Optional(Type.Array(Type.String({ maxLength: 512 }), { maxItems: 64 })), "sources": Type.Optional(Type.Record(Type.String(), JsonValue)), "toolScope": Type.Optional(Type.Record(Type.String(), JsonValue)), "capabilities": Type.Optional(Type.Record(Type.String(), JsonValue)), "packages": Type.Optional(Type.Array(JsonValue, { maxItems: 4096 })), "pluginOverrides": Type.Optional(Type.Array(JsonValue, { maxItems: 4096 })) }, { additionalProperties: false }),
  "AdminSearchSave": Type.Object({ "provider": Type.Record(Type.String(), JsonValue), "defaultProvider": Type.Optional(Type.Union([Type.String({ maxLength: 64 }), Type.Null()])), "apiKey": Type.Optional(Type.String({ maxLength: 65536 })) }, { additionalProperties: false }),
  "AdminSearchTest": Type.Object({ "provider": Type.String({ maxLength: 64 }), "query": Type.String({ maxLength: 500 }) }, { additionalProperties: false }),
  "AdminSearchResult": Type.Record(Type.String(), JsonValue),
  "AdminContextConfig": Type.Object({ "rulesEnabled": Type.Boolean(), "instructionFiles": Type.Array(Type.String({ maxLength: 1024 }), { maxItems: 128 }), "localInstructionFiles": Type.Array(Type.String({ maxLength: 1024 }), { maxItems: 128 }), "maxBytes": Type.Integer({ minimum: 0, maximum: 60000 }), "maxSourceBytes": Type.Integer({ minimum: 0, maximum: 1048576 }), "timeEnabled": Type.Boolean(), "timeZone": Type.String({ maxLength: 128 }), "refreshIntervalMs": Type.Integer({ minimum: 0, maximum: 86400000 }), "customSkillRoots": Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 128 }) }, { additionalProperties: false }),
  "AdminContextParams": Type.Object({ "cwd": Type.Optional(Type.String({ maxLength: 4096 })), "config": Type.Optional(Type.Object({ "rulesEnabled": Type.Optional(Type.Boolean()), "instructionFiles": Type.Optional(Type.Array(Type.String({ maxLength: 1024 }), { maxItems: 128 })), "localInstructionFiles": Type.Optional(Type.Array(Type.String({ maxLength: 1024 }), { maxItems: 128 })), "maxBytes": Type.Optional(Type.Integer({ minimum: 0, maximum: 60000 })), "maxSourceBytes": Type.Optional(Type.Integer({ minimum: 0, maximum: 1048576 })), "timeEnabled": Type.Optional(Type.Boolean()), "timeZone": Type.Optional(Type.String({ maxLength: 128 })), "refreshIntervalMs": Type.Optional(Type.Integer({ minimum: 0, maximum: 86400000 })), "customSkillRoots": Type.Optional(Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 128 })) }, { additionalProperties: false })) }, { additionalProperties: false }),
  "AdminContextResult": Type.Object({ "config": Type.Ref('AdminContextConfig'), "workspaces": Type.Array(Type.Object({ "path": Type.String({ maxLength: 4096 }), "available": Type.Boolean() }, { additionalProperties: false }), { maxItems: 4096 }), "rules": Type.Optional(Type.Object({ "root": Type.String({ maxLength: 4096 }), "files": Type.Array(Type.Object({ "path": Type.String({ maxLength: 4096 }), "scope": Type.String({ maxLength: 4096 }), "content": Type.String({ maxLength: 60000 }), "trust": Type.Union([Type.Literal('user'), Type.Literal('repository')]) }, { additionalProperties: false }), { maxItems: 4096 }), "skipped": Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 4096 }), "content": Type.String({ maxLength: 60000 }) }, { additionalProperties: false })) }, { additionalProperties: false }),
  "AdminHistoryParams": Type.Object({ "query": Type.String({ maxLength: 256 }), "title": Type.String({ maxLength: 256 }), "workspace": Type.String({ maxLength: 4096 }), "cursor": Type.Optional(Type.String({ maxLength: 65536 })) }, { additionalProperties: false }),
  "AdminHistoryResult": Type.Object({ "items": Type.Array(Type.Object({ "sessionId": Type.String({ maxLength: 4096 }), "title": Type.String({ maxLength: 65536 }), "workspace": Type.String({ maxLength: 4096 }), "snippet": Type.String({ maxLength: 65536 }), "ts": Type.String({ maxLength: 128 }), "seq": Type.Optional(Type.Integer({ minimum: 0 })), "type": Type.Optional(Type.String({ maxLength: 128 })) }, { additionalProperties: false }), { maxItems: 1000 }), "next": Type.Optional(Type.String({ maxLength: 65536 })), "truncated": Type.Boolean() }, { additionalProperties: false }),
  "AdminPlanParams": Type.Object({ "cwd": Type.String({ maxLength: 4096 }), "line": Type.String({ maxLength: 8192, pattern: "^\\s*/plan(?:\\s|$)" }) }, { additionalProperties: false }),
  "AdminPlanResult": Type.Object({ "active": Type.Boolean(), "text": Type.String({ maxLength: 8192 }) }, { additionalProperties: false }),
  "AdminMcpOAuthSave": Type.Object({ "serverId": Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-z][a-z0-9._-]{0,127}$" }), "credential": Type.Object({ "provider": Type.String({ maxLength: 4096 }), "accessToken": Type.String({ maxLength: 65536 }), "refreshToken": Type.String({ maxLength: 65536 }), "expiresAt": Type.Number({ minimum: 0 }), "scope": Type.Array(Type.String({ maxLength: 1024 }), { maxItems: 128 }), "grantId": Type.String({ maxLength: 512 }) }, { additionalProperties: false }) }, { additionalProperties: false }),
  "DoctorParams": Type.Object({ "probeAccounts": Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  "DoctorCheck": Type.Object({ "id": Type.Union([Type.Literal('node'), Type.Literal('native'), Type.Literal('home'), Type.Literal('permissions'), Type.Literal('credentials'), Type.Literal('sandbox'), Type.Literal('connection'), Type.Literal('disk'), Type.Literal('accounts'), Type.Literal('plugins'), Type.Literal('mcp')]), "status": Type.Union([Type.Literal('ok'), Type.Literal('warn'), Type.Literal('fail')]), "fixHintKey": Type.Union([Type.Literal('doctor.fix.node'), Type.Literal('doctor.fix.native'), Type.Literal('doctor.fix.home'), Type.Literal('doctor.fix.permissions'), Type.Literal('doctor.fix.credentials'), Type.Literal('doctor.fix.sandbox'), Type.Literal('doctor.fix.connection'), Type.Literal('doctor.fix.disk'), Type.Literal('doctor.fix.accounts'), Type.Literal('doctor.fix.plugins'), Type.Literal('doctor.fix.mcp')]), "count": Type.Optional(Type.Integer({ minimum: 0 })), "availableBytes": Type.Optional(Type.Integer({ minimum: 0 })), "totalBytes": Type.Optional(Type.Integer({ minimum: 0 })), "probed": Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  "DoctorResult": Type.Object({ "checks": Type.Array(Type.Ref('DoctorCheck'), { maxItems: 32 }), "status": Type.Union([Type.Literal('ok'), Type.Literal('warn'), Type.Literal('fail')]), "homeId": Type.Optional(Type.String({ pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$" })) }, { additionalProperties: false }),
})

export const AppServerErrorCause = AppServerV1.Import('AppServerErrorCause')
export type AppServerErrorCause = Static<typeof AppServerErrorCause>
export const AppServerError = AppServerV1.Import('AppServerError')
export type AppServerError = Static<typeof AppServerError>
export const AdminEmpty = AppServerV1.Import('AdminEmpty')
export type AdminEmpty = Static<typeof AdminEmpty>
export const AdminBundlesSave = AppServerV1.Import('AdminBundlesSave')
export type AdminBundlesSave = Static<typeof AdminBundlesSave>
export const AdminBundlesResult = AppServerV1.Import('AdminBundlesResult')
export type AdminBundlesResult = Static<typeof AdminBundlesResult>
export const AdminCompositionParams = AppServerV1.Import('AdminCompositionParams')
export type AdminCompositionParams = Static<typeof AdminCompositionParams>
export const AdminCompositionResult = AppServerV1.Import('AdminCompositionResult')
export type AdminCompositionResult = Static<typeof AdminCompositionResult>
export const AdminSearchSave = AppServerV1.Import('AdminSearchSave')
export type AdminSearchSave = Static<typeof AdminSearchSave>
export const AdminSearchTest = AppServerV1.Import('AdminSearchTest')
export type AdminSearchTest = Static<typeof AdminSearchTest>
export const AdminSearchResult = AppServerV1.Import('AdminSearchResult')
export type AdminSearchResult = Static<typeof AdminSearchResult>
export const AdminContextConfig = AppServerV1.Import('AdminContextConfig')
export type AdminContextConfig = Static<typeof AdminContextConfig>
export const AdminContextParams = AppServerV1.Import('AdminContextParams')
export type AdminContextParams = Static<typeof AdminContextParams>
export const AdminContextResult = AppServerV1.Import('AdminContextResult')
export type AdminContextResult = Static<typeof AdminContextResult>
export const AdminHistoryParams = AppServerV1.Import('AdminHistoryParams')
export type AdminHistoryParams = Static<typeof AdminHistoryParams>
export const AdminHistoryResult = AppServerV1.Import('AdminHistoryResult')
export type AdminHistoryResult = Static<typeof AdminHistoryResult>
export const AdminPlanParams = AppServerV1.Import('AdminPlanParams')
export type AdminPlanParams = Static<typeof AdminPlanParams>
export const AdminPlanResult = AppServerV1.Import('AdminPlanResult')
export type AdminPlanResult = Static<typeof AdminPlanResult>
export const AdminMcpOAuthSave = AppServerV1.Import('AdminMcpOAuthSave')
export type AdminMcpOAuthSave = Static<typeof AdminMcpOAuthSave>
export const DoctorParams = AppServerV1.Import('DoctorParams')
export type DoctorParams = Static<typeof DoctorParams>
export const DoctorCheck = AppServerV1.Import('DoctorCheck')
export type DoctorCheck = Static<typeof DoctorCheck>
export const DoctorResult = AppServerV1.Import('DoctorResult')
export type DoctorResult = Static<typeof DoctorResult>

export const ADMIN_METHODS = {
  "_agnes/v1/admin.bundles.get": {kind:'request',direction:'c2s',params:AdminEmpty,result:AdminBundlesResult},
  "_agnes/v1/admin.bundles.save": {kind:'request',direction:'c2s',params:AdminBundlesSave,result:AdminBundlesResult},
  "_agnes/v1/admin.composition.get": {kind:'request',direction:'c2s',params:AdminCompositionParams,result:AdminCompositionResult},
  "_agnes/v1/admin.search.get": {kind:'request',direction:'c2s',params:AdminEmpty,result:AdminSearchResult},
  "_agnes/v1/admin.search.save": {kind:'request',direction:'c2s',params:AdminSearchSave,result:AdminSearchResult},
  "_agnes/v1/admin.search.test": {kind:'request',direction:'c2s',params:AdminSearchTest,result:AdminSearchResult},
  "_agnes/v1/admin.context": {kind:'request',direction:'c2s',params:AdminContextParams,result:AdminContextResult},
  "_agnes/v1/admin.history.search": {kind:'request',direction:'c2s',params:AdminHistoryParams,result:AdminHistoryResult},
  "_agnes/v1/admin.plan": {kind:'request',direction:'c2s',params:AdminPlanParams,result:AdminPlanResult},
  "_agnes/v1/admin.mcp.oauth.save": {kind:'request',direction:'c2s',params:AdminMcpOAuthSave,result:AdminEmpty},
  "_agnes/v1/doctor.run": {kind:'request',direction:'c2s',params:DoctorParams,result:DoctorResult},
} as const
