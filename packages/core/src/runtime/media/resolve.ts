import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import type { RequestMediaLimits } from '../../orchestrator/request-media.js'
import { sha256Hex } from '../../request/hash.js'
import { refuse } from './errors.js'
import { mediaHash, type RestoreSource, restore } from './legacy-bridge.js'
import type { VerifiedPreparedMedia } from './verify.js'
import { derivedTextOf } from './verify.js'

export type ResolvedMediaPart = Readonly<
  | { kind: 'text'; text: string; anchor: string }
  | { kind: 'image'; data: string; mimeType: string; sha256: string; anchor: string }
>
export type ResolvedMedia = Readonly<{
  planKey: string
  planDigest: W.Digest
  mediaDigest: W.Digest
  trust: W.PreparedMedia['trust']
  usageIds: readonly string[]
  parts: readonly ResolvedMediaPart[]
}>
/** Reads bytes under the caller's current authority; a refusal propagates unchanged. */
export interface MediaByteReader {
  read(blob: W.BlobRef, context: CallContext): Promise<Outcome<Uint8Array>>
}

export async function resolveMediaParts(
  verified: VerifiedPreparedMedia,
  reader: MediaByteReader,
  limits: RequestMediaLimits,
  context: CallContext,
): Promise<Outcome<ResolvedMedia>> {
  const { manifest, media } = verified
  const base = {
    planKey: verified.planKey,
    planDigest: verified.planDigest,
    mediaDigest: verified.mediaDigest,
    trust: verified.trust,
    usageIds: verified.usageIds,
  }
  if (manifest.kind === 'omitted') return { ok: true, value: { ...base, parts: [] } }
  if (manifest.kind !== 'native') {
    const text = derivedTextOf(media.contentRefs[1])
    const anchor =
      manifest.kind === 'converted' ? manifest.conversion?.anchor : manifest.sources.at(-1)?.blobId
    if (text === null || anchor === undefined) return refuse('incompatible', 'media_verify_chain')
    return { ok: true, value: { ...base, parts: [{ kind: 'text', text, anchor }] } }
  }
  const reads: RestoreSource[] = []
  const blobIds = new Map<number, string>()
  for (const [i, manifestIndex] of manifest.header.selectionOrder.entries()) {
    const ref = media.contentRefs[i + 1]
    const source = manifest.sources.find((s) => s.manifestIndex === manifestIndex)
    if (ref?.kind !== 'blob' || !source) return refuse('incompatible', 'media_verify_chain')
    const bytes = await reader.read(ref.blob, context)
    if (!bytes.ok) return bytes
    reads.push({
      manifestIndex,
      blockIndex: source.blockIndex,
      bytes: bytes.value,
      sourceTool: source.sourceTool,
    })
    blobIds.set(manifestIndex, source.blobId)
  }
  const restored = restore(manifest.header, reads, limits)
  if (!restored.ok) return restored
  if (mediaHash(restored.value) !== manifest.mediaHash) return refuse('conflict', 'media_source_drift')
  const parts: ResolvedMediaPart[] = []
  for (const image of restored.value.selected) {
    const anchor = blobIds.get(image.manifestIndex)
    if (anchor === undefined) return refuse('conflict', 'media_continuation_conflict')
    if (verified.trust !== 'user') parts.push({ kind: 'text', text: image.untrustedLabel, anchor })
    parts.push({
      kind: 'image',
      data: image.data,
      mimeType: image.mimeType,
      sha256: image.artifactUri.slice('artifact://'.length),
      anchor,
    })
  }
  return { ok: true, value: { ...base, parts } }
}

export function toModelWireMedia(resolved: ResolvedMedia) {
  return {
    planKey: resolved.planKey,
    planDigest: resolved.planDigest,
    usageIds: resolved.usageIds,
    parts: resolved.parts.map((part) => ({
      kind: part.kind,
      sha256: part.kind === 'image' ? part.sha256 : sha256Hex(part.text),
    })),
  }
}
