import type { RpcError } from '@agnes/protocol'

export type JsonRpcId = string | number
export type JsonRpcRequest = { jsonrpc: '2.0'; id: JsonRpcId; method: string; params?: unknown }
export type JsonRpcNotification = { jsonrpc: '2.0'; method: string; params?: unknown }
export type JsonRpcResponse = { jsonrpc: '2.0'; id: JsonRpcId; result?: unknown; error?: RpcError }
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

// The three forms are told apart by presence, not by a discriminant field: an id that is neither a
// string nor a number is not an id, so a message carrying one is classified by its method alone.
const hasId = (m: object): m is { id: JsonRpcId } => {
  const id = (m as { id?: unknown }).id
  return typeof id === 'string' || typeof id === 'number'
}
const hasMethod = (m: object): m is { method: string } =>
  typeof (m as { method?: unknown }).method === 'string'

export function isRequest(m: JsonRpcMessage): m is JsonRpcRequest {
  return hasId(m) && hasMethod(m)
}
export function isNotification(m: JsonRpcMessage): m is JsonRpcNotification {
  return !hasId(m) && hasMethod(m)
}
export function isResponse(m: JsonRpcMessage): m is JsonRpcResponse {
  return hasId(m) && !hasMethod(m)
}

export function ok(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}
export function fail(id: JsonRpcId, error: RpcError): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error }
}
export function notify(method: string, params: unknown): JsonRpcNotification {
  return { jsonrpc: '2.0', method, params }
}
