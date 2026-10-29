import type { DiagnosticRecord } from '@agnes/protocol'

export const ERROR_KINDS = ['permission', 'provider', 'plugin', 'other'] as const
export type ErrorKind = (typeof ERROR_KINDS)[number]

/** Known error names and causes (`@agnes/protocol` errors and `AppServerErrorCause`). */
const EXACT: Readonly<Record<string, ErrorKind>> = {
  AUTH_INVALID: 'permission',
  CAPABILITY_DENIED: 'permission',
  CLAIM_DENIED: 'permission',
  APPROVAL_REJECTED: 'permission',
  MEMORY_SCOPE_DENIED: 'permission',
  MEMORY_APPROVAL_REJECTED: 'permission',
  CONFIG_MODEL_UNAVAILABLE: 'provider',
  CONFIG_TEST_FAILED: 'provider',
  CONFIG_UNKNOWN_PROVIDER: 'provider',
  CONFIG_ENDPOINT_OVERRIDE_UNSUPPORTED: 'provider',
  E_MCP_SANDBOX_UNAVAILABLE: 'plugin',
  GENERATION_STALE: 'plugin',
}
/** Families by prefix. `E_PROVIDER_*` is the plugin provider registry, not a model service. */
const PREFIXES: readonly (readonly [string, ErrorKind])[] = [
  ['CONFIG_AUTH_', 'provider'],
  ['CONFIG_CREDENTIAL_', 'provider'],
  ['CONFIG_PROVIDER_', 'provider'],
  ['CONFIG_SUBSCRIPTION_', 'provider'],
  ['E_GENERATION_', 'plugin'],
  ['E_PACKAGE_', 'plugin'],
  ['E_PROVIDER_', 'plugin'],
  ['E_SEAM_PIN_', 'plugin'],
]

/** The kind shown as the row's tag and filter: the cause decides first, then the name; unknown is Other. */
export function errorKind(record: Pick<DiagnosticRecord, 'name' | 'cause'>): ErrorKind {
  for (const code of [record.cause, record.name]) {
    if (!code) continue
    const kind = EXACT[code] ?? PREFIXES.find(([prefix]) => code.startsWith(prefix))?.[1]
    if (kind) return kind
  }
  return 'other'
}
