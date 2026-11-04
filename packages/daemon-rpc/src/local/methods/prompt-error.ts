import { type RpcError, rpcError } from '@agnes/protocol'

/** Credential guidance stays redacted while retaining an independent terminal-close failure. */
export function authPromptError(error: unknown, fallbackRoute?: string): RpcError {
  const value = error as { modelRoute?: string; closeError?: { code?: unknown } } | undefined
  const route = value?.modelRoute ?? fallbackRoute
  const closeCode = value?.closeError?.code
  return rpcError('SEMANTIC_REJECTED', {
    code: 'CONFIG_CREDENTIAL_REJECTED',
    turnEnd: { reason: 'error' },
    ...(route ? { modelRoute: route } : {}),
    retryable: false,
    error: {
      code: 'AUTH',
      ...(typeof closeCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(closeCode)
        ? { closeError: { code: closeCode } }
        : {}),
    },
  })
}
