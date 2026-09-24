// generated from schema by tools/gen.ts — do not edit
import { Type, type Static } from '@sinclair/typebox'

export const JsonValue = Type.Recursive((This) => Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String(), Type.Array(This), Type.Record(Type.String(), This)]))
export type JsonValue = Static<typeof JsonValue>

export const BridgeSchema = Type.Module({
  "BridgeMethod": Type.Union([Type.Literal('bridge.tools.invoke'), Type.Literal('bridge.subagent.spawn'), Type.Literal('bridge.subagent.fork'), Type.Literal('bridge.subagent.collect'), Type.Literal('bridge.artifacts.put'), Type.Literal('bridge.artifacts.get'), Type.Literal('bridge.plan.set'), Type.Literal('bridge.log')]),
  "BridgeRequest": Type.Union([Type.Object({ "jsonrpc": Type.Literal('2.0'), "id": Type.Union([Type.Integer(), Type.String()]), "method": Type.Literal('bridge.tools.invoke'), "params": Type.Ref('ToolsInvokeParams') }, { additionalProperties: false }), Type.Object({ "jsonrpc": Type.Literal('2.0'), "id": Type.Union([Type.Integer(), Type.String()]), "method": Type.Union([Type.Literal('bridge.subagent.spawn'), Type.Literal('bridge.subagent.fork'), Type.Literal('bridge.subagent.collect'), Type.Literal('bridge.artifacts.put'), Type.Literal('bridge.artifacts.get'), Type.Literal('bridge.plan.set'), Type.Literal('bridge.log')]), "params": JsonValue }, { additionalProperties: false })]),
  "BridgeResponse": Type.Union([Type.Object({ "jsonrpc": Type.Literal('2.0'), "id": Type.Union([Type.Integer(), Type.String()]), "result": JsonValue }, { additionalProperties: false }), Type.Object({ "jsonrpc": Type.Literal('2.0'), "id": Type.Union([Type.Integer(), Type.String(), Type.Null()]), "error": Type.Object({ "code": Type.Union([Type.Literal(1001), Type.Literal(1002), Type.Literal(1003), Type.Literal(1004), Type.Literal(1005), Type.Literal(-32600), Type.Literal(-32601), Type.Literal(-32602), Type.Literal(-32603), Type.Literal(-32700), Type.Literal(-32800)]), "message": Type.String({ maxLength: 4096 }), "data": Type.Optional(JsonValue) }, { additionalProperties: false }) }, { additionalProperties: false })]),
  "ToolsInvokeParams": Type.Object({ "name": Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]{0,63}$" }), "args": JsonValue }, { additionalProperties: false }),
})

export const BridgeMethod = BridgeSchema.Import('BridgeMethod')
export type BridgeMethod = Static<typeof BridgeMethod>
export const BridgeRequest = BridgeSchema.Import('BridgeRequest')
export type BridgeRequest = Static<typeof BridgeRequest>
export const BridgeResponse = BridgeSchema.Import('BridgeResponse')
export type BridgeResponse = Static<typeof BridgeResponse>
export const ToolsInvokeParams = BridgeSchema.Import('ToolsInvokeParams')
export type ToolsInvokeParams = Static<typeof ToolsInvokeParams>
export const X_AGNES_BRIDGE_ERRORS = {
  "1001": "BUDGET_EXCEEDED",
  "1002": "APPROVAL_REJECTED",
  "1003": "DEPTH_EXCEEDED",
  "1004": "TOOL_NOT_FOUND",
  "1005": "SCHEMA_INVALID"
} as const
export const X_AGNES_MAX_BYTES = 1048576 as const
