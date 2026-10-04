import { type RuntimeIdentity, validateAgainst } from '@agnes/protocol'
import { RuntimeIdentity as RuntimeIdentitySchema } from '@agnes/protocol/gen/session-v1'

/** Only an absent legacy owner defaults to Native. Corrupt or unknown explicit data never does. */
export function readStoredRuntime(value: unknown): RuntimeIdentity {
  if (value === undefined) return { id: 'native', version: '1' }
  const result = validateAgainst<RuntimeIdentity>(RuntimeIdentitySchema, value)
  if (!result.ok) throw new Error('invalid stored runtime identity')
  return result.value
}
