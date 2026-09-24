import { rpcError } from '@agnes/protocol'

const profilePattern = /^[a-z][a-z0-9._-]{0,127}$/

/**
 * Explicit capability boundary for a resource-control storage instance. A production daemon owns
 * one profile; multi-profile stores are test-only fixtures and must name every permitted profile.
 */
export type ResourceProfileScope = Readonly<{ allowedProfiles: readonly string[] }>

export function assertResourceProfile(scope: ResourceProfileScope, profile: string): void {
  if (!profilePattern.test(profile) || !scope.allowedProfiles.includes(profile))
    throw rpcError('CAPABILITY_DENIED', { code: 'PROFILE_SCOPE' })
}
