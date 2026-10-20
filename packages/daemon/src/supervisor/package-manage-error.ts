import { type AuthoringDiagnostic, safeAuthoringDiagnostics } from '@agnes/error-sanitization'
import { publicErrorHelp } from '@agnes/protocol'

/** Fixed contract text and separately allowlisted diagnostics; never authoring logs or exceptions. */
export function packageManageReplyError(error: unknown): {
  code: string
  message: string
  diagnostics?: AuthoringDiagnostic[]
} {
  const help = publicErrorHelp(error)
  if (help) {
    const value = error as { data?: { diagnostics?: unknown } } | null
    return {
      code: help.code,
      message: `${help.code}: ${help.reason} ${help.action}`,
      diagnostics: safeAuthoringDiagnostics(value?.data?.diagnostics),
    }
  }
  return {
    code: 'HELPER_MANAGEMENT_FAILED',
    message: 'The AGH extension operation did not finish. Check its status or policy in Settings.',
  }
}
