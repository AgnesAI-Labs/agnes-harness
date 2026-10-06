import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'

const digest = (value: unknown) => canonicalJsonDigest(value as W.JsonValue)

/**
 * The media plans the model service announced are exactly those the prepared handle commits to for the
 * selected target. The prepared body stays with the model service; only the handle header's plan digests
 * are compared, so a plan can be neither added nor swapped between preparation and inference.
 */
export function lockedMediaPlansMatch(
  handle: Pick<W.PreparedModelHandle, 'header'>,
  refs: readonly W.DataRef[],
  target: W.ModelRouteSnapshot,
): boolean {
  const digests = handle.header.mediaPlanDigests
  if (digests.length !== refs.length) return false
  return refs.every((ref, index) => {
    if (ref.kind !== 'inline' || ref.digest !== digests[index] || digest(ref.value) !== ref.digest)
      return false
    const plan = validateRuntime('MediaPlan', ref.value)
    return (
      plan.ok &&
      digest(plan.value.targetFeatures) === digest(target.features) &&
      plan.value.provider.contract === 'agh.media'
    )
  })
}
