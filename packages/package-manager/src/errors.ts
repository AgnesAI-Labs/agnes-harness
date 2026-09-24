import { looksLikeSecret, REDACTED_ERROR_MESSAGE } from '@agnes/error-sanitization'

const DOMAIN_CODES = {
  E_DEP_MISSING: 'E_PACKAGE_SOURCE',
  E_LOCK_MISMATCH: 'E_PACKAGE_INTEGRITY',
  E_WORKSPACE_UNTRUSTED: 'E_PACKAGE_TRUST',
  E_PACKAGE_QUARANTINED: 'E_PACKAGE_TRUST',
  E_API_RANGE: 'E_PACKAGE_BLOCKED',
  E_CEILING_EXCEEDED: 'E_PACKAGE_BLOCKED',
  E_EXT_LOAD: 'E_PACKAGE_STATE',
  E_PROFILE_FRAGMENT_KEY: 'E_PACKAGE_STATE',
} as const
type OperationErrorCode = 'E_PACKAGE_PREVIEW_STALE' | 'E_PACKAGE_CANCELLED'
export type PackageErrorCode = (typeof DOMAIN_CODES)[keyof typeof DOMAIN_CODES] | OperationErrorCode
export type LegacyPackageCode = keyof typeof DOMAIN_CODES
export type PackageErrorSource = {
  file?: string
  line?: number
  layer?: 'builtin' | 'user' | 'workspace' | 'local' | 'flags' | 'managed'
}

/** legacyCode is diagnostic provenance for the transitional Host adapter, never Host ownership. */
export class PackageError extends Error {
  readonly code: PackageErrorCode
  readonly detail: Readonly<Record<string, unknown>>
  readonly source?: PackageErrorSource
  readonly hasDetail: boolean
  readonly reason: string
  constructor(
    readonly legacyCode: LegacyPackageCode,
    reason: string,
    opts: { source?: PackageErrorSource; detail?: Record<string, unknown>; code?: OperationErrorCode } = {},
  ) {
    const leaked = looksLikeSecret(reason)
    const code = opts.code ?? DOMAIN_CODES[legacyCode]
    super(`${code}: ${leaked ? REDACTED_ERROR_MESSAGE : reason}`)
    this.name = 'PackageError'
    this.code = code
    this.reason = leaked ? REDACTED_ERROR_MESSAGE : reason
    this.hasDetail = opts.detail !== undefined || leaked
    this.detail = Object.freeze({ ...opts.detail, ...(leaked ? { redacted: true } : {}) })
    if (opts.source) this.source = opts.source
  }
}
export function isPackageError(error: unknown, code?: LegacyPackageCode): error is PackageError {
  return error instanceof PackageError && (code === undefined || error.legacyCode === code)
}
