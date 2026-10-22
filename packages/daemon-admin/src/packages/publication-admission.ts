import {
  type AuthoringCandidate,
  type PermissionEffectAdmission,
  permissionEffectAdmission,
  rpcError,
} from '@agnes/protocol'
import type { PackageAdminAuthority } from './permissions.js'

/** One candidate-bound backend lease follows every publication transaction and runtime activation. */
export function publicationAdmission(
  automatic: unknown,
  authority: PackageAdminAuthority,
  expected: string,
  candidate: () => AuthoringCandidate,
) {
  const bound = () => {
    const value = candidate(),
      context = authority.permissionContext
    if (
      !context ||
      value.candidateHash !== expected ||
      value.origin.sessionKey !== context.sessionKey ||
      authority.authoringOrigin?.sessionKey !== context.sessionKey
    )
      throw rpcError('CAPABILITY_DENIED', {
        reason: 'Candidate binding changed or belongs to a different session',
      })
    return context
  }
  const verifyPublication = async () => {
    if (!automatic) return
    const context = bound()
    await authority.authoringPermission!({ sessionKey: context.sessionKey, bindingHash: expected })
    authority.authoringSignal?.throwIfAborted()
  }
  const parent = authority.authoringAdmission
  const admission: PermissionEffectAdmission | undefined = automatic
    ? permissionEffectAdmission({
        parent,
        ...(authority.permissionContext
          ? { context: { expected: authority.permissionContext, current: () => authority.permissionContext } }
          : {}),
        signals: [authority.authoringSignal],
        unavailable: () => rpcError('CAPABILITY_DENIED'),
        verify: verifyPublication,
        assertBound: () => {
          if (!parent || authority.authoringAdmission !== parent) throw rpcError('CAPABILITY_DENIED')
          bound()
        },
      })
    : undefined
  return { verifyPublication, admission }
}

export const publicationMetadata = (value: AuthoringCandidate, reviewer: string) => ({
  candidateId: value.candidateId,
  candidateHash: value.candidateHash,
  baseHash: value.baseHash,
  reviewHash: value.reviewHash!,
  origin: value.origin,
  reviewer,
})
