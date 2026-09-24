import { canonicalJson, sha256Hex } from '../request/hash.js'

/**
 * The hash of a call's arguments, and half of what binds an approval to the call it was granted
 * for. Canonical JSON first, so two spellings of the same arguments bind to the same approval and
 * a changed argument does not.
 */
export function argvHash(args: unknown): string {
  return sha256Hex(canonicalJson(args ?? null))
}
