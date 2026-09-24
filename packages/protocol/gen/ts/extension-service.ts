// generated from schema by tools/gen.ts — do not edit
import { Type, type Static } from '@sinclair/typebox'

export const JsonValue = Type.Recursive((This) => Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String(), Type.Array(This), Type.Record(Type.String(), This)]))
export type JsonValue = Static<typeof JsonValue>

export const ExtensionServiceSchema = Type.Module({
  "ServiceCapability": Type.Object({ "name": Type.String({ maxLength: 128, pattern: "^[a-z][a-z0-9]*(\\.[a-z][a-z0-9]*)*$" }), "kind": Type.Union([Type.Literal('query'), Type.Literal('effect')]), "inputSchema": Type.Ref('ParametersSchema'), "outputSchema": Type.Record(Type.String(), JsonValue), "timeoutMs": Type.Integer({ minimum: 1, maximum: 30000 }), "maxResultBytes": Type.Integer({ minimum: 1, maximum: 1048576 }) }, { additionalProperties: false }),
  "ExtensionCallParams": Type.Object({ "sessionId": Type.String({ minLength: 1, maxLength: 512 }), "extension": Type.String({ pattern: "^[a-z0-9-]+/[a-z0-9-]+$" }), "service": Type.String({ maxLength: 128, pattern: "^[a-z][a-z0-9]*(\\.[a-z][a-z0-9]*)*$" }), "input": Type.Record(Type.String(), JsonValue), "commandId": Type.Optional(Type.String({ minLength: 1, maxLength: 128 })) }, { additionalProperties: false }),
  "ExtensionCallResult": Type.Object({ "output": JsonValue }, { additionalProperties: false }),
  "ExtensionAckParams": Type.Object({ "extension": Type.String({ pattern: "^[a-z0-9-]+/[a-z0-9-]+$" }), "service": Type.String({ maxLength: 128, pattern: "^[a-z][a-z0-9]*(\\.[a-z][a-z0-9]*)*$" }), "commandId": Type.String({ minLength: 1, maxLength: 128 }) }, { additionalProperties: false }),
  "ExtensionCallError": Type.Union([Type.Object({ "code": Type.Literal(-32001), "message": Type.Literal('OVERLOADED'), "data": Type.Object({ "code": Type.Literal('OVERLOADED') }, { additionalProperties: false }) }, { additionalProperties: false }), Type.Object({ "code": Type.Literal(-32006), "message": Type.Literal('CAPABILITY_DENIED'), "data": Type.Object({ "code": Type.Literal('CAPABILITY_DENIED') }, { additionalProperties: false }) }, { additionalProperties: false }), Type.Object({ "code": Type.Literal(-32602), "message": Type.Literal('INVALID_PARAMS'), "data": Type.Object({ "code": Type.Literal('INVALID_PARAMS') }, { additionalProperties: false }) }, { additionalProperties: false }), Type.Object({ "code": Type.Literal(-32011), "message": Type.Literal('SEMANTIC_REJECTED'), "data": Type.Object({ "code": Type.Literal('ID_CONFLICT') }, { additionalProperties: false }) }, { additionalProperties: false }), Type.Object({ "code": Type.Literal(-32012), "message": Type.Literal('REQUEST_TIMEOUT'), "data": Type.Object({ "code": Type.Literal('REQUEST_TIMEOUT') }, { additionalProperties: false }) }, { additionalProperties: false }), Type.Object({ "code": Type.Literal(-32603), "message": Type.Literal('INTERNAL_ERROR'), "data": Type.Object({ "code": Type.Union([Type.Literal('INTERNAL_ERROR'), Type.Literal('E_WORKSPACE_REQUIRED')]) }, { additionalProperties: false }) }, { additionalProperties: false }), Type.Object({ "code": Type.Literal(-32013), "message": Type.Literal('OUTCOME_UNKNOWN'), "data": Type.Object({ "code": Type.Literal('OUTCOME_UNKNOWN') }, { additionalProperties: false }) }, { additionalProperties: false })]),
  "ParametersSchema": Type.Object({ "type": Type.Literal('object'), "properties": Type.Record(Type.String(), JsonValue), "required": Type.Optional(Type.Array(Type.String())), "additionalProperties": Type.Literal(false), "description": Type.Optional(Type.String({ maxLength: 2048 })) }, { additionalProperties: false }),
})

export const ServiceCapability = ExtensionServiceSchema.Import('ServiceCapability')
export type ServiceCapability = Static<typeof ServiceCapability>
export const ExtensionCallParams = ExtensionServiceSchema.Import('ExtensionCallParams')
export type ExtensionCallParams = Static<typeof ExtensionCallParams>
export const ExtensionCallResult = ExtensionServiceSchema.Import('ExtensionCallResult')
export type ExtensionCallResult = Static<typeof ExtensionCallResult>
export const ExtensionAckParams = ExtensionServiceSchema.Import('ExtensionAckParams')
export type ExtensionAckParams = Static<typeof ExtensionAckParams>
export const ExtensionCallError = ExtensionServiceSchema.Import('ExtensionCallError')
export type ExtensionCallError = Static<typeof ExtensionCallError>
export const ParametersSchema = ExtensionServiceSchema.Import('ParametersSchema')
export type ParametersSchema = Static<typeof ParametersSchema>
export const Root = ServiceCapability
export type Root = ServiceCapability
