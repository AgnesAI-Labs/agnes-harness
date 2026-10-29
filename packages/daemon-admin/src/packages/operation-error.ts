import { safeAuthoringDiagnostics } from '@agnes/error-sanitization'
import { type PackageAdminError, type PluginFailureHelp, pluginFailureHelp, rpcError } from '@agnes/protocol'

const refusalHints = {
  'package-running': 'Disable the package first, wait for it to stop, then retry removal.',
  'cleanup-pending':
    'Disable the package first and wait for its resource cleanup to finish, then retry removal.',
  'activation-unavailable':
    'Restore the package runtime connection so its stopped state can be verified, then retry removal.',
  residue:
    'Disable the package first, wait for its live extension resources to be released, then retry removal.',
  dependents: 'Remove or update packages that depend on this package before retrying removal.',
} as const

export function removalRefusal(
  reason: 'package-running' | 'cleanup-pending' | 'activation-unavailable',
  id: string,
) {
  return {
    code: 'E_PACKAGE_STATE',
    detail: { reason, blockers: [{ code: 'generation', references: [id, reason] }] },
  }
}

/** RPC carries controlled diagnostics, never raw exception messages or detail bags. */
export function operationError(error: PackageAdminError): never {
  throw rpcError('SEMANTIC_REJECTED', {
    reason: error.code,
    diagnostics: safeAuthoringDiagnostics(error.diagnostics),
  })
}

/**
 * A refusal that recovery cannot heal names the local file to restore (for example a damaged tree or
 * audit line). The admin caller owns this machine, so the path is shown in the fix hint.
 */
/** Help for a refused package call: the closed hint for its reason, plus the local file it names. */
export function failureHelp(
  blockers: readonly { references: readonly string[] }[],
  detail: Record<string, unknown> | undefined,
  fallback: unknown,
): PluginFailureHelp {
  const reason = blockers.some((b) => b.references.includes('capability-blocked'))
    ? 'capability blocked'
    : String(detail?.reason ?? fallback)
  const help = pluginFailureHelp(reason)
  const fixHint = Object.hasOwn(refusalHints, reason)
    ? refusalHints[reason as keyof typeof refusalHints]
    : undefined
  return recoveryHint(fixHint ? { ...help, fixHint } : help, detail)
}

export function recoveryHint<T extends { fixHint?: string }>(
  help: T,
  detail: Record<string, unknown> | undefined,
): T {
  if (typeof detail?.path !== 'string' || !detail.path) return help
  const repair = typeof detail.repair === 'string' ? ` ${detail.repair}` : ''
  const base = help.fixHint ? `${help.fixHint} ` : ''
  return { ...help, fixHint: `${base}File: ${detail.path}.${repair}`.slice(0, 512) }
}
