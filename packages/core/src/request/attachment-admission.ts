import { CoreError } from '@agnes/core-common/types'
import { scanPages } from '@agnes/core-ledger/log/scan-pages'
import type { AttachmentReceipt } from '@agnes/extension-api'
import {
  type ArtifactRef,
  attachmentLink,
  type ContentBlock,
  IncrementalSha256,
  modelImageInputError,
  type StoredAttachment,
  storedAttachment,
} from '@agnes/protocol'
import {
  AttachmentError,
  decodeAttachmentData,
  decodeSafeImageBytes,
  SafeImageError,
  USER_MESSAGE_ATTACHMENT_LIMITS,
  USER_MESSAGE_IMAGE_LIMITS,
  validateStoredAttachment,
} from '@agnes/protocol-validation'
import { resolveModel } from '../step/inference.js'
import type { SessionImpl } from '../step/session.js'
import { attachmentOperation } from './attachment-operation.js'
import { validateWorkspaceUploads } from './upload-admission.js'

const identity = (ref: ArtifactRef) => JSON.stringify([ref.sha256, ref.size, ref.mime])
const MAX_SESSION_BYTES = 2 * 1024 * 1024 * 1024

/** Scan the owning log rather than a client index: fork prefixes and queued input count too. */
export async function visibleAttachmentRefs(session: SessionImpl): Promise<Map<string, ArtifactRef>> {
  const refs = new Map<string, ArtifactRef>()
  const content = (blocks: ContentBlock[]) => {
    for (const block of blocks)
      if (storedAttachment(block)) {
        validateStoredAttachment(block)
        refs.set(identity(block.attachment.artifact), block.attachment.artifact)
        if (block.attachment.thumbnail)
          refs.set(identity(block.attachment.thumbnail), block.attachment.thumbnail)
      }
  }
  for await (const page of scanPages(
    (query) => session.d.log.scan(query),
    { type: 'user/message', lane: session.lane, toSeq: session.lastSeq },
    100,
  )) {
    for (const row of page) {
      const data = row.data as { content?: ContentBlock[]; items?: { content: ContentBlock[] }[] }
      content(data.content ?? [])
    }
  }
  const inbox = session.latest('inbox') as { items?: { content: ContentBlock[] }[] } | undefined
  for (const item of inbox?.items ?? []) content(item.content)
  return refs
}

export function attachmentFailure(error: unknown, signal?: AbortSignal): CoreError {
  const code = signal?.aborted
    ? signal.reason?.name === 'TimeoutError'
      ? 'ATTACHMENT_TIMEOUT'
      : 'ATTACHMENT_CANCELLED'
    : error instanceof AttachmentError
      ? error.code
      : error instanceof SafeImageError
        ? ((
            {
              BYTE_LIMIT: 'ATTACHMENT_BYTES',
              PIXEL_LIMIT: 'ATTACHMENT_PIXELS',
              MIME_MISMATCH: 'ATTACHMENT_MIME',
            } as const
          )[error.code as 'BYTE_LIMIT' | 'PIXEL_LIMIT' | 'MIME_MISMATCH'] ?? 'ATTACHMENT_DATA')
        : 'ATTACHMENT_UNAVAILABLE'
  return new CoreError('E_ENVELOPE', code, { code })
}

/** No ledger writes here. Confirm only after the caller's atomic inbox append succeeds. */
export async function admitSessionAttachments(
  session: SessionImpl,
  input: ContentBlock[],
  signal: AbortSignal = AbortSignal.timeout(30_000),
) {
  const store = session.d.runtime.attachmentStore()
  try {
    await validateWorkspaceUploads(session, input, signal)
  } catch (error) {
    throw attachmentFailure(error, signal)
  }
  const noop = { content: input, confirm: async () => {}, discard: async () => {} }
  if (
    !input.some(
      (block) => storedAttachment(block) || (store && (block.type === 'image' || block.type === 'file')),
    )
  )
    return noop
  const scope = { sessionKey: session.key, lane: session.lane }
  const created: AttachmentReceipt[] = []
  const claimed = new Set<string>()
  const discard = async () => {
    for (const receipt of created) await store?.discard(scope, receipt.id)
  }
  try {
    const visible = await attachmentOperation(visibleAttachmentRefs(session), signal)
    const all = new Map(visible)
    const authorize = async (ref: ArtifactRef, receiptId?: string) => {
      if (visible.has(identity(ref))) return
      if (
        !store ||
        !receiptId ||
        !(await attachmentOperation(store.authorize(scope, { id: receiptId, artifact: ref }, signal), signal))
      )
        throw new AttachmentError('ATTACHMENT_NOT_AUTHORIZED')
      claimed.add(receiptId)
    }
    const read = async (ref: ArtifactRef) => {
      signal.throwIfAborted()
      const bytes = await attachmentOperation(session.d.runtime.artifactGet(ref), signal)
      signal.throwIfAborted()
      if (bytes.length !== ref.size || new IncrementalSha256().update(bytes).digest() !== ref.sha256)
        throw new AttachmentError('ATTACHMENT_HASH_MISMATCH')
      return bytes
    }
    const out: ContentBlock[] = []
    const modelImages: Extract<ContentBlock, { type: 'image' }>[] = []
    let imageBytes = 0,
      imagePixels = 0
    for (const block of input) {
      signal.throwIfAborted()
      let link: StoredAttachment | undefined
      if (storedAttachment(block)) {
        validateStoredAttachment(block)
        link = structuredClone(block)
        await authorize(link.attachment.artifact, link.attachment.receiptId)
        // A receipt for the original never confers authority to a different thumbnail.
        if (link.attachment.thumbnail) await authorize(link.attachment.thumbnail)
      } else if (store && (block.type === 'file' || block.type === 'image')) {
        const bytes = decodeAttachmentData(block.data, USER_MESSAGE_ATTACHMENT_LIMITS.maxAggregateBytes)
        const receipt = await attachmentOperation(store.store(scope, bytes, block.mimeType, signal), signal)
        created.push(receipt)
        claimed.add(receipt.id)
        const image =
          block.type === 'image'
            ? decodeSafeImageBytes({ bytes, mimeType: block.mimeType }, USER_MESSAGE_IMAGE_LIMITS)
            : undefined
        link = attachmentLink(
          receipt.artifact,
          block.type === 'file' ? block.name : 'image',
          image ? { image: { width: image.width, height: image.height } } : {},
        )
      }
      if (!link) {
        out.push(block)
        continue
      }
      const { artifact, image, thumbnail } = link.attachment
      if (artifact.size > USER_MESSAGE_ATTACHMENT_LIMITS.maxAggregateBytes)
        throw new AttachmentError('ATTACHMENT_BYTES')
      const bytes = await read(artifact)
      if (image) {
        const decoded = decodeSafeImageBytes({ bytes, mimeType: artifact.mime }, USER_MESSAGE_IMAGE_LIMITS)
        imageBytes += bytes.length
        imagePixels += decoded.pixels
        if (imageBytes > USER_MESSAGE_IMAGE_LIMITS.maxAggregateBytes)
          throw new AttachmentError('ATTACHMENT_BYTES')
        if (imagePixels > USER_MESSAGE_IMAGE_LIMITS.maxAggregatePixels)
          throw new AttachmentError('ATTACHMENT_PIXELS')
        const parts: string[] = []
        for (let at = 0; at < bytes.length; at += 16384)
          parts.push(String.fromCharCode(...bytes.subarray(at, at + 16384)))
        modelImages.push({ type: 'image', data: btoa(parts.join('')), mimeType: decoded.mime })
        if (decoded.width !== image.width || decoded.height !== image.height)
          throw new AttachmentError('ATTACHMENT_DATA')
      }
      if (thumbnail) {
        const decoded = decodeSafeImageBytes(
          { bytes: await read(thumbnail), mimeType: thumbnail.mime },
          {
            maxBytesPerImage: 256 * 1024,
            maxAggregateBytes: 256 * 1024,
            maxPixelsPerImage: 320 * 320,
            maxAggregatePixels: 320 * 320,
          },
        )
        if (decoded.width > 320 || decoded.height > 320) throw new AttachmentError('ATTACHMENT_PIXELS')
        all.set(identity(thumbnail), thumbnail)
      }
      all.set(identity(artifact), artifact)
      delete link.attachment.receiptId
      out.push(link)
    }
    if (modelImages.length) {
      const target = resolveModel(session, 'primary')
      const model = session.d.provider
        .models()
        .find((entry) => entry.route === target.route && entry.id === target.model)
      if (modelImageInputError(model, [{ content: modelImages }]))
        throw new AttachmentError('ATTACHMENT_DATA')
    }
    if ([...all.values()].reduce((n, ref) => n + ref.size, 0) > MAX_SESSION_BYTES)
      throw new AttachmentError('ATTACHMENT_QUOTA')
    return {
      content: out,
      async confirm() {
        for (const id of claimed) await store?.confirm(scope, id)
      },
      discard,
    }
  } catch (error) {
    await discard().catch(() => undefined)
    throw attachmentFailure(error, signal)
  }
}

/** Commit failure discards newly staged receipts; confirmation failure keeps conservative GC roots. */
export async function commitSessionAttachments<T>(
  session: SessionImpl,
  content: ContentBlock[],
  signal: AbortSignal | undefined,
  commit: (content: ContentBlock[]) => Promise<T>,
): Promise<T> {
  const admitted = await admitSessionAttachments(session, content, signal)
  let result: T
  try {
    result = await commit(admitted.content)
  } catch (error) {
    await admitted.discard().catch(() => undefined)
    throw error
  }
  await admitted.confirm().catch(() => undefined)
  return result
}

/** Conservative size floor without allocating another serialized copy of an upload. */
export function queuedInputSizeFloor(items: readonly { content: ContentBlock[] }[], limit: number): number {
  let size = 0
  for (const item of items) {
    if (!Array.isArray(item.content)) continue
    for (const block of item.content) {
      if (!block || typeof block !== 'object') continue
      if ('data' in block && typeof block.data === 'string') size += block.data.length
      if (block.type === 'text' && typeof block.text === 'string') size += block.text.length
      if (size > limit) return size
    }
  }
  return size
}
