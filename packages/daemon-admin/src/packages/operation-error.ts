import { safeAuthoringDiagnostics } from '@agnes/error-sanitization'
import { type PackageAdminError, type PluginFailureHelp, pluginFailureHelp, rpcError } from '@agnes/protocol'

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
  return recoveryHint(pluginFailureHelp(reason), detail)
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
