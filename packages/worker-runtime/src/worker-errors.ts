import { domainFailureFromUnknown } from '@agnes/error-sanitization'
import { attachmentErrorCode, rpcError } from '@agnes/protocol'

/** Preserve a fixed attachment refusal across the worker link without exposing native messages. */
export function workerDomainFailure(error: unknown) {
  const code = attachmentErrorCode(error)
  return code ? rpcError('INVALID_PARAMS', { code }) : domainFailureFromUnknown(error)
}
