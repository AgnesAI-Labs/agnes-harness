import type { WireAdapter } from './adapter.js'
import { AiSetupError } from './errors.js'

/**
 * Whether a value can authenticate anything.
 *
 * `trim()` removes whitespace and line terminators and nothing else, so a zero-width space, a NUL
 * and a soft hyphen all survive it and would be stored as though they were a secret. The first two
 * are then refused a layer lower by the HTTP client, which reports them as a retryable transport
 * failure rather than the permanent auth failure they are; the third reaches the wire as a `Bearer`
 * with one invisible character after it. So the question is not whether anything is left after
 * trimming but whether any of it is printable: one character outside Unicode's Other category.
 */
export function isUsableCredential(value: string): boolean {
  return /\P{C}/u.test(value.trim())
}

/**
 * Resolves every declared credential reference once, at assembly time, and hands the value to the
 * adapter that owns the route. Resolving up front means a missing or unreadable secret stops startup
 * instead of surfacing mid-turn as a failed request, and it keeps the secret store out of the
 * request path entirely.
 *
 * A lookup that throws and one that answers with an empty or whitespace-only string are the same
 * outcome — no usable credential — and all of them stop assembly. The error names the route and the reference only: the value,
 * and anything the store said while failing, never travel, because this error is going to be logged.
 */
export type CredentialResolutionOptions = Readonly<{
  /**
   * Credential references deliberately allowed to be absent at assembly.  This is only for routes
   * that are pre-registered so an interactive client can configure them later; the adapter keeps
   * them unbound and answers AUTH before any network I/O when one is selected.
   */
  optionalRefs?: ReadonlySet<string>
}>

export function resolveCredentials(
  adapters: WireAdapter[],
  secrets: (ref: string) => string,
  options: CredentialResolutionOptions = {},
): void {
  for (const adapter of adapters) {
    for (const decl of adapter.routes()) {
      if (!decl.credentialRef) continue
      const failure = new AiSetupError('SECRET_UNRESOLVED', {
        route: decl.route,
        ref: decl.credentialRef,
      })
      let value: string
      try {
        value = secrets(decl.credentialRef)
      } catch {
        if (options.optionalRefs?.has(decl.credentialRef)) continue
        throw failure
      }
      // Empty, whitespace-only and invisible-only are the same outcome: nothing that can
      // authenticate a request.
      if (!isUsableCredential(value)) {
        if (options.optionalRefs?.has(decl.credentialRef)) continue
        throw failure
      }
      adapter.bindCredential(decl.route, value)
    }
  }
}
