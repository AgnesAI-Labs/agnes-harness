/** Narrowing of the owner-level SDK client that the bundled-app grant carries as `unknown`. */
import type { createClient } from '@agnes/sdk'

export type SdkClient = ReturnType<typeof createClient>

/**
 * The grant's client, typed. The Host builds it with its own copy of the SDK, so an `instanceof` check against this
 * bundle's copy would fail: the shape is checked instead.
 * @throws TypeError when the value is not an SDK client.
 */
export function asSdkClient(value: unknown): SdkClient {
  const candidate = value as Partial<Record<'initialize' | 'close' | 'clientId', unknown>> & {
    session?: unknown
  }
  if (
    !value ||
    typeof value !== 'object' ||
    typeof candidate.initialize !== 'function' ||
    typeof candidate.close !== 'function' ||
    typeof candidate.clientId !== 'function' ||
    !candidate.session ||
    typeof candidate.session !== 'object'
  )
    throw new TypeError('The bundled-app grant does not carry an SDK client')
  return value as SdkClient
}
