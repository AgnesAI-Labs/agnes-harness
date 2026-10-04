import type { AuthorityTransferControl, CallContext, Outcome } from '@agnes/extension-api/runtime'
import type {
  AuthorityFence,
  AuthorityPublication,
  AuthorityRoute,
  DataRef,
  StateAuthorityRef,
} from '@agnes/protocol/runtime'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'

/** Deployment-owned capabilities, resolved from the locked plan, never from a publication DTO. */
export interface PublicationSourcePlan {
  readonly upgradeId: string
  readonly validationRef: DataRef
  readonly sources: readonly {
    readonly previous: AuthorityRoute
    readonly expectedRevision: number
    readonly fence: AuthorityFence
    readonly owner: {
      readonly authority: StateAuthorityRef
      readonly binding: AuthorityRoute['providerBinding']
      readonly locationRef: string
      readonly transfer: Pick<AuthorityTransferControl, 'probe'>
    }
  }[]
  /** Read the original accepted validation and check its complete source evidence. */
  verify(evidence: PublicationSourceEvidence, context: CallContext): Promise<Outcome<boolean>>
}

export interface PublicationSourceEvidence {
  readonly upgradeId: string
  readonly validationRef: DataRef
  readonly sources: readonly {
    readonly previous: AuthorityRoute
    readonly expectedRevision: number
    readonly fence: AuthorityFence
  }[]
}
export type PublicationPlanResolver = (
  upgradeId: string,
  context: CallContext,
) => Promise<Outcome<PublicationSourcePlan>>

function digest(value: unknown): string {
  return canonicalJsonDigest(JSON.parse(JSON.stringify(value)))
}

export async function verifyPublicationSource(
  publication: AuthorityPublication,
  resolve: PublicationPlanResolver | undefined,
  context: CallContext,
): Promise<Outcome<PublicationSourceEvidence>> {
  const reject = (detailCode: string): Outcome<PublicationSourceEvidence> => ({
    ok: false,
    error: {
      code: 'incompatible',
      detailCode,
      message: 'Authority directory refused source evidence',
      retryAdvice: { kind: 'never' },
      diagnosticId: 'authority-directory',
    },
  })
  if (!resolve) return reject('source_owner_unavailable')
  try {
    const resolved = await resolve(publication.upgradeId, context)
    if (!resolved.ok) return reject('source_owner_unavailable')
    const plan = resolved.value
    if (
      plan.upgradeId !== publication.upgradeId ||
      digest(plan.validationRef) !== digest(publication.validationRef)
    )
      return reject('source_validation_mismatch')
    if (plan.sources.length !== publication.changes.length) return reject('source_plan_mismatch')
    const sources: PublicationSourceEvidence['sources'][number][] = []
    for (const change of publication.changes) {
      const locked = plan.sources.find(
        (source) => source.previous.logicalAuthorityId === change.previous.logicalAuthorityId,
      )
      const fence = publication.sourceFences.find(
        (receipt) =>
          receipt.source.authorityId === change.previous.logicalAuthorityId &&
          receipt.source.tenantId === change.previous.tenantId &&
          receipt.source.authorityEpoch === change.previous.authorityEpoch,
      )
      if (
        !locked ||
        !fence ||
        locked.expectedRevision !== change.expectedRevision ||
        digest(locked.previous) !== digest(change.previous)
      )
        return reject('source_plan_mismatch')
      const owner = locked.owner
      if (
        digest(owner.authority) !== digest(fence.source) ||
        digest(owner.binding) !== digest(change.previous.providerBinding) ||
        owner.locationRef !== change.previous.locationRef
      )
        return reject('source_owner_mismatch')
      if (digest(locked.fence) !== digest(fence)) return reject('fence_not_registered')
      const probed = await owner.transfer.probe({ upgradeId: publication.upgradeId }, context)
      if (
        !probed.ok ||
        !validateRuntime('AuthorityTransferProbe', probed.value).ok ||
        probed.value.state !== 'fenced' ||
        !probed.value.fence.writerCredentialsRevoked ||
        digest(probed.value.fence) !== digest(fence)
      )
        return reject('source_fence_unconfirmed')
      sources.push({ previous: change.previous, expectedRevision: change.expectedRevision, fence })
    }
    const evidence: PublicationSourceEvidence = {
      upgradeId: publication.upgradeId,
      validationRef: publication.validationRef,
      sources,
    }
    const verified = await plan.verify(JSON.parse(JSON.stringify(evidence)), context)
    return verified.ok && verified.value === true
      ? { ok: true, value: evidence }
      : reject('source_validation_mismatch')
  } catch {
    return reject('source_owner_unavailable')
  }
}
