import {
  attachmentErrorCode,
  publicErrorContract,
  publicErrorCopy,
  publicErrorReason,
  publicRejectionRpc,
  rpcError,
} from '@agnes/protocol'
import { failureFacts } from './failure-facts.js'

// The ledger's bounded scan diagnostic contains only counts, sequence bounds and an order enum.
const scanDiagnostic =
  /^E_SCAN_TRUNCATED: scan matched more than ([1-9]\d{0,15}) rows \(pageMax=\1 requested=(?:all|[1-9]\d{0,15}) fromSeq=(?:start|\d{1,16}) toSeq=(?:end|\d{1,16}) order=(?:asc|desc)\)$/

/** Only fixed public text, declared reasons and the closed numeric scan diagnostic cross the link. */
export function workerDomainFailure(error: unknown) {
  const attachment = attachmentErrorCode(error)
  if (attachment) return rpcError('INVALID_PARAMS', { code: attachment })
  let raw: unknown
  let message: unknown
  try {
    raw =
      error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined
    if (raw === 'E_SCAN_TRUNCATED') message = Object.getOwnPropertyDescriptor(error, 'message')?.value
  } catch {
    /* A malformed exception remains a generic worker failure. */
  }
  const code = typeof raw === 'string' && raw.length > 0 ? raw : 'E_WORKER'
  if (code === 'E_SCAN_TRUNCATED' && typeof message === 'string' && scanDiagnostic.test(message))
    return { code, message }
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
  // The daemon audits only what it is sent; a file error keeps its call and file kinds, never a path.
  const { errorCode: _code, ...file } = failureFacts(error)
  return {
    code,
    message: contract ? publicErrorCopy(code, reason).en.reason : 'Worker operation failed.',
    ...(reason ? { reason } : {}),
    ...file,
  }
}
