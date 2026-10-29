import type { AppServerError, AppServerErrorCause } from '../gen/ts/app-server.js'
import { adminDiagnosticCause, recordDiagnostic } from './diagnostic-records.js'
import { AGNES_ERRORS, JSONRPC_ERRORS, type RpcError } from './errors.js'
import { publicErrorCode, publicErrorContract, publicErrorCopy, publicErrorReason } from './public-errors.js'

/** Pure classification for safe diagnostic records; does not create or persist an error. */
export function errorMessageKey(code: string): AppServerError['data']['messageKey'] {
  return publicErrorContract(code)?.messageKey ?? 'appServer.errors.internal'
}
/** Only a closed cause code crosses the boundary; messages, stacks and nested data never do. */
function knownCause(value: unknown): value is AppServerErrorCause['code'] {
  return publicErrorContract(value) !== undefined
}
/** `diagnosticCause` is journal-only (validated by `adminDiagnosticCause`); the response body never carries it. */
export function normalizeRpcError(error: RpcError, diagnosticCause?: string): AppServerError {
  const names = { ...AGNES_ERRORS, ...JSONRPC_ERRORS }
  const name = Object.entries(names).find(([, number]) => number === error.code)?.[0] ?? 'INTERNAL_ERROR'
  const {
    cause: _cause,
    messageKey: _key,
    diagnosticId: oldId,
    publicReason: _reason,
    userAction: _action,
    ...data
  } = error.data
  const candidate = publicErrorCode(error)
  const cause = candidate ? { code: candidate } : undefined
  const contract = publicErrorContract(candidate)
  const copy = publicErrorCopy(candidate, publicErrorReason(error)).en
  const diagnosticId =
    typeof oldId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(oldId)
      ? oldId
      : crypto.randomUUID()
  const journalCause = cause?.code ?? adminDiagnosticCause(diagnosticCause)
  const available = recordDiagnostic({
    diagnosticId,
    at: new Date().toISOString(),
    code: error.code,
    name,
    ...(journalCause ? { cause: journalCause } : {}),
  })
  return {
    code: error.code,
    message: name,
    data: {
      // Method boundaries allowlist and redact public details before creating RpcError data.
      // Preserve those fields (ids, revisions, retry hints); this normalizer owns only the envelope.
      ...data,
      code: error.data.code,
      messageKey: (() => {
        if (cause?.code === 'E_SANDBOX_WORKSPACE' && data.reason === 'session-execution-record-invalid')
          return 'appServer.errors.sessionSandbox'
        const key = errorMessageKey(cause?.code ?? data.code)
        return key === 'appServer.errors.internal' ? errorMessageKey(name) : key
      })(),
      diagnosticId,
      ...(!available ? { diagnosticUnavailable: true } : {}),
      ...(cause ? { cause } : {}),
      ...(contract ? { publicReason: copy.reason, userAction: copy.action } : {}),
    },
  }
}
/** HTTP status stays transport metadata; the body uses the same numeric RPC error envelope. */
export function httpRpcError(status: number, code: string, diagnosticCause?: string): AppServerError {
  const number =
    status === 401
      ? AGNES_ERRORS.AUTH_INVALID
      : status === 403
        ? AGNES_ERRORS.CAPABILITY_DENIED
        : status === 404
          ? JSONRPC_ERRORS.METHOD_NOT_FOUND
          : status === 409
            ? AGNES_ERRORS.SEMANTIC_REJECTED
            : status >= 500
              ? JSONRPC_ERRORS.INTERNAL_ERROR
              : JSONRPC_ERRORS.INVALID_PARAMS
  return normalizeRpcError(
    {
      code: number,
      message: code,
      data: { code, ...(knownCause(code) ? { cause: { code } } : {}) },
    },
    diagnosticCause,
  )
}
