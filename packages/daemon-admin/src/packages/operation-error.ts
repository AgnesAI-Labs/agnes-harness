import { safeAuthoringDiagnostics } from '@agnes/error-sanitization'
import { type PackageAdminError, rpcError } from '@agnes/protocol'

/** RPC carries controlled diagnostics, never raw exception messages or detail bags. */
export function operationError(error: PackageAdminError): never {
  throw rpcError('SEMANTIC_REJECTED', {
    reason: error.code,
    diagnostics: safeAuthoringDiagnostics(error.diagnostics),
  })
}
