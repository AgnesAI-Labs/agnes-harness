// generated from schema by tools/gen.ts — do not edit
import { Type, type Static } from '@sinclair/typebox'

export const JsonValue = Type.Recursive((This) => Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String(), Type.Array(This), Type.Record(Type.String(), This)]))
export type JsonValue = Static<typeof JsonValue>

export const ProjectionSchema = Type.Module({
  "ProjectionCapability": Type.Object({ "name": Type.String({ maxLength: 128, pattern: "^[a-z][a-z0-9]*(\\.[a-z][a-z0-9]*)*$" }), "inputEventTypes": Type.Array(Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-z][a-z0-9]*(?:[./-][a-z0-9]+)*$" }), { minItems: 1, uniqueItems: true }), "maxStateBytes": Type.Integer({ minimum: 1, maximum: 262144 }) }, { additionalProperties: false }),
  "ProjectionReadResult": Type.Union([Type.Object({ "status": Type.Literal('available'), "name": Type.String({ maxLength: 128, pattern: "^[a-z][a-z0-9]*(\\.[a-z][a-z0-9]*)*$" }), "asOfSeq": Type.Integer({ minimum: 0 }), "stateVersion": Type.Integer({ minimum: 1 }), "value": JsonValue }, { additionalProperties: false }), Type.Object({ "status": Type.Literal('unavailable'), "name": Type.String({ maxLength: 128, pattern: "^[a-z][a-z0-9]*(\\.[a-z][a-z0-9]*)*$" }), "error": Type.Object({ "code": Type.Literal('E_PROJECTION_STATE'), "safeMessage": Type.String({ maxLength: 256 }) }, { additionalProperties: false }) }, { additionalProperties: false })]),
})

export const ProjectionCapability = ProjectionSchema.Import('ProjectionCapability')
export type ProjectionCapability = Static<typeof ProjectionCapability>
export const ProjectionReadResult = ProjectionSchema.Import('ProjectionReadResult')
export type ProjectionReadResult = Static<typeof ProjectionReadResult>
export const Root = ProjectionCapability
export type Root = ProjectionCapability
