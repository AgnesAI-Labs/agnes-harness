/**
 * The closed set of refusals this package raises. Nineteen come from the specification and the host
 * design; `E_PRESET_UNRESOLVED` and `E_HOST_CLOSED` were added when the two call sites that needed
 * them turned out to have no code of their own. `E_MODEL_UNSUPPORTED` (Task 27a) is the third: the
 * runtime model-switch gate's own policy refusal, distinct from core's structural E_MODEL_UNKNOWN.
 * `E_HOME_INVALID` is the fourth, for paths.ts's AGH_HOME validation.
 */
export const HOST_ERROR_CODES = [
  'E_PROFILE_FRAGMENT_KEY',
  'E_PROFILE_CYCLE',
  'E_PACKAGE_DUPLICATE',
  'E_PACKAGE_QUARANTINED',
  'E_DEP_MISSING',
  'E_SEAM_MISSING',
  'E_SEAM_INIT',
  'E_CEILING_EXCEEDED',
  'E_SEAM_IMMUTABLE',
  'E_STATIC_COMPONENT',
  'E_LOCK_MISMATCH',
  'E_CAPABILITY_UNDECLARED',
  'E_LEASE_EXPIRED',
  'E_PRESET_UNSUPPORTED',
  'E_PRESET_UNRESOLVED',
  // Policy, not structure: the pair exists and the provider publishes it, but it falls outside the
  // route table this deployment's assembly actually materialized. Distinct from core's
  // E_MODEL_UNKNOWN, which is the structural "this id is not in the provider's sealed catalogue".
  'E_MODEL_UNSUPPORTED',
  'E_WORKSPACE_UNTRUSTED',
  'E_WORKSPACE_REQUIRED',
  'E_WORKSPACE_CLOSED',
  'E_SANDBOX_WORKSPACE',
  'E_REMOTE_WORKSPACE',
  'E_MANAGED_POLICY_CORRUPT',
  'E_SECRET_UNRESOLVED',
  'E_API_RANGE',
  'E_SEAM_EXPORT_MISSING',
  'E_EXT_LOAD',
  'E_EXT_ISOLATION_UNAVAILABLE',
  // A lifecycle refusal, not a seam refusal: createSession after close() used to raise
  // E_SEAM_IMMUTABLE, the code for "a seam implementation may not be swapped".
  'E_HOST_CLOSED',
  // paths.ts refuses a relative AGH_HOME instead of resolving it against whatever the process's
  // cwd happens to be -- the same silent-relocation shape as the dataDir default it also fixed.
  'E_HOME_INVALID',
] as const
export type HostErrorCode = (typeof HOST_ERROR_CODES)[number]
export type Layer = 'builtin' | 'user' | 'workspace' | 'local' | 'flags' | 'managed'
export type ErrorSource = { file?: string; line?: number; layer?: Layer }

import { looksLikeSecret, REDACTED_ERROR_MESSAGE } from '@agnes/package-manager'

export { looksLikeSecret } from '@agnes/package-manager'

export class HostError extends Error {
  readonly code: HostErrorCode
  readonly source?: ErrorSource
  readonly detail?: Record<string, unknown>
  constructor(
    code: HostErrorCode,
    message: string,
    opts: { source?: ErrorSource; detail?: Record<string, unknown> } = {},
  ) {
    const leaked = looksLikeSecret(message)
    super(`${code}: ${leaked ? REDACTED_ERROR_MESSAGE : message}`)
    this.name = 'HostError'
    this.code = code
    if (opts.source) this.source = opts.source
    if (leaked) this.detail = { ...opts.detail, redacted: true }
    else if (opts.detail) this.detail = opts.detail
  }
}

export function isHostError(e: unknown, code?: HostErrorCode): e is HostError {
  return e instanceof HostError && (code === undefined || e.code === code)
}
