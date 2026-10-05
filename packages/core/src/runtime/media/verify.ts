import type { Outcome } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'
import { refuse } from './errors.js'
import {
  MEDIA_BYTES_SCHEMA,
  MEDIA_DERIVED_TEXT_SCHEMA,
  MEDIA_IMAGE_TO_TEXT_SCHEMA,
  MEDIA_NATIVE_SCHEMA,
  type MediaManifest,
  parseManifest,
  parseParameters,
  unpack,
} from './identity.js'
import { framedVisionText } from './legacy-bridge.js'

const digest = (value: unknown) => canonicalJsonDigest(value as W.JsonValue)
const same = (a: unknown, b: unknown) => digest(a) === digest(b)
const fail = (part: string) => refuse('incompatible', `media_verify_${part}`)

export const DEGRADED_TEXT = 'vision_unavailable'

export type MediaEvidence = Readonly<{
  child: null | Readonly<{
    actionId: string
    receiptId: string
    bindingId: string
    inputDigest: W.Digest
    output: W.ModelOutput
    /** The text the caller extracted from `output.outputRef`. */
    text: string
  }>
}>
export type VerifiedPreparedMedia = Readonly<{
  planKey: string
  planDigest: W.Digest
  mediaDigest: W.Digest
  kind: MediaManifest['kind']
  manifest: MediaManifest
  media: W.PreparedMedia
  usageIds: readonly string[]
  trust: W.PreparedMedia['trust']
}>

const verified = new WeakSet<object>()
/** Process-local brand; after a restart the result is verified again from the child receipt. */
export const isVerifiedPreparedMedia = (value: unknown): value is VerifiedPreparedMedia =>
  typeof value === 'object' && value !== null && verified.has(value)

export function derivedTextOf(ref: W.DataRef | undefined): string | null {
  return derivedText(ref)?.text ?? null
}

function derivedText(ref: W.DataRef | undefined): { text: string; digest: W.Digest } | null {
  if (!ref || ref.kind !== 'inline') return null
  const body = unpack(ref, MEDIA_DERIVED_TEXT_SCHEMA)
  if (!body.ok || typeof body.value !== 'object' || body.value === null) return null
  const v = body.value as { kind?: unknown; text?: unknown }
  return v.kind === 'agh.media/derived-text@1' && typeof v.text === 'string'
    ? { text: v.text, digest: ref.digest }
    : null
}

export function verifyPreparedMedia(
  plan: W.MediaPlan,
  media: W.PreparedMedia,
  evidence: MediaEvidence,
): Outcome<VerifiedPreparedMedia> {
  if (!validateRuntime('PreparedMedia', media).ok) return fail('schema')
  if (!same(media.sourceRefs, plan.sourceRefs)) return fail('sources')
  if (!same(media.provenance.producer, plan.provider)) return fail('provenance')
  if (media.trust === 'system') return fail('trust')
  const first = media.contentRefs[0]
  if (!first) return fail('manifest')
  const parsed = parseManifest(first)
  if (!parsed.ok) return parsed
  const manifest = parsed.value
  const planDigest = digest(plan)
  if (manifest.planDigest !== planDigest) return fail('manifest')
  if (
    manifest.sources.length !== plan.sourceRefs.length ||
    manifest.header.manifest.length !== plan.sourceRefs.length
  )
    return fail('manifest')
  for (const [index, ref] of plan.sourceRefs.entries()) {
    const source = manifest.sources.find((s) => s.manifestIndex === index)
    if (
      ref.kind !== 'blob' ||
      !source ||
      source.blobId !== ref.value.blobId ||
      source.digest !== ref.value.digest
    )
      return fail('manifest')
  }
  const wantsImage = plan.targetFeatures.input.includes('image')

  if (manifest.kind === 'omitted') {
    if (manifest.header.selectionOrder.length !== 0 || manifest.header.route !== 'text-only')
      return fail('manifest')
    if (media.contentRefs.length !== 1 || media.transformChain.length !== 0 || media.usageRefs.length !== 0)
      return fail('chain')
  } else if (manifest.kind === 'native') {
    if (!same(plan.transformSchema, MEDIA_NATIVE_SCHEMA) || !wantsImage) return fail('features')
    if (media.usageRefs.length !== 0) return fail('usage')
    if (media.transformChain.length !== 0) return fail('chain')
    const selected = manifest.header.selectionOrder
    if (media.contentRefs.length !== 1 + selected.length) return fail('chain')
    for (const [i, index] of selected.entries()) {
      const ref = media.contentRefs[i + 1]
      const entry = manifest.header.manifest[index]
      if (
        !ref ||
        ref.kind !== 'blob' ||
        !same(ref.schema, MEDIA_BYTES_SCHEMA) ||
        !entry ||
        ref.blob.digest !== entry.sha256 ||
        !plan.sourceRefs.some((s) => s.kind === 'blob' && same(s.value, ref.blob))
      )
        return fail('chain')
    }
  } else if (manifest.kind === 'converted') {
    const conversion = manifest.conversion
    if (!same(plan.transformSchema, MEDIA_IMAGE_TO_TEXT_SCHEMA) || wantsImage || !conversion)
      return fail('features')
    if (media.trust !== 'derived') return fail('trust')
    const link = media.transformChain[0]
    if (
      media.transformChain.length !== 1 ||
      !link ||
      !same(link.transformSchema, plan.transformSchema) ||
      link.inputDigest !== plan.sourceDigest ||
      link.actionId !== conversion.childActionId
    )
      return fail('chain')
    const derived = media.contentRefs.length === 2 ? derivedText(media.contentRefs[1]) : null
    if (!derived || link.outputDigest !== derived.digest) return fail('chain')
    const child = evidence.child
    if (
      !child ||
      child.actionId !== conversion.childActionId ||
      child.receiptId !== conversion.childReceiptId ||
      child.bindingId !== conversion.modelBinding.bindingId ||
      child.inputDigest !== conversion.inferInputDigest ||
      derived.text !== framedVisionText(child.text)
    )
      return fail('receipt')
    if (!same(media.usageRefs, child.output.usageFactRefs)) return fail('usage')
  } else {
    const parameters = parseParameters(plan.parameters, plan.sourceRefs.length)
    if (!parameters.ok || parameters.value.failurePolicy !== 'degrade') return fail('manifest')
    if (media.trust !== 'derived') return fail('trust')
    if (media.transformChain.length !== 0 || media.usageRefs.length !== 0) return fail('chain')
    const derived = media.contentRefs.length === 2 ? derivedText(media.contentRefs[1]) : null
    if (!derived || derived.text !== framedVisionText(DEGRADED_TEXT)) return fail('chain')
  }

  const result: VerifiedPreparedMedia = Object.freeze({
    planKey: plan.key,
    planDigest,
    mediaDigest: digest(media),
    kind: manifest.kind,
    manifest,
    media,
    usageIds: media.usageRefs.map((ref) => ref.usageId),
    trust: media.trust,
  })
  verified.add(result)
  return { ok: true, value: result }
}
