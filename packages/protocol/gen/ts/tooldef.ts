// generated from schema by tools/gen.ts — do not edit
import { Type, type Static, type TImport, type TModule, type TProperties } from '@sinclair/typebox'

export const JsonValue = Type.Recursive((This) => Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String(), Type.Array(This), Type.Record(Type.String(), This)]))
export type JsonValue = Static<typeof JsonValue>

export const ToolDefSchema = Type.Module({
  "ToolMeta": Type.Object({ "isReadOnly": Type.Boolean(), "isDestructive": Type.Boolean(), "isConcurrencySafe": Type.Boolean(), "isOpenWorld": Type.Boolean(), "replay": Type.Union([Type.Literal('safe'), Type.Literal('never'), Type.Literal('idempotent')]), "costHint": Type.Optional(Type.Union([Type.Null(), Type.Object({ "credits": Type.Optional(Type.Number({ minimum: 0 })), "wallMs": Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false })])), "deferLoading": Type.Optional(Type.Union([Type.Union([Type.Boolean(), Type.Null()]), Type.Literal('auto')])), "discoveryGroup": Type.Optional(Type.String({ pattern: "^[^\\r\\n\\t]{1,120}$" })), "requiresApproval": Type.Optional(Type.Union([Type.Union([Type.Literal('never'), Type.Literal('destructive'), Type.Literal('always')]), Type.Null()])), "invalidArgumentLimit": Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })), "attestsHistory": Type.Optional(Type.Boolean()), "isPresentational": Type.Optional(Type.Boolean()), "paths": Type.Optional(Type.Array(Type.Object({ "arg": Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]{0,127}$" }), "access": Type.Union([Type.Literal('read'), Type.Literal('write')]), "default": Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })), "nonWorkspaceSchemes": Type.Optional(Type.Array(Type.String({ pattern: "^[a-z][a-z0-9+.-]{0,63}$" }), { maxItems: 16 })) }, { additionalProperties: false }), { maxItems: 32 })), "modelVisible": Type.Optional(Type.Boolean()), "requiresImageInput": Type.Optional(Type.Boolean()), "requiresUser": Type.Optional(Type.Boolean()), "presentation": Type.Optional(Type.Ref('ToolPresentation')), "commandArg": Type.Optional(Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]{0,63}$" })) }, { additionalProperties: false }),
  "ParametersSchema": Type.Object({ "type": Type.Literal('object'), "properties": Type.Record(Type.String(), JsonValue), "required": Type.Optional(Type.Array(Type.String())), "additionalProperties": Type.Literal(false), "description": Type.Optional(Type.String({ maxLength: 2048 })) }, { additionalProperties: false }),
  "ToolDef": Type.Object({ "name": Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]{0,63}$" }), "description": Type.String({ minLength: 1, maxLength: 4096 }), "parameters": Type.Ref('ParametersSchema'), "meta": Type.Ref('ToolMeta') }, { additionalProperties: false }),
  "ToolPresentation": Type.Object({ "title": Type.String({ minLength: 1, maxLength: 256 }), "description": Type.String({ minLength: 1, maxLength: 4096 }), "summary": Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })) }, { additionalProperties: false }),
})

export type ToolDefSchemaDefinitions = typeof ToolDefSchema extends TModule<TProperties, infer Definitions> ? Definitions : never

export const ToolMeta: TImport<ToolDefSchemaDefinitions, 'ToolMeta'> = ToolDefSchema.Import('ToolMeta')
export type ToolMeta = Static<typeof ToolMeta>
export const ParametersSchema: TImport<ToolDefSchemaDefinitions, 'ParametersSchema'> = ToolDefSchema.Import('ParametersSchema')
export type ParametersSchema = Static<typeof ParametersSchema>
export const ToolDef: TImport<ToolDefSchemaDefinitions, 'ToolDef'> = ToolDefSchema.Import('ToolDef')
export type ToolDef = Static<typeof ToolDef>
export const ToolPresentation: TImport<ToolDefSchemaDefinitions, 'ToolPresentation'> = ToolDefSchema.Import('ToolPresentation')
export type ToolPresentation = Static<typeof ToolPresentation>
export const Root = ToolDef
export type Root = ToolDef
