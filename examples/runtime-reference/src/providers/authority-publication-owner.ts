import type { AuthorityTransferControl, CallContext, Outcome } from '@agnes/extension-api/runtime'
import type {
  AuthorityFence,
  AuthorityPublication,
  AuthorityRoute,
  DataRef,
  StateAuthorityRef,
} from '@agnes/protocol/runtime'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'

export interface ReferenceSourceEvidence {
  readonly upgradeId: string
  readonly validationRef: DataRef
  readonly sources: readonly {
    readonly previous: AuthorityRoute
    readonly expectedRevision: number
    readonly fence: AuthorityFence
  }[]
}
/** Private deployment projection of a locked plan and its original validation reader. */
export interface ReferenceSourcePlan {
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
  verify(evidence: ReferenceSourceEvidence, context: CallContext): Promise<Outcome<boolean>>
}
export type ReferencePlanResolver = (
  upgradeId: string,
  context: CallContext,
) => Promise<Outcome<ReferenceSourcePlan>>

const equivalent = (a: unknown, b: unknown) =>
  canonicalJsonDigest(JSON.parse(JSON.stringify(a))) === canonicalJsonDigest(JSON.parse(JSON.stringify(b)))

export async function confirmSourcePlan(
  input: AuthorityPublication,
  reader: ReferencePlanResolver | undefined,
  call: CallContext,
): Promise<Outcome<ReferenceSourceEvidence>> {
  const stop = (detailCode: string): Outcome<ReferenceSourceEvidence> => ({
    ok: false,
    error: {
      code: 'incompatible',
      detailCode,
      message: 'Reference directory rejected source evidence',
      diagnosticId: 'authority-directory',
      retryAdvice: { kind: 'never' },
    },
  })
  if (reader === undefined) return stop('source_owner_unavailable')
  try {
    const opened = await reader(input.upgradeId, call)
    if (!opened.ok) return stop('source_owner_unavailable')
    const frozen = opened.value
    if (frozen.upgradeId !== input.upgradeId || !equivalent(frozen.validationRef, input.validationRef))
      return stop('source_validation_mismatch')
    if (frozen.sources.length !== input.changes.length) return stop('source_plan_mismatch')
    const evidence: ReferenceSourceEvidence = {
      upgradeId: input.upgradeId,
      validationRef: input.validationRef,
      sources: input.changes.map(({ previous, expectedRevision }) => {
        const fence = input.sourceFences.find(
          ({ source }) =>
            source.authorityId === previous.logicalAuthorityId &&
            source.tenantId === previous.tenantId &&
            source.authorityEpoch === previous.authorityEpoch,
        )
        if (!fence) throw new Error('source fence absent')
        return { previous, expectedRevision, fence }
      }),
    }
    for (const item of evidence.sources) {
      const origin = frozen.sources.find(
        ({ previous }) => previous.logicalAuthorityId === item.previous.logicalAuthorityId,
      )
      if (
        !origin ||
        !item.fence ||
        item.expectedRevision !== origin.expectedRevision ||
        !equivalent(item.previous, origin.previous)
      )
        return stop('source_plan_mismatch')
      const bound = origin.owner
      if (
        bound.locationRef !== item.previous.locationRef ||
        !equivalent(bound.binding, item.previous.providerBinding) ||
        !equivalent(bound.authority, item.fence.source)
      )
        return stop('source_owner_mismatch')
      if (!equivalent(item.fence, origin.fence)) return stop('fence_not_registered')
      const state = await bound.transfer.probe({ upgradeId: frozen.upgradeId }, call)
      if (
        !state.ok ||
        !validateRuntime('AuthorityTransferProbe', state.value).ok ||
        state.value.state !== 'fenced'
      )
        return stop('source_fence_unconfirmed')
      if (!state.value.fence.writerCredentialsRevoked || !equivalent(state.value.fence, item.fence))
        return stop('source_fence_unconfirmed')
    }
    const accepted = await frozen.verify(JSON.parse(JSON.stringify(evidence)), call)
    if (!accepted.ok || accepted.value !== true) return stop('source_validation_mismatch')
    return { ok: true, value: evidence }
  } catch {
    return stop('source_owner_unavailable')
  }
}
