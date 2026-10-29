// SHA-256 and a canonical JSON serializer, both pure. SHA-256 comes from `#sha256`: Node resolves it
// to `node:crypto`, any other host to the portable implementation, and the two are pinned byte for
// byte by the differential tests. `node:crypto` may only be reached through that import, never
// directly from this package. A canonicalization that reordered keys differently on another runtime
// would make two identical requests hash differently.

import { SHA256_IMPLEMENTATION as selected } from '#sha256'
import type { Sha256Implementation } from './sha256-types.js'

export { createSha256, sha256Hex } from '#sha256'
export type { Sha256Implementation, Sha256Stream } from './sha256-types.js'
/** Typed as the union so a comparison against either value checks under every module resolution. */
export const SHA256_IMPLEMENTATION: Sha256Implementation = selected

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

/**
 * One byte sequence per JSON value: object keys sorted by UTF-16 code unit, array order kept,
 * `undefined` members dropped from objects and written as `null` inside arrays (dropping them there
 * would shift every later index). Two requests that differ only in the order their keys were built
 * therefore hash the same, which is what makes `headerEquals` and `derived_hash` mean anything.
 */
export function canonicalJson(value: unknown): string {
  // `JSON.stringify` answers `undefined` — not a string — for these three at the top level, which
  // would hand a caller hashing the result a `TypeError` or the literal text `undefined`. They are
  // written as `null`, the same way an undefined array member already is.
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value))
    return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`
}
