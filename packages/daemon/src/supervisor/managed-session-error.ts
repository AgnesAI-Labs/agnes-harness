import { AGNES_ERRORS, JSONRPC_ERRORS, type RpcError } from '@agnes/protocol'

const CODES = new Map<number, string>(
  Object.entries({ ...AGNES_ERRORS, ...JSONRPC_ERRORS }).map(([name, code]) => [code, name]),
)
const MISSING_GATES = new Set(['outward-checkpoint', 'os-boundary'])
const REASON = /^[A-Z][A-Z0-9_]{0,63}$/u

/**
 * A managed-session refusal keeps its RPC code, its error name and the fixed `reason` and `missing`
 * enums the plugin acts on. Anything else, including messages and other data, stays in the daemon.
 * An error that is not an RPC refusal gets undefined, so the caller sends the generic reply.
 */
export function managedSessionReplyError(error: unknown): RpcError | undefined {
  const value = error as {
    code?: unknown
    data?: { code?: unknown; reason?: unknown; missing?: unknown }
  } | null
  const name = typeof value?.code === 'number' ? CODES.get(value.code) : undefined
  if (!name || value === null || value.code === undefined) return undefined
  const reason =
    typeof value.data?.reason === 'string' && REASON.test(value.data.reason) ? value.data.reason : undefined
  const missing =
    typeof value.data?.missing === 'string' && MISSING_GATES.has(value.data.missing)
      ? value.data.missing
      : undefined
  const dataCode =
    typeof value.data?.code === 'string' && REASON.test(value.data.code) ? value.data.code : name
  return {
    code: value.code as number,
    message: name,
    data: { code: dataCode, ...(reason ? { reason } : {}), ...(missing ? { missing } : {}) },
  }
}
