import { domainFailureFromUnknown } from '@agnes/error-sanitization'
import { attachmentErrorCode, rpcError } from '@agnes/protocol'

/** Preserve a fixed attachment refusal across the worker link without exposing native messages. */
export function workerDomainFailure(error: unknown) {
  const code = attachmentErrorCode(error)
  if (code) return rpcError('INVALID_PARAMS', { code })
  const failure = domainFailureFromUnknown(error)
  // Preserve closed admission refusals as RPC errors; the daemon must not turn them into UNKNOWN.
  if (['E_PRESET_UNSUPPORTED', 'E_PRESET_UNRESOLVED', 'E_MODEL_UNSUPPORTED'].includes(failure.code))
    return rpcError('PRESET_SWITCH_REJECTED', { code: failure.code })
  return failure
}
