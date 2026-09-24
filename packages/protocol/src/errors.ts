export const AGNES_ERRORS = {
  OVERLOADED: -32001,
  SESSION_BUSY: -32002,
  SESSION_NOT_FOUND: -32003,
  GENERATION_STALE: -32004,
  CURSOR_OUT_OF_RANGE: -32005,
  CAPABILITY_DENIED: -32006,
  AUTH_INVALID: -32007,
  PRESET_SWITCH_REJECTED: -32008,
  APPROVAL_REJECTED: -32009,
  CLAIM_DENIED: -32010,
  SEMANTIC_REJECTED: -32011,
  REQUEST_TIMEOUT: -32012,
  OUTCOME_UNKNOWN: -32013,
} as const
export const JSONRPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const
export type AgnesErrorName = keyof typeof AGNES_ERRORS | keyof typeof JSONRPC_ERRORS

export type RpcError = { code: number; message: string; data: { code: string } & Record<string, unknown> }

export function rpcError(name: AgnesErrorName, data: Record<string, unknown> = {}): RpcError {
  const code =
    name in AGNES_ERRORS
      ? AGNES_ERRORS[name as keyof typeof AGNES_ERRORS]
      : JSONRPC_ERRORS[name as keyof typeof JSONRPC_ERRORS]
  const dataCode = typeof data.code === 'string' ? data.code : name
  return { code, message: name, data: { ...data, code: dataCode } }
}
