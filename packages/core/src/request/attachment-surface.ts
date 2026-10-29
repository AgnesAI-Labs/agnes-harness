import type { SurfaceNode } from '@agnes/core-ledger/project/surface'
import { AttachmentError, type ContentBlock, IncrementalSha256, storedAttachment } from '@agnes/protocol'
import {
  decodeSafeImageBytes,
  USER_IMAGE_ORIGINAL_LIMITS,
  USER_MESSAGE_IMAGE_LIMITS,
} from '@agnes/protocol-validation'
import { resolveModel } from '../step/inference.js'
import { resolvedModelRecord } from '../step/model-tools.js'
import type { SessionImpl } from '../step/session.js'
import { attachmentImagePolicy } from './attachment-image-policy.js'
import { attachmentIndex } from './attachment-index.js'
import { attachmentOperation } from './attachment-operation.js'
import { readSessionAttachment } from './session-files.js'

const omitted = new WeakMap<SessionImpl, number>()
export const attachmentOmittedThrough = (session: SessionImpl) => omitted.get(session) ?? 0

/** Original references stay immutable. Only transient provider input receives selected renditions.
 * Omission removes an oldest whole-message prefix, in half-window steps where possible. Its watermark
 * travels with request/header, so a model change, cache eviction or restart cannot revive old pixels.
 */
export async function attachmentSurface(
  session: SessionImpl,
  surface: readonly SurfaceNode[],
): Promise<{ surface: SurfaceNode[]; imageIndices: ReadonlyMap<number, readonly number[]> }> {
  const imageIndices = new Map<number, number[]>()
  if (
    !surface.some(
      (node) =>
        node.kind === 'user' &&
        (node.event.data as { content?: ContentBlock[] }).content?.some(storedAttachment),
    )
  )
    return { surface: [...surface], imageIndices }
  const indexed = await attachmentIndex(session)
  let cut = Math.max(indexed.omittedThrough, attachmentOmittedThrough(session))
  const target = resolveModel(session, 'primary')
  const model = resolvedModelRecord(session.d.provider, target)
  const limits = model?.inputLimits?.images
  const cap = model?.input.includes('image') ? (limits?.maxPerRequest ?? 8) : 0
  const perMessage = limits?.maxPerMessage ?? 50
  const nodes = surface.filter(
    (node) =>
      node.kind === 'user' &&
      (node.event.data as { content?: ContentBlock[] }).content?.some(
        (b) => storedAttachment(b) && b.attachment.image,
      ),
  )
  const freshStart = session.state.openTurn.get(session.lane)?.startSeq ?? nodes.at(-1)?.seq ?? Infinity
  const counts = (node: SurfaceNode) =>
    ((node.event.data as { content?: ContentBlock[] }).content ?? []).filter(
      (b) => storedAttachment(b) && b.attachment.image,
    ).length
  const fresh = nodes.filter((n) => n.seq >= freshStart)
  if (fresh.some((n) => counts(n) > perMessage) || fresh.reduce((n, row) => n + counts(row), 0) > cap)
    throw new AttachmentError('ATTACHMENT_COUNT')
  const candidates = nodes.filter((n) => n.seq > cut || n.seq >= freshStart)
  let count = candidates.reduce((n, row) => n + counts(row), 0)
  const step = Math.max(1, Math.ceil(cap / 2))
  const roundedCap = Math.max(0, cap - Math.max(0, Math.ceil((count - cap) / step) * step - (count - cap)))
  let prefixCount = 0
  for (const node of candidates) {
    if (node.seq >= freshStart) continue
    prefixCount += counts(node)
    if (count > roundedCap || counts(node) > perMessage) {
      cut = node.seq
      count -= prefixCount
      prefixCount = 0
    }
  }
  let bytesUsed = 0,
    pixelsUsed = 0
  const hydrated = new Map<SurfaceNode, ContentBlock[]>()
  // Newest first reserves the budget for the current turn before historical data.
  for (const node of [...nodes].reverse()) {
    const current = node.seq >= freshStart
    if (node.seq <= cut && !current) continue
    const content: ContentBlock[] = []
    const indices: number[] = []
    let index = 0,
      nodeBytes = 0,
      nodePixels = 0
    for (const block of (node.event.data as { content?: ContentBlock[] }).content ?? []) {
      if (block.type === 'image') {
        index++
        indices.push(index)
      }
      if (!storedAttachment(block) || !block.attachment.image) {
        content.push(block)
        continue
      }
      index++
      try {
        const original = await readSessionAttachment(
          session,
          {
            path: `session-image://${node.seq}/${index}`,
            maxBytes: USER_IMAGE_ORIGINAL_LIMITS.maxBytesPerImage,
          },
          session.ac.signal,
        )
        if (
          !original ||
          original.bytes.length !== block.attachment.artifact.size ||
          original.mimeType !== block.mimeType ||
          new IncrementalSha256().update(original.bytes).digest() !== block.attachment.artifact.sha256
        )
          throw new AttachmentError('ATTACHMENT_NOT_AUTHORIZED')
        const checked = decodeSafeImageBytes(
          { bytes: original.bytes, mimeType: block.mimeType },
          USER_IMAGE_ORIGINAL_LIMITS,
        )
        if (
          checked.width !== block.attachment.image.width ||
          checked.height !== block.attachment.image.height
        )
          throw new AttachmentError('ATTACHMENT_DATA')
        let bytes = original.bytes
        const store = session.d.runtime.attachmentStore()
        if (store?.imageVersion) {
          const version = await attachmentOperation(
            store.imageVersion(
              { sessionKey: session.key, lane: session.lane },
              block.attachment.artifact,
              attachmentImagePolicy(session),
              session.ac.signal,
            ),
            session.ac.signal,
          )
          bytes = await attachmentOperation(
            session.d.runtime.artifactGet(version.artifact),
            session.ac.signal,
          )
          if (
            version.artifact.mime !== block.mimeType ||
            bytes.length !== version.artifact.size ||
            new IncrementalSha256().update(bytes).digest() !== version.artifact.sha256
          )
            throw new AttachmentError('ATTACHMENT_HASH_MISMATCH')
        }
        const image = decodeSafeImageBytes({ bytes, mimeType: block.mimeType }, USER_MESSAGE_IMAGE_LIMITS)
        nodeBytes += bytes.length
        nodePixels += image.pixels
        content.push({ type: 'image', data: encodeBase64(bytes), mimeType: image.mime })
        indices.push(index)
      } catch (error) {
        session.ac.signal.throwIfAborted()
        // Corrupt bytes or authority failures stay fatal. Only absent historical originals degrade.
        if (
          current ||
          !(error instanceof AttachmentError) ||
          !['ATTACHMENT_MISSING', 'ATTACHMENT_UNAVAILABLE'].includes(error.code)
        )
          throw error
        content.push({
          type: 'text',
          text: `[image session-image://${node.seq}/${index}; original missing. Do not infer unseen details.]`,
        })
      }
    }
    if (
      bytesUsed + nodeBytes > USER_MESSAGE_IMAGE_LIMITS.maxAggregateBytes ||
      pixelsUsed + nodePixels > USER_MESSAGE_IMAGE_LIMITS.maxAggregatePixels
    ) {
      if (current) throw new AttachmentError('ATTACHMENT_BYTES')
      cut = Math.max(cut, node.seq)
    } else {
      bytesUsed += nodeBytes
      pixelsUsed += nodePixels
      hydrated.set(node, content)
      imageIndices.set(node.seq, indices)
    }
  }
  omitted.set(session, cut)
  const projected = surface.map((node) => {
    if (node.kind !== 'user') return node
    const data = node.event.data as { content?: ContentBlock[] }
    let index = 0
    const content = node.seq > cut || node.seq >= freshStart ? hydrated.get(node) : undefined
    return {
      ...node,
      event: {
        ...node.event,
        data: {
          ...data,
          content:
            content ??
            (data.content ?? []).map((block) => {
              if (block.type === 'image') index++
              if (!storedAttachment(block) || !block.attachment.image) return block
              index++
              return {
                type: 'text',
                text: `[image session-image://${node.seq}/${index}; original not included. Use read to inspect the original. Do not infer unseen details.]`,
              }
            }),
        },
      },
    }
  })
  for (const seq of imageIndices.keys()) if (seq <= cut && seq < freshStart) imageIndices.delete(seq)
  return { surface: projected, imageIndices }
}
function encodeBase64(bytes: Uint8Array): string {
  const parts: string[] = []
  for (let at = 0; at < bytes.length; at += 16384)
    parts.push(String.fromCharCode(...bytes.subarray(at, at + 16384)))
  return btoa(parts.join(''))
}
