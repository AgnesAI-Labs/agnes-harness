import { BRIDGE_ERRORS, type BridgeResponse } from '@agnes/protocol'

export type BridgeError = Extract<BridgeResponse, { error: unknown }>['error']
const messages: Record<BridgeError['code'], string> = {
  ...BRIDGE_ERRORS,
  '-32600': 'invalid bridge request',
  '-32601': 'unknown bridge method',
  '-32602': 'invalid bridge parameters',
  '-32603': 'internal bridge error',
  '-32700': 'invalid bridge JSON',
  '-32800': 'bridge call cancelled',
}
const governed: Record<string, BridgeError['code']> = {
  E_DEPTH_EXCEEDED: 1003,
  BUDGET_EXCEEDED: 1001,
  APPROVAL_REJECTED: 1002,
  DEPTH_EXCEEDED: 1003,
  TOOL_NOT_FOUND: 1004,
  TOOL_NOT_DISCLOSED: 1004,
  TOOL_ARGS_INVALID: 1005,
  SCHEMA_INVALID: 1005,
}
export function bridgeError(code: BridgeError['code']): BridgeError {
  return { code, message: messages[code] }
}
/** Only protocol-owned codes may cross the bridge. Exception text and details never do. */
export function hasBridgeCode(error: unknown): error is { bridgeCode: BridgeError['code'] } {
  if (!error || typeof error !== 'object') return false
  const value = Object.getOwnPropertyDescriptor(error, 'bridgeCode')?.value
  return typeof value === 'number' && Object.hasOwn(messages, value)
}
export function toBridgeError(error: unknown): BridgeError {
  try {
    if (hasBridgeCode(error)) return bridgeError(error.bridgeCode)
    if (error instanceof Error && error.name === 'AbortError') return bridgeError(-32800)
    if (error && typeof error === 'object') {
      const code = Object.getOwnPropertyDescriptor(error, 'code')?.value
      if (typeof code === 'string' && Object.hasOwn(governed, code))
        return bridgeError(governed[code] as BridgeError['code'])
    }
  } catch {
    /* A hostile error object is still only an internal failure. */
  }
  return bridgeError(-32603)
}
