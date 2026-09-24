import { createHash } from 'node:crypto'

/**
 * Canonical JSON: object keys sorted, no whitespace, arrays kept in order, and keys whose value is
 * `undefined` dropped so that an absent field and an explicitly-undefined one hash the same. Feeding
 * a hash `JSON.stringify` output directly would make the digest depend on key insertion order, which
 * is exactly the kind of accidental instability a fingerprint must not have.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(',')}}`
}

export function sha256Hex(text: string | Uint8Array): string {
  return createHash('sha256').update(text).digest('hex')
}
