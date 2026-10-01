import { jcs } from '@agnes/protocol'
import { type IntegrityCanonicalizeResult, validateRuntime } from '@agnes/protocol/runtime'
import { sha256Hex, utf8 } from '../../request/hash.js'
import { failIntegrity } from './validation.js'

/** Pure canonicalization; admission and current authorization belong to the provider boundary. */
export function canonicalizeIntegrity(input: unknown): IntegrityCanonicalizeResult {
  const checked = validateRuntime('IntegrityCanonicalizeRequest', input)
  if (!checked.ok)
    failIntegrity(
      checked.errors.some((error) => error.code === 'RANGE') ? 'quota' : 'invalid_input',
      'integrity_input_invalid',
    )
  const canonical = jcs(checked.value.value)
  return { canonical, digest: sha256Hex(canonical), bytes: utf8(canonical).byteLength }
}
