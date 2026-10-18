import { type AuthoringDiagnostic, safeAuthoringDiagnostics } from '@agnes/error-sanitization'
import { pluginFailureHelp, validatePackageAdminData } from '@agnes/protocol'

/** Preserve fixed candidate-port and package error codes; only forward allowlisted bounded diagnostics. */
export function packageManageReplyError(error: unknown): {
  code: string
  message: string
  diagnostics?: AuthoringDiagnostic[]
} {
  const value = error as {
    code?: unknown
    data?: { reason?: unknown; code?: unknown; diagnostics?: unknown }
  } | null
  for (const code of [value?.data?.reason, value?.data?.code, value?.code]) {
    if (typeof code !== 'string') continue
    if (
      [
        'PLUGIN_CANDIDATE_STALE',
        'PLUGIN_MANAGEMENT_UNAVAILABLE',
        'PLUGIN_PERMISSION_REQUIRED',
        'PLUGIN_LOCAL_OWNER_REQUIRED',
        'PLUGIN_TEST_REJECTED',
        'PLUGIN_TEST_UNANSWERED',
        'PLUGIN_TEST_SANDBOX_REQUIRED',
        'PLUGIN_FILES_INVALID',
        'CAPABILITY_DENIED',
        'INVALID_PARAMS',
      ].includes(code)
    )
      return {
        code,
        message: `${code}: The authoring operation was refused. Inspect the candidate and its current capability or policy.`,
      }
    if (
      validatePackageAdminData('PackageAdminError', {
        code,
        safeMessage: 'Package operation failed.',
        blockers: [],
      }).ok
    )
      return {
        code,
        diagnostics: safeAuthoringDiagnostics(value?.data?.diagnostics),
        message: `${code}: ${code === 'E_PACKAGE_PREVIEW_STALE' ? 'Read the candidate again before editing or requesting review.' : pluginFailureHelp(code).fixHint}`,
      }
  }
  return {
    code: 'HELPER_MANAGEMENT_FAILED',
    message: 'The AGH extension operation did not finish. Check its status or policy in Settings.',
  }
}
