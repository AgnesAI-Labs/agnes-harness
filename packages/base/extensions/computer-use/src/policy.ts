import type { SessionRef } from '@agnes/extension-api'

/**
 * Host-authored launch policy for one session-owned driver runtime.
 *
 * This is deliberately not part of the model schema. The only production construction path is the
 * Host-owned backend provider; Base merely refuses to dispatch when that path did not bind an
 * explicit, session-scoped mode. In particular, absence never falls back to unrestricted (or even
 * standard), and unrestricted cannot be represented without its trusted approval-bypass source.
 */
export type ComputerUseRuntimePolicy =
  | Readonly<{
      mode: 'standard'
      authorization: 'driver-standard'
      sessionKey: string
      lane: string
    }>
  | Readonly<{
      mode: 'bounded'
      authorization: 'reviewed-manifest'
      sessionKey: string
      lane: string
      capabilityManifestDigest: string
    }>
  | Readonly<{
      mode: 'unrestricted'
      authorization: 'session-yolo' | 'trusted-profile-off'
      sessionKey: string
      lane: string
    }>

export type ValidatedComputerUseRuntimePolicy = Readonly<{
  policy: ComputerUseRuntimePolicy
  /** Stable identity used to prove that one transport generation did not change mode in place. */
  identity: string
}>

export type ComputerUseRuntimePolicyFailure = Readonly<{
  code: 'runtime_policy_untrusted'
  message: string
}>

const SHA256 = /^[0-9a-f]{64}$/
const COMMON_FIELDS = new Set(['mode', 'authorization', 'sessionKey', 'lane'])
const BOUNDED_FIELDS = new Set([...COMMON_FIELDS, 'capabilityManifestDigest'])

function plainData(
  value: unknown,
  fields: ReadonlySet<string>,
): Readonly<Record<string, unknown>> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return undefined
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const ownKeys = Reflect.ownKeys(descriptors)
  if (
    ownKeys.length !== fields.size ||
    !ownKeys.every((key): key is string => typeof key === 'string' && fields.has(key))
  )
    return undefined
  const snapshot: Record<string, unknown> = Object.create(null)
  for (const key of ownKeys) {
    const descriptor = descriptors[key]
    if (!descriptor?.enumerable || !('value' in descriptor)) return undefined
    snapshot[key] = descriptor.value
  }
  return Object.freeze(snapshot)
}

function failure(message: string): ComputerUseRuntimePolicyFailure {
  return Object.freeze({ code: 'runtime_policy_untrusted', message })
}

function identity(policy: ComputerUseRuntimePolicy): string {
  return JSON.stringify([
    policy.mode,
    policy.authorization,
    policy.sessionKey,
    policy.lane,
    policy.mode === 'bounded' ? policy.capabilityManifestDigest : null,
  ])
}

/**
 * Validate and detach the Host mode before any backend call.
 *
 * A bounded manifest remains enforced by the reviewed private driver runtime. Base binds its digest
 * here so a manifest or mode swap cannot occur inside one generation; it does not invent a second,
 * potentially divergent manifest language.
 */
export function validateComputerUseRuntimePolicy(
  value: unknown,
  session: SessionRef,
): ValidatedComputerUseRuntimePolicy | ComputerUseRuntimePolicyFailure {
  try {
    const modeHint = plainData(value, BOUNDED_FIELDS)?.mode ?? plainData(value, COMMON_FIELDS)?.mode
    const fields = modeHint === 'bounded' ? BOUNDED_FIELDS : COMMON_FIELDS
    const data = plainData(value, fields)
    if (!data) return failure('Computer Use requires an explicit plain Host-authored runtime policy.')
    if (data.sessionKey !== session.key || data.lane !== session.lane)
      return failure('Computer Use runtime policy belongs to a different session or lane.')

    let policy: ComputerUseRuntimePolicy
    if (data.mode === 'standard') {
      if (data.authorization !== 'driver-standard')
        return failure('Standard Computer Use requires the driver-standard Host mode.')
      policy = Object.freeze({
        mode: 'standard',
        authorization: 'driver-standard',
        sessionKey: session.key,
        lane: session.lane,
      })
    } else if (data.mode === 'bounded') {
      if (
        data.authorization !== 'reviewed-manifest' ||
        typeof data.capabilityManifestDigest !== 'string' ||
        !SHA256.test(data.capabilityManifestDigest)
      )
        return failure('Bounded Computer Use requires one reviewed capability manifest digest.')
      policy = Object.freeze({
        mode: 'bounded',
        authorization: 'reviewed-manifest',
        sessionKey: session.key,
        lane: session.lane,
        capabilityManifestDigest: data.capabilityManifestDigest,
      })
    } else if (data.mode === 'unrestricted') {
      if (data.authorization !== 'session-yolo' && data.authorization !== 'trusted-profile-off')
        return failure('Unrestricted Computer Use requires an explicit trusted approval bypass.')
      policy = Object.freeze({
        mode: 'unrestricted',
        authorization: data.authorization,
        sessionKey: session.key,
        lane: session.lane,
      })
    } else {
      return failure('Computer Use runtime permission mode is missing or unsupported.')
    }

    return Object.freeze({ policy, identity: identity(policy) })
  } catch {
    return failure('Computer Use runtime policy could not be safely inspected.')
  }
}
