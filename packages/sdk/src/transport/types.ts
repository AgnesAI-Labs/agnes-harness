// The JSON-RPC 2.0 wire shapes and the transport seam. protocol hands over method names,
// error codes and validators, but not the envelope itself: the envelope is the transport's
// business, so it lives here.
import type { RpcError } from '@agnes/protocol'

export type JsonRpcId = number | string
export type JsonRpcRequest = { jsonrpc: '2.0'; id: JsonRpcId; method: string; params?: unknown }
export type JsonRpcNotification = { jsonrpc: '2.0'; method: string; params?: unknown }
export type JsonRpcResponse = { jsonrpc: '2.0'; id: JsonRpcId; result?: unknown; error?: RpcError }
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

// Three-way: an id and a method is a request, an id alone is a response, anything else is
// a notification. The order cannot be reversed - "id but no method" is what makes a
// response, so requests have to be recognised first or a server-to-client request reads as
// a response. `id: null` (the error response JSON-RPC 2.0 allows when a request could not
// be parsed at all) lands in the response case, where a null key never matches the pending
// table and dispatch drops it. Our own server does not send those; the three foreign
// imports will meet them, and that layer is where they should become connection-level
// errors rather than a fourth case here.
export function classify(msg: JsonRpcMessage): 'request' | 'response' | 'notification' {
  const hasId = 'id' in msg && msg.id !== undefined
  const hasMethod = 'method' in msg && typeof (msg as JsonRpcRequest).method === 'string'
  if (hasId && hasMethod) return 'request'
  if (hasId) return 'response'
  return 'notification'
}

export type CloseInfo = {
  reason: 'eof' | 'error' | 'closed' | 'exit'
  exitCode?: number | null
  signal?: string | null
  stderrTail?: string
  error?: Error
}

export type TransportHandlers = {
  onMessage(msg: JsonRpcMessage): void
  onClose(info: CloseInfo): void
}

export interface Transport {
  readonly kind: 'inproc' | 'stdio' | 'unix' | 'ws'
  send(msg: JsonRpcMessage): Promise<void>
  close(): Promise<void>
}

// A factory rather than a built transport: reconnect (Task 15) has to be able to build
// another one, and the handlers must be bound before the transport starts producing
// messages - there is no window in which one exists but nobody is subscribed.
export type TransportFactory = (handlers: TransportHandlers) => Promise<Transport>
