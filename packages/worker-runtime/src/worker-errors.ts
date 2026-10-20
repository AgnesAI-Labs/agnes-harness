import {
  attachmentErrorCode,
  publicErrorContract,
  publicErrorCopy,
  publicErrorReason,
  publicRejectionRpc,
  rpcError,
} from '@agnes/protocol'

/** The worker link carries fixed public text and declared reasons, never exception messages or detail. */
export function workerDomainFailure(error: unknown) {
  const attachment = attachmentErrorCode(error)
  if (attachment) return rpcError('INVALID_PARAMS', { code: attachment })
  let raw: unknown
  try {
    raw =
      error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined
  } catch {
    /* A malformed exception remains a generic worker failure. */
  }
  const code = typeof raw === 'string' && raw.length > 0 ? raw : 'E_WORKER'
  const reason = publicErrorReason(error)
  if (code === 'E_PRESET_UNSUPPORTED') {
    if (reason === 'bundle-unavailable')
      return rpcError('SEMANTIC_REJECTED', {
        code: 'BUNDLE_UNAVAILABLE',
        reason: 'selected bundle is not installed, enabled and trusted',
      })
    if (reason === 'preset-not-allowed')
      return rpcError('PRESET_SWITCH_REJECTED', { reason: 'not in presets.allowed' })
  }
  const contract = publicErrorContract(code)
  const rejection = publicRejectionRpc(error)
  if (rejection && contract?.rpc === 'PRESET_SWITCH_REJECTED') return rejection
  return {
    code,
    message: contract ? publicErrorCopy(code, reason).en.reason : 'Worker operation failed.',
    ...(reason ? { reason } : {}),
  }
}
