import { pluginFailureHelp, validatePackageAdminData } from '@agnes/protocol'

/** The admin envelope uses reason; admit only the protocol's fixed package error vocabulary. */
export function packageManageReplyError(error: unknown): { code: string; message: string } {
  const value = error as { data?: { reason?: unknown; code?: unknown } } | null
  for (const code of [value?.data?.reason, value?.data?.code]) {
    if (typeof code !== 'string') continue
    if (
      validatePackageAdminData('PackageAdminError', {
        code,
        safeMessage: 'Package operation failed.',
        blockers: [],
      }).ok
    )
      return {
        code,
        message: `${code}: ${code === 'E_PACKAGE_PREVIEW_STALE' ? 'Read the candidate again before editing or requesting review.' : pluginFailureHelp(code).fixHint}`,
      }
  }
  return {
    code: 'HELPER_MANAGEMENT_FAILED',
    message: 'The AGH extension operation did not finish. Check its status or policy in Settings.',
  }
}
