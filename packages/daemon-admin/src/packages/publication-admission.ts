import { type AuthoringCandidate, type PermissionEffectAdmission, rpcError } from '@agnes/protocol'
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
  const admission: PermissionEffectAdmission | undefined = automatic
    ? Object.freeze({
        verify: async () => {
          if (!authority.authoringAdmission) throw rpcError('CAPABILITY_DENIED')
          await verifyPublication()
          await authority.authoringAdmission.verify()
        },
        assertActive: () => {
          if (!authority.authoringAdmission) throw rpcError('CAPABILITY_DENIED')
          authority.authoringAdmission.assertActive()
          authority.authoringSignal?.throwIfAborted()
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
