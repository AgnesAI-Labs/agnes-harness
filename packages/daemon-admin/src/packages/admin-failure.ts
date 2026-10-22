/**
 * Journal-only causes for failures the admin BFF reports as HTTP 502. Closed categories and
 * numeric codes only: exception messages can hold local paths, tokens or user text and are never
 * copied. The protocol layer re-validates the resulting string before it is journaled.
 */
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A validated-response failure; `path` is always a fixed literal, never backend data. */
class ResponseInvalid extends Error {
  constructor(readonly path: string) {
    super('response-invalid')
  }
}
export const invalidResponse = (path: string) => new ResponseInvalid(path)
const DISCONNECTED = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENOENT', 'ENOTCONN'])
function backendReason(failure: unknown): string {
  if (failure instanceof ResponseInvalid) return `response-invalid:${failure.path}`
  if (!record(failure)) return 'backend-error'
  const rpc = failure.rpc
  if (record(rpc) && Number.isInteger(rpc.code)) return `backend-rpc-error:${rpc.code}`
  switch (failure.kind) {
    case 'transport-closed':
      return 'backend-disconnected'
    case 'request-timeout':
      return 'backend-timeout'
    case 'protocol-violation':
      return 'backend-protocol'
  }
  return typeof failure.code === 'string' && DISCONNECTED.has(failure.code)
    ? 'backend-disconnected'
    : 'backend-error'
}
export const backendCause = (failure: unknown) => `E_ADMIN_BACKEND:${backendReason(failure)}`
export const responseCause = (path: string) => `E_ADMIN_RESPONSE:response-invalid:${path}`
