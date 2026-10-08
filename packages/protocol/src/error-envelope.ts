import { Value } from '@sinclair/typebox/value'
import { type AppServerError, AppServerErrorCause } from '../gen/ts/app-server.js'
import { recordDiagnostic } from './diagnostic-records.js'
import { AGNES_ERRORS, JSONRPC_ERRORS, type RpcError } from './errors.js'

function errorMessageKey(code: string): AppServerError['data']['messageKey'] {
  if (code === 'CONFIG_CREDENTIAL_REQUIRED') return 'appServer.errors.credentialRequired'
  if (code === 'CONFIG_CREDENTIAL_REJECTED') return 'appServer.errors.credentialRejected'
  if (code.startsWith('CONFIG_CREDENTIAL_')) return 'appServer.errors.credentialStore'
  if (code.startsWith('E_PROVIDER_')) return 'appServer.errors.provider'
  if (code.startsWith('E_GENERATION_')) return 'appServer.errors.generation'
  if (code.includes('REVISION_CONFLICT') || code === 'GENERATION_STALE') return 'appServer.errors.conflict'
  if (code.includes('TIMEOUT')) return 'appServer.errors.timeout'
  if (code.includes('AUTH')) return 'appServer.errors.auth'
  if (
    code.includes('FORBIDDEN') ||
    code.includes('DENIED') ||
    code.includes('PERMISSION') ||
    code.includes('ORIGIN')
  )
    return 'appServer.errors.forbidden'
  if (code.includes('BUSY')) return 'appServer.errors.busy'
  if (code === 'METHOD_NOT_FOUND') return 'appServer.errors.methodNotFound'
  if (code.includes('NOT_FOUND')) return 'appServer.errors.notFound'
  if (code.includes('ROUTE')) return 'appServer.errors.methodNotFound'
  if (code === 'PARSE_ERROR' || code === 'INVALID_REQUEST') return 'appServer.errors.invalidRequest'
  if (
    code === 'INVALID_PARAMS' ||
    code.includes('INVALID') ||
    code.includes('REQUEST') ||
    code.includes('BODY_TOO_LARGE')
  )
    return 'appServer.errors.invalidParams'
  if (
    code.includes('UNAVAILABLE') ||
    code.includes('UNCONFIGURED') ||
    code.includes('NOT_CONFIGURED') ||
    code.includes('UNSUPPORTED')
  )
    return 'appServer.errors.unavailable'
  if (code === 'SEMANTIC_REJECTED') return 'appServer.errors.rejected'
  return 'appServer.errors.internal'
}
/** Only a closed cause code crosses the boundary; messages, stacks and nested data never do. */
function knownCause(value: unknown): value is AppServerErrorCause['code'] {
  return typeof value === 'string' && Value.Check(AppServerErrorCause, { code: value })
}
export function normalizeRpcError(error: RpcError): AppServerError {
  const names = { ...AGNES_ERRORS, ...JSONRPC_ERRORS }
  const name = Object.entries(names).find(([, number]) => number === error.code)?.[0] ?? 'INTERNAL_ERROR'
  const { cause: supplied, messageKey: _key, diagnosticId: oldId, ...data } = error.data
  const candidate =
    supplied && typeof supplied === 'object'
      ? (supplied as { code?: unknown }).code
      : (data.reason ?? data.code)
  const cause = knownCause(candidate) ? { code: candidate } : undefined
  const diagnosticId =
    typeof oldId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(oldId)
      ? oldId
      : crypto.randomUUID()
  const available = recordDiagnostic({
    diagnosticId,
    at: new Date().toISOString(),
    code: error.code,
    name,
    ...(cause ? { cause: cause.code } : {}),
  })
  return {
    code: error.code,
    message: name,
    data: {
      ...data,
      code: error.data.code,
      messageKey: (() => {
        const key = errorMessageKey(cause?.code ?? data.code)
        return key === 'appServer.errors.internal' ? errorMessageKey(name) : key
      })(),
      diagnosticId,
      ...(!available ? { diagnosticUnavailable: true } : {}),
      ...(cause ? { cause } : {}),
    },
  }
}
/** HTTP status stays transport metadata; the body uses the same numeric RPC error envelope. */
export function httpRpcError(status: number, code: string): AppServerError {
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
  return normalizeRpcError({
    code: number,
    message: code,
    data: { code, ...(knownCause(code) ? { cause: { code } } : {}) },
  })
}
