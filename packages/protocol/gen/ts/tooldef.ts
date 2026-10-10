// generated from schema by tools/gen.ts — do not edit
import { Type, type Static } from '@sinclair/typebox'

export const JsonValue = Type.Recursive((This) => Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String(), Type.Array(This), Type.Record(Type.String(), This)]))
export type JsonValue = Static<typeof JsonValue>

export const ToolDefSchema = Type.Module({
  "ToolMeta": Type.Object({ "isReadOnly": Type.Boolean(), "isDestructive": Type.Boolean(), "isConcurrencySafe": Type.Boolean(), "isOpenWorld": Type.Boolean(), "replay": Type.Union([Type.Literal('safe'), Type.Literal('never'), Type.Literal('idempotent')]), "costHint": Type.Union([Type.Null(), Type.Object({ "credits": Type.Optional(Type.Number({ minimum: 0 })), "wallMs": Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false })]), "deferLoading": Type.Union([Type.Boolean(), Type.Null()]), "requiresApproval": Type.Union([Type.Union([Type.Literal('never'), Type.Literal('destructive'), Type.Literal('always')]), Type.Null()]), "isPresentational": Type.Optional(Type.Boolean()), "paths": Type.Optional(Type.Array(Type.Object({ "arg": Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]{0,127}$" }), "access": Type.Union([Type.Literal('read'), Type.Literal('write')]), "default": Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })), "nonWorkspaceSchemes": Type.Optional(Type.Array(Type.String({ pattern: "^[a-z][a-z0-9+.-]{0,63}$" }), { maxItems: 16 })) }, { additionalProperties: false }), { maxItems: 32 })) }, { additionalProperties: false }),
  "ParametersSchema": Type.Object({ "type": Type.Literal('object'), "properties": Type.Record(Type.String(), JsonValue), "required": Type.Optional(Type.Array(Type.String())), "additionalProperties": Type.Literal(false), "description": Type.Optional(Type.String({ maxLength: 2048 })) }, { additionalProperties: false }),
  "ToolDef": Type.Object({ "name": Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]{0,63}$" }), "description": Type.String({ minLength: 1, maxLength: 4096 }), "parameters": Type.Ref('ParametersSchema'), "meta": Type.Ref('ToolMeta') }, { additionalProperties: false }),
})

export const ToolMeta = ToolDefSchema.Import('ToolMeta')
export type ToolMeta = Static<typeof ToolMeta>
export const ParametersSchema = ToolDefSchema.Import('ParametersSchema')
export type ParametersSchema = Static<typeof ParametersSchema>
export const ToolDef = ToolDefSchema.Import('ToolDef')
export type ToolDef = Static<typeof ToolDef>
export const Root = ToolDef
export type Root = ToolDef
