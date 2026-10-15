import type { SurfaceNode } from '@agnes/core-ledger/project/surface'
import { type ContentBlock, IncrementalSha256, storedAttachment } from '@agnes/protocol'
import { decodeSafeImageBytes, USER_MESSAGE_IMAGE_LIMITS } from '@agnes/protocol-validation'
import type { SessionImpl } from '../step/session.js'
import { readSessionAttachment } from './session-files.js'

/** Only transient provider input receives selected image bytes. Ledger originals stay references. */
export async function attachmentSurface(
  session: SessionImpl,
  surface: readonly SurfaceNode[],
): Promise<SurfaceNode[]> {
  const imageNodes = surface.filter(
    (node) =>
      node.kind === 'user' &&
      (node.event.data as { content?: ContentBlock[] }).content?.some(
        (block) => storedAttachment(block) && block.attachment.image,
      ),
  )
  const selected = new Set<SurfaceNode>()
  let budget = USER_MESSAGE_IMAGE_LIMITS.maxAggregateBytes
  for (const node of imageNodes.slice(-3).reverse()) {
    const size = ((node.event.data as { content?: ContentBlock[] }).content ?? []).reduce(
      (n, block) =>
        n + (storedAttachment(block) && block.attachment.image ? block.attachment.artifact.size : 0),
      0,
    )
    if (size <= budget) {
      selected.add(node)
      budget -= size
    }
  }
  const output: SurfaceNode[] = []
  for (const node of surface) {
    if (node.kind !== 'user') {
      output.push(node)
      continue
    }
    const data = node.event.data as { content?: ContentBlock[] }
    const include = selected.has(node)
    let imageIndex = 0
    const content: ContentBlock[] = []
    for (const block of data.content ?? []) {
      if (block.type === 'image') imageIndex++
      if (!storedAttachment(block) || !block.attachment.image) {
        content.push(block)
        continue
      }
      imageIndex++
      if (!include) {
        content.push({
          type: 'text',
          text: `[image session-image://${node.seq}/${imageIndex}; original not included. Use read to inspect the original. Do not infer unseen details.]`,
        })
        continue
      }
      session.ac.signal.throwIfAborted()
      const original = await readSessionAttachment(
        session,
        {
          path: `session-image://${node.seq}/${imageIndex}`,
          maxBytes: USER_MESSAGE_IMAGE_LIMITS.maxBytesPerImage,
        },
        session.ac.signal,
      )
      if (
        !original ||
        new IncrementalSha256().update(original.bytes).digest() !== block.attachment.artifact.sha256
      )
        throw new Error('ATTACHMENT_NOT_AUTHORIZED')
      const bytes = original.bytes
      const image = decodeSafeImageBytes({ bytes, mimeType: block.mimeType }, USER_MESSAGE_IMAGE_LIMITS)
      if (image.width !== block.attachment.image.width || image.height !== block.attachment.image.height)
        throw new Error('ATTACHMENT_DATA')
      content.push({ type: 'image', data: encodeBase64(bytes), mimeType: image.mime })
    }
    output.push({ ...node, event: { ...node.event, data: { ...data, content } } })
  }
  return output
}

function encodeBase64(bytes: Uint8Array): string {
  const parts: string[] = []
  for (let at = 0; at < bytes.length; at += 16384)
    parts.push(String.fromCharCode(...bytes.subarray(at, at + 16384)))
  return btoa(parts.join(''))
}
