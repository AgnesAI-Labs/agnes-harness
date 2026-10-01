import { jcs } from '@agnes/protocol'
import { canonicalJsonDigest, type JsonValue } from '@agnes/protocol/runtime'

export const CONFIG_PROVIDER_ID = 'agh.default/config'
export const CONFIG_CONTRACT = 'agh.config'
export const CONFIG_PACKAGE = '@agnes/host'
export const RESOLVE_ALGORITHM = 'agh.config/resolve-v1'
export const MAX_CONFIG_DEPTH = 16
export const MAX_INLINE_BYTES = 1_048_576

export const CONFIG_REFUSAL_CODES = [
  'schema_invalid',
  'content_identity_mismatch',
  'extends_missing',
  'extends_digest_mismatch',
  'extends_cycle',
  'extends_depth',
  'duplicate_package',
  'duplicate_cell',
  'duplicate_declaration',
  'disabled_package_revived',
  'source_replaced',
  'selection_not_allowed',
  'configuration_widens_authority',
  'entry_selection_invalid',
  'workspace_forbidden',
  'session_selection_forbidden',
  'config_override_forbidden',
  'unknown_schema',
  'parameter_schema_mismatch',
  'provider_config_invalid',
  'provider_not_selected',
  'secret_material',
  'path_not_absolute',
  'home_unresolved',
  'source_unavailable',
  'revision_conflict',
  'cancelled',
  'disposed',
  'document_too_large',
  'limit_conflict',
] as const

export type ConfigRefusalCode = (typeof CONFIG_REFUSAL_CODES)[number]

export type ConfigRefusal = {
  code: ConfigRefusalCode
  path: string
  message: string
}

export type ConfigOutcome<T> = { ok: true; result: T } | { ok: false; refusal: ConfigRefusal }

export function configRefusal(code: ConfigRefusalCode, path: string, message: string): ConfigRefusal {
  return { code, path, message }
}

export function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

export function documentDigest(value: unknown): string {
  return canonicalJsonDigest(jsonValue(value))
}

export function canonicalByteLength(value: unknown): number {
  return new TextEncoder().encode(jcs(jsonValue(value))).length
}

export function sameDocument(left: unknown, right: unknown): boolean {
  return documentDigest(left) === documentDigest(right)
}
