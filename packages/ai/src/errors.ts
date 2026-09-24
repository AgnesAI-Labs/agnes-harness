export type AiSetupErrorCode =
  | 'DUPLICATE_ROUTE'
  | 'SECRET_UNRESOLVED'
  | 'CONTRACT_MISMATCH'
  | 'NO_ADAPTER'
  | 'UNSEALED'
  | 'INVALID_BASE_URL'

/**
 * The only error this package throws. Assembly is the one phase where failing loudly is right —
 * a misconfigured route or an unresolvable credential must stop startup rather than surface later as
 * a failed turn. Once a session is running, problems travel as `error` events instead.
 *
 * `detail` says which route and which reference failed and never carries the credential value, so an
 * error that reaches a log or a support ticket cannot leak one.
 */
export class AiSetupError extends Error {
  constructor(
    readonly code: AiSetupErrorCode,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(`${code} ${describe(detail)}`)
    this.name = 'AiSetupError'
  }
}

/**
 * The shape of every key this package writes into a `detail`: a lowerCamelCase word. Only key names
 * matching it are echoed by the degradation path below, because that path runs precisely when the
 * detail is exotic, and an exotic object chooses its own own-key names — so a name reaching the
 * message there is attacker-controlled and may be a secret presented as a key rather than a value.
 * Anything off this shape is counted instead of printed.
 */
const PLAIN_KEY = /^[a-z][A-Za-z0-9]{0,23}$/

/**
 * `JSON.stringify` throws on a circular structure and on a BigInt, which would turn an assembly
 * failure into an unrelated TypeError raised from the error constructor itself — losing the code and
 * the detail that say what actually went wrong. A constructor on a failure path has to survive its
 * own input, so an undescribable detail degrades to its key names rather than replacing the error.
 */
function describe(detail: Record<string, unknown>): string {
  try {
    return JSON.stringify(detail, (_k, v) => (typeof v === 'bigint' ? `${v}` : v)) ?? '{}'
  } catch {
    // The degradation path must not throw either. Reading own keys runs the object's own traps, and a
    // trap that throws would escape the constructor with its own message — reinstating exactly the
    // failure the outer catch exists to prevent, and doing it with input the caller controls.
    try {
      const keys = Object.keys(detail)
      const shown = keys.filter((k) => PLAIN_KEY.test(k))
      const hidden = keys.length - shown.length
      if (hidden > 0) shown.push(`+${hidden} unprintable`)
      if (shown.length === 0) return '{unserialisable detail}'
      return `{unserialisable detail, keys: ${shown.join(',')}}`
    } catch {
      return '{unserialisable detail}'
    }
  }
}
