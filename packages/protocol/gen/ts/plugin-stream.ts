// generated from schema by tools/gen.ts — do not edit
import { Type, type Static, type TImport, type TModule, type TProperties } from '@sinclair/typebox'

export const JsonValue = Type.Recursive((This) => Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String(), Type.Array(This), Type.Record(Type.String(), This)]))
export type JsonValue = Static<typeof JsonValue>

export const PluginStreamSchema = Type.Module({
  "StreamScope": Type.Union([Type.Object({ "kind": Type.Literal('profile'), "profileId": Type.String({ minLength: 1, maxLength: 256 }) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('session'), "profileId": Type.String({ minLength: 1, maxLength: 256 }), "sessionId": Type.String({ minLength: 1, maxLength: 512 }), "laneId": Type.String({ minLength: 1, maxLength: 128 }) }, { additionalProperties: false })]),
  "StreamDeclaration": Type.Object({ "name": Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-z][a-z0-9]*(\\.[a-z][a-z0-9]*)*$" }), "scope": Type.Union([Type.Literal('profile'), Type.Literal('session')]), "inputSchema": Type.Ref('ParametersSchema'), "directions": Type.Array(Type.Union([Type.Literal('outbound'), Type.Literal('inbound')]), { minItems: 1, maxItems: 2, uniqueItems: true }), "lane": Type.Union([Type.Literal('media'), Type.Literal('control'), Type.Literal('events')]), "maxFrameBytes": Type.Integer({ minimum: 1, maximum: 1048576 }), "maxBufferedBytes": Type.Integer({ minimum: 1, maximum: 2097152 }), "maxBytesPerSecond": Type.Integer({ minimum: 1, maximum: 4194304 }), "readService": Type.Optional(Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-z][a-z0-9]*(\\.[a-z][a-z0-9]*)*$" })), "controlService": Type.Optional(Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-z][a-z0-9]*(\\.[a-z][a-z0-9]*)*$" })), "producer": Type.Optional(Type.Literal(true)) }, { additionalProperties: false }),
  "PluginStreamOpen": Type.Object({ "owner": Type.String({ minLength: 1, maxLength: 256, pattern: "^[a-z0-9-]+/[a-z0-9-]+$" }), "name": Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-z][a-z0-9]*(\\.[a-z][a-z0-9]*)*$" }), "scope": Type.Ref('StreamScope'), "input": JsonValue, "controlOperationId": Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), "client": Type.Optional(Type.Object({ "rowId": Type.String({ minLength: 1, maxLength: 256, pattern: "^web:[^\\x00]{1,251}$" }), "revision": Type.String({ minLength: 1, maxLength: 128 }), "contentDigest": Type.String({ pattern: "^sha256-[a-f0-9]{64}$" }) }, { additionalProperties: false })) }, { additionalProperties: false }),
  "PluginStreamGrant": Type.Object({ "ticket": Type.String({ minLength: 1, maxLength: 128 }), "expiresAt": Type.Integer({ minimum: 0, maximum: 9007199254740991 }), "path": Type.Literal('/_agnes/plugin-stream'), "streamId": Type.Integer({ minimum: 1, maximum: 4294967295 }), "lane": Type.Union([Type.Literal('media'), Type.Literal('control'), Type.Literal('events')]), "producer": Type.Optional(Type.Literal(true)), "maxFrameBytes": Type.Optional(Type.Integer({ minimum: 1, maximum: 1048576 })), "maxBufferedBytes": Type.Optional(Type.Integer({ minimum: 1, maximum: 2097152 })) }, { additionalProperties: false }),
  "PluginStreamClose": Type.Object({ "reason": Type.Union([Type.Literal('closed'), Type.Literal('revoked'), Type.Literal('expired'), Type.Literal('overloaded'), Type.Literal('protocol'), Type.Literal('unavailable'), Type.Literal('reopen')]) }, { additionalProperties: false }),
  "PluginStreamHello": Type.Object({ "ticket": Type.String({ minLength: 1, maxLength: 128 }) }, { additionalProperties: false }),
  "PluginStreamJsonFrame": Type.Object({ "version": Type.Literal(1), "streamId": Type.Integer({ minimum: 1, maximum: 4294967295 }), "sequence": Type.Integer({ minimum: 0, maximum: 4294967295 }), "kind": Type.Literal('json'), "data": JsonValue }, { additionalProperties: false }),
  "ParametersSchema": Type.Object({ "type": Type.Literal('object'), "properties": Type.Record(Type.String(), JsonValue), "required": Type.Optional(Type.Array(Type.String())), "additionalProperties": Type.Literal(false), "description": Type.Optional(Type.String({ maxLength: 2048 })) }, { additionalProperties: false }),
})

export type PluginStreamSchemaDefinitions = typeof PluginStreamSchema extends TModule<TProperties, infer Definitions> ? Definitions : never

export const StreamScope: TImport<PluginStreamSchemaDefinitions, 'StreamScope'> = PluginStreamSchema.Import('StreamScope')
export type StreamScope = Static<typeof StreamScope>
export const StreamDeclaration: TImport<PluginStreamSchemaDefinitions, 'StreamDeclaration'> = PluginStreamSchema.Import('StreamDeclaration')
export type StreamDeclaration = Static<typeof StreamDeclaration>
export const PluginStreamOpen: TImport<PluginStreamSchemaDefinitions, 'PluginStreamOpen'> = PluginStreamSchema.Import('PluginStreamOpen')
export type PluginStreamOpen = Static<typeof PluginStreamOpen>
export const PluginStreamGrant: TImport<PluginStreamSchemaDefinitions, 'PluginStreamGrant'> = PluginStreamSchema.Import('PluginStreamGrant')
export type PluginStreamGrant = Static<typeof PluginStreamGrant>
export const PluginStreamClose: TImport<PluginStreamSchemaDefinitions, 'PluginStreamClose'> = PluginStreamSchema.Import('PluginStreamClose')
export type PluginStreamClose = Static<typeof PluginStreamClose>
export const PluginStreamHello: TImport<PluginStreamSchemaDefinitions, 'PluginStreamHello'> = PluginStreamSchema.Import('PluginStreamHello')
export type PluginStreamHello = Static<typeof PluginStreamHello>
export const PluginStreamJsonFrame: TImport<PluginStreamSchemaDefinitions, 'PluginStreamJsonFrame'> = PluginStreamSchema.Import('PluginStreamJsonFrame')
export type PluginStreamJsonFrame = Static<typeof PluginStreamJsonFrame>
export const ParametersSchema: TImport<PluginStreamSchemaDefinitions, 'ParametersSchema'> = PluginStreamSchema.Import('ParametersSchema')
export type ParametersSchema = Static<typeof ParametersSchema>
export const Root = StreamScope
export type Root = StreamScope
