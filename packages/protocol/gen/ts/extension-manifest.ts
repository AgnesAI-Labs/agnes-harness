// generated from schema by tools/gen.ts — do not edit
import { Type, type Static } from '@sinclair/typebox'

export const JsonValue = Type.Recursive((This) => Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String(), Type.Array(This), Type.Record(Type.String(), This)]))
export type JsonValue = Static<typeof JsonValue>

export const ExtensionManifestSchema = Type.Module({
  "Capabilities": Type.Object({ "tools": Type.Optional(Type.Object({ "prefix": Type.String({ pattern: "^(?:[a-z][a-z0-9_]{0,31}_)?$" }), "names": Type.Optional(Type.Array(Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]{0,63}$" }))) }, { additionalProperties: false })), "tools.invoke": Type.Optional(Type.Boolean()), "hooks": Type.Optional(Type.Array(Type.Ref('HookEvent'))), "slots": Type.Optional(Type.Array(Type.Ref('UiSlotName'))), "events": Type.Optional(Type.Boolean()), "ui": Type.Optional(Type.Array(Type.Union([Type.Literal('skin'), Type.Literal('client')]), { maxItems: 8, uniqueItems: true })), "resources": Type.Optional(Type.Array(Type.Union([Type.Literal('skill'), Type.Literal('mcp'), Type.Literal('kb'), Type.Literal('datasource'), Type.Literal('model')]))), "network.publicRead": Type.Optional(Type.Boolean()), "network": Type.Optional(Type.Union([Type.Array(Type.String(), { maxItems: 0 }), Type.Object({ "hosts": Type.Array(Type.String({ pattern: "^[a-z0-9.-]+(:[0-9]{1,5})?$" })) }, { additionalProperties: false })])), "artifacts": Type.Optional(Type.Boolean()), "subagent": Type.Optional(Type.Boolean()), "services": Type.Optional(Type.Array(Type.Ref('ServiceCapability'), { uniqueItems: true })), "projections": Type.Optional(Type.Array(Type.Ref('ProjectionCapability'), { uniqueItems: true })) }, { additionalProperties: false }),
  "SkinContribution": Type.Object({ "id": Type.String({ minLength: 1, maxLength: 64, pattern: "^(?!(?:light|dark|system|none)$)[a-z0-9]+(?:-[a-z0-9]+)*$" }), "name": Type.String({ minLength: 1, maxLength: 64 }), "css": Type.String({ minLength: 3, maxLength: 256, pattern: "^\\./" }), "tokens": Type.Optional(Type.Record(Type.String(), Type.Object({ "light": Type.Ref('SkinTokenValue'), "dark": Type.Ref('SkinTokenValue') }, { additionalProperties: false }))) }, { additionalProperties: false }),
  "SkinTokenValue": Type.String({ minLength: 1, maxLength: 256, pattern: "^(?!.*url\\()[^;{}@]*$" }),
  "ClientContribution": Type.Object({ "id": Type.Optional(Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" })), "entry": Type.String({ minLength: 1, maxLength: 512 }), "styles": Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 32 })), "slots": Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 32 })), "slotCatalogVersion": Type.Optional(Type.String({ pattern: "^dsh-client-slots/v[0-9]+$" })), "services": Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 32 })), "projections": Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 32 })), "legacyRowIds": Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256, pattern: "^web:[^\\x00]{1,251}$" }), { maxItems: 16, uniqueItems: true })), "publicConfig": Type.Optional(Type.Record(Type.String(), JsonValue)) }, { additionalProperties: false }),
  "ExtensionManifest": Type.Object({ "id": Type.String({ pattern: "^[a-z0-9-]+/[a-z0-9-]+$" }), "version": Type.String({ maxLength: 64 }), "apiRange": Type.String({ maxLength: 64 }), "entry": Type.String({ pattern: "^\\./" }), "capabilities": Type.Ref('Capabilities'), "contributes": Type.Optional(Type.Object({ "skins": Type.Optional(Type.Array(Type.Ref('SkinContribution'), { maxItems: 8 })), "client": Type.Optional(Type.Ref('ClientContribution')) }, { additionalProperties: false })), "provides": Type.Optional(Type.Array(Type.Ref('SeamName'))), "lease": Type.Optional(Type.Object({ "budget": Type.Optional(Type.Integer({ minimum: 1 })) }, { additionalProperties: false })), "runtime": Type.Optional(Type.Object({ "supports": Type.Array(Type.Union([Type.Literal('in-process'), Type.Literal('isolated')]), { minItems: 1, maxItems: 2, uniqueItems: true }) }, { additionalProperties: false })) }, { additionalProperties: false }),
  "HookEvent": Type.Union([Type.Literal('session_start'), Type.Literal('resources_discover'), Type.Literal('before_step'), Type.Literal('context'), Type.Literal('before_request'), Type.Literal('before_provider_headers'), Type.Literal('request_error'), Type.Literal('tool_call'), Type.Literal('tool_result'), Type.Literal('turn_stopping'), Type.Literal('approval_request'), Type.Literal('before_compact'), Type.Literal('compact'), Type.Literal('subagent_start'), Type.Literal('subagent_end'), Type.Literal('format_deviation'), Type.Literal('shutdown')]),
  "UiSlotName": Type.Union([Type.Literal('tool.card.inline'), Type.Literal('sidebar.action'), Type.Literal('status.line'), Type.Literal('notification')]),
  "SeamName": Type.Union([Type.Literal('approval'), Type.Literal('checkpoint'), Type.Literal('ledger'), Type.Literal('sandbox'), Type.Literal('verifier'), Type.Literal('repair'), Type.Literal('artifacts'), Type.Literal('principals'), Type.Literal('platform'), Type.Literal('harness')]),
  "ProjectionCapability": Type.Object({ "name": Type.String({ maxLength: 128, pattern: "^[a-z][a-z0-9]*(\\.[a-z][a-z0-9]*)*$" }), "inputEventTypes": Type.Array(Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-z][a-z0-9]*(?:[./-][a-z0-9]+)*$" }), { minItems: 1, uniqueItems: true }), "maxStateBytes": Type.Integer({ minimum: 1, maximum: 262144 }) }, { additionalProperties: false }),
  "ServiceCapability": Type.Object({ "name": Type.String({ maxLength: 128, pattern: "^[a-z][a-z0-9]*(\\.[a-z][a-z0-9]*)*$" }), "kind": Type.Union([Type.Literal('query'), Type.Literal('effect')]), "inputSchema": Type.Ref('ParametersSchema'), "outputSchema": Type.Record(Type.String(), JsonValue), "timeoutMs": Type.Integer({ minimum: 1, maximum: 30000 }), "maxResultBytes": Type.Integer({ minimum: 1, maximum: 1048576 }) }, { additionalProperties: false }),
  "ParametersSchema": Type.Object({ "type": Type.Literal('object'), "properties": Type.Record(Type.String(), JsonValue), "required": Type.Optional(Type.Array(Type.String())), "additionalProperties": Type.Literal(false), "description": Type.Optional(Type.String({ maxLength: 2048 })) }, { additionalProperties: false }),
})

export const Capabilities = ExtensionManifestSchema.Import('Capabilities')
export type Capabilities = Static<typeof Capabilities>
export const SkinContribution = ExtensionManifestSchema.Import('SkinContribution')
export type SkinContribution = Static<typeof SkinContribution>
export const SkinTokenValue = ExtensionManifestSchema.Import('SkinTokenValue')
export type SkinTokenValue = Static<typeof SkinTokenValue>
export const ClientContribution = ExtensionManifestSchema.Import('ClientContribution')
export type ClientContribution = Static<typeof ClientContribution>
export const ExtensionManifest = ExtensionManifestSchema.Import('ExtensionManifest')
export type ExtensionManifest = Static<typeof ExtensionManifest>
export const HookEvent = ExtensionManifestSchema.Import('HookEvent')
export type HookEvent = Static<typeof HookEvent>
export const UiSlotName = ExtensionManifestSchema.Import('UiSlotName')
export type UiSlotName = Static<typeof UiSlotName>
export const SeamName = ExtensionManifestSchema.Import('SeamName')
export type SeamName = Static<typeof SeamName>
export const ProjectionCapability = ExtensionManifestSchema.Import('ProjectionCapability')
export type ProjectionCapability = Static<typeof ProjectionCapability>
export const ServiceCapability = ExtensionManifestSchema.Import('ServiceCapability')
export type ServiceCapability = Static<typeof ServiceCapability>
export const ParametersSchema = ExtensionManifestSchema.Import('ParametersSchema')
export type ParametersSchema = Static<typeof ParametersSchema>
export const Root = ExtensionManifest
export type Root = ExtensionManifest
