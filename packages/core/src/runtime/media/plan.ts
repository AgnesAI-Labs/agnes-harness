import type { Outcome } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import { refuse } from './errors.js'
import {
  MEDIA_IMAGE_TO_TEXT_SCHEMA,
  MEDIA_NATIVE_SCHEMA,
  type MediaParameters,
  mediaSourceDigest,
  packParameters,
} from './identity.js'

const MEDIA = /^(image|audio|video)\//
const IMAGES = new Set(['image/png', 'image/jpeg'])
type BlobRef = Extract<W.PublicRef, { kind: 'blob' }>

export type PlanInput = Readonly<{
  view: W.ContextView
  target: W.ModelRouteSnapshot
  provider: W.BindingRef
  /** Everything except `nodes`, which the planner derives from the view. */
  parameters: Omit<MediaParameters, 'nodes'>
}>

/**
 * One plan per request and transform. Media is read only from user message items; anything else that
 * carries media, any non-image media kind, and a source that appears twice are refused by name.
 */
export function planMediaForView(input: PlanInput): Outcome<readonly W.MediaPlan[]> {
  const sources: W.PublicRef[] = []
  const nodes: number[] = []
  const seen = new Set<string>()
  let node = 0
  for (const item of input.view.items) {
    const media = item.sourceRefs.filter(
      (ref): ref is BlobRef => ref.kind === 'blob' && MEDIA.test(ref.value.mediaType),
    )
    if (media.length === 0) continue
    if (item.kind !== 'message' || item.trust !== 'user')
      return refuse('incompatible', 'media_anchor_unsupported')
    node += 1
    for (const ref of media) {
      if (!IMAGES.has(ref.value.mediaType)) return refuse('incompatible', 'media_kind_unsupported')
      const key = `${ref.value.blobId}:${ref.value.digest}`
      if (seen.has(key)) return refuse('incompatible', 'media_anchor_unsupported')
      seen.add(key)
      sources.push(ref)
      nodes.push(node)
    }
  }
  if (sources.length === 0) return { ok: true, value: [] }
  const native = input.target.features.input.includes('image')
  if (!native && !input.parameters.allowConversion) return refuse('incompatible', 'media_no_route')
  const digest = mediaSourceDigest(sources)
  if (!digest.ok) return digest
  const parameters = packParameters({ ...input.parameters, nodes })
  if (!parameters.ok) return parameters
  const transformSchema = native ? MEDIA_NATIVE_SCHEMA : MEDIA_IMAGE_TO_TEXT_SCHEMA
  const identity = canonicalJsonDigest({
    transformSchema,
    sourceDigest: digest.value,
    parameters: (parameters.value as { digest: string }).digest,
    provider: input.provider.bindingId,
  } as unknown as W.JsonValue)
  return {
    ok: true,
    value: [
      {
        key: `media:${identity.slice(0, 32)}`,
        sourceRefs: sources,
        sourceDigest: digest.value,
        transformSchema,
        parameters: parameters.value,
        targetFeatures: input.target.features,
        provider: input.provider,
      },
    ],
  }
}
