import type { ContentBlock } from '@agnes/protocol'
import {
  attachmentForm,
  decodeAttachmentData,
  decodeSafeImageBytes,
  decodeSafeImages,
  SafeImageError,
  type SafeImageLimits,
  USER_MESSAGE_ATTACHMENT_LIMITS,
  USER_IMAGE_SEND_BUDGET,
  USER_MESSAGE_IMAGE_LIMITS,
} from '@agnes/protocol-validation'
import type { AttachmentReadPort } from '../request/attachment-bytes.js'
import { CoreError } from '../types.js'

/** The reference blocks of one message, as JSON, stay within this; the ledger row stays small. */
export const MAX_ATTACHMENT_ROW_BYTES = 64 * 1024

/**
 * The host's attachment store as one session sees it: the reader its attachment reads go through,
 * plus admission. Admission is called before anything is appended, so a refusal leaves the ledger
 * exactly as it was.
 */
export type UserAttachmentPort = AttachmentReadPort &
  Readonly<{
    /** False keeps inline attachments inline; references a client sends are still checked. */
    storeByReference: boolean
    /** Writes one inline attachment's bytes; resolves to its reference. Rejects with an error whose `code` names the refusal. */
    store(
      input: { bytes: Uint8Array; mimeType: string; sessionKey: string; sessionBytes: number },
      signal: AbortSignal,
    ): Promise<{ sha256: string; bytes: number }>
    /** 'ok' when the object exists and this session uploaded it, or the session already references it. */
    authorize(input: {
      sha256: string
      bytes: number
      mimeType: string
      sessionKey: string
      referenced: boolean
    }): Promise<'ok' | 'missing' | 'unauthorized'>
    /** Drops a discarded session's upload receipts, so a new session bound to its key does not inherit them. */
    forgetReceipts?(sessionKey: string): Promise<void>
  }>

type Ref = { sha256: string; bytes: number }
type ReferenceBlock = {
  type: 'image' | 'file'
  mimeType: string
  name?: string
  attachment: Ref
  width?: number
  height?: number
  thumbnail?: unknown
}
type InlineBlock = { type: 'image' | 'file'; mimeType: string; name?: string; data: string }

const MIB = 1024 * 1024
const utf8 = new TextEncoder()
const refused = (code: string, message: string, detail: Record<string, unknown> = {}) =>
  new CoreError('E_ENVELOPE', message, {
    ...detail,
    code,
    // The reason survives the worker boundary, which keeps only a code, a reason and the message.
    reason: code.toLowerCase().replaceAll('_', '-'),
  })

const base64Bytes = (data: string): number =>
  Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)
const imageTooLarge = () =>
  refused(
    'ATTACHMENT_IMAGE_TOO_LARGE',
    'An image is too large to send to the model: each image and all images in one message may be at most 16 MiB, and at most 8 million pixels together. Shrink the image and add it again.',
  )

/**
 * Refuses a message whose images a model request could not carry: an image over 16 MiB, images over
 * 16 MiB together, or over 8 million pixels together. It runs before anything is stored, so such a
 * message is refused when it is sent instead of failing when a request is built. Files are not counted.
 */
export function checkUserImageBudget(content: readonly ContentBlock[]): void {
  const budget = USER_IMAGE_SEND_BUDGET
  let bytes = 0
  let pixels = 0
  const inline: InlineBlock[] = []
  for (const block of content) {
    if (block.type !== 'image') continue
    const form = attachmentForm(block)
    let size: number
    if (form === 'reference') {
      const ref = block as unknown as ReferenceBlock
      size = ref.attachment.bytes
      if (Number.isSafeInteger(ref.width) && Number.isSafeInteger(ref.height))
        pixels += (ref.width as number) * (ref.height as number)
    } else if (form === 'inline') {
      size = base64Bytes((block as unknown as InlineBlock).data)
      inline.push(block as unknown as InlineBlock)
    } else continue
    bytes += size
  }
  // One image is bounded as all of them are: the per-image and the per-message limits are the same.
  if (bytes > budget.maxAggregateBytes || pixels > budget.maxAggregatePixels) throw imageTooLarge()
  if (inline.length === 0) return
  if (pixels >= budget.maxAggregatePixels) throw imageTooLarge()
  try {
    decodeSafeImages(inline, {
      maxBytesPerImage: budget.maxBytesPerImage,
      maxAggregateBytes: budget.maxAggregateBytes,
      maxPixelsPerImage: USER_MESSAGE_IMAGE_LIMITS.maxPixelsPerImage,
      maxAggregatePixels: budget.maxAggregatePixels - pixels,
    })
  } catch (error) {
    if (error instanceof SafeImageError && (error.code === 'BYTE_LIMIT' || error.code === 'PIXEL_LIMIT'))
      throw imageTooLarge()
    // Any other fault is the image validation's to report.
  }
}
// The store's own refusals keep their code and get a fixed message; anything else (a raw file system
// error, whose message names paths in the data directory) is reported as unavailable.
const STORE_REFUSALS: Readonly<Record<string, string>> = {
  UPLOAD_QUOTA: 'There is no room for this attachment: a storage quota was reached.',
  UPLOAD_SIZE_LIMIT: 'The attachment is larger than the upload limit.',
  ATTACHMENT_MISSING: 'The attachment is no longer stored. Upload it again.',
  ATTACHMENT_CORRUPT: 'The stored attachment is damaged. Upload it again.',
  ATTACHMENT_HASH_MISMATCH: 'The stored attachment is damaged. Upload it again.',
  ATTACHMENT_TOO_LARGE: 'The attachment is too large to store.',
  ATTACHMENT_TIMEOUT: 'The attachment store took too long.',
}
const storeFailure = (error: unknown, fallback: 'UPLOAD_UNAVAILABLE' | 'ATTACHMENT_UNAVAILABLE') => {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && Object.hasOwn(STORE_REFUSALS, code)
    ? refused(code, STORE_REFUSALS[code] as string)
    : refused(fallback, 'The attachment store is unavailable.')
}

/**
 * The same bound the attachment store puts on one write: 2 s for every started MiB, at least 10 s.
 * Inline bytes are stored and image references are read whole, so both count.
 */
export function attachmentDeadlineMs(content: readonly ContentBlock[]): number {
  let bytes = 0
  for (const block of content) {
    const form = attachmentForm(block)
    if (form === 'inline') bytes += (block as InlineBlock).data.length * 0.75
    else if (form === 'reference' && block.type === 'image') {
      const size = (block as unknown as ReferenceBlock).attachment.bytes
      if (Number.isSafeInteger(size) && size > 0)
        bytes += Math.min(size, USER_MESSAGE_IMAGE_LIMITS.maxBytesPerImage)
    }
  }
  return Math.max(10_000, Math.ceil(bytes / MIB) * 2_000)
}

const THUMBNAIL_MAX_BYTES = 256 * 1024
const THUMBNAIL_MAX_EDGE = 320
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47]

const isRef = (value: unknown): value is Ref =>
  !!value &&
  typeof value === 'object' &&
  typeof (value as Ref).sha256 === 'string' &&
  /^[0-9a-f]{64}$/u.test((value as Ref).sha256) &&
  Number.isSafeInteger((value as Ref).bytes) &&
  (value as Ref).bytes >= 0

async function authorized(
  port: UserAttachmentPort,
  ref: Ref,
  mimeType: string,
  input: { sessionKey: string; referenced(sha256: string): boolean },
  /** The attachment's name, so a refusal can say which one it was. */
  name: string,
): Promise<void> {
  let verdict: 'ok' | 'missing' | 'unauthorized'
  try {
    verdict = await port.authorize({
      sha256: ref.sha256,
      bytes: ref.bytes,
      mimeType,
      sessionKey: input.sessionKey,
      referenced: input.referenced(ref.sha256),
    })
  } catch (error) {
    throw storeFailure(error, 'ATTACHMENT_UNAVAILABLE')
  }
  if (verdict === 'missing')
    throw refused('ATTACHMENT_MISSING', `The attachment “${name}” is no longer stored. Upload it again.`, {
      name,
    })
  if (verdict !== 'ok')
    throw refused('ATTACHMENT_NOT_AUTHORIZED', 'The attachment was not uploaded to this session.')
}

/** Reads an authorized object, which the store has confirmed is exactly `bytes` long, and checks its header. */
async function storedImage(
  port: UserAttachmentPort,
  ref: Ref,
  /** Undefined for a thumbnail, whose format is read from its first bytes. */
  declared: string | undefined,
  limits: SafeImageLimits,
  signal: AbortSignal,
): Promise<{ width: number; height: number }> {
  let bytes: Uint8Array
  try {
    bytes = await port.read(ref.sha256, undefined, signal)
  } catch (error) {
    throw storeFailure(error, 'ATTACHMENT_UNAVAILABLE')
  }
  const mimeType = declared ?? (PNG_MAGIC.every((b, i) => bytes[i] === b) ? 'image/png' : 'image/jpeg')
  try {
    return decodeSafeImageBytes({ bytes, mimeType }, limits)
  } catch (error) {
    if (error instanceof SafeImageError)
      throw refused('ATTACHMENT_DATA', `The stored image is invalid (${error.code}).`)
    throw error
  }
}

type Thumbnail = Ref & { width: number; height: number }
const isThumbnail = (value: unknown): value is Thumbnail =>
  isRef(value) &&
  value.bytes > 0 &&
  value.bytes <= THUMBNAIL_MAX_BYTES &&
  [(value as Thumbnail).width, (value as Thumbnail).height].every(
    (edge) => Number.isSafeInteger(edge) && edge >= 1 && edge <= THUMBNAIL_MAX_EDGE,
  )

/**
 * Runs before an input is queued: inline bytes go to the attachment store once and the block becomes a
 * reference; a reference the client sent is checked against the store and this session's receipts.
 * Nothing is written to the ledger here, so a failure leaves the session exactly as it was.
 */
export async function admitAttachments(input: {
  content: ContentBlock[]
  sessionKey: string
  port: UserAttachmentPort | undefined
  referenced(sha256: string): boolean
  sessionBytes(): number
  signal: AbortSignal
}): Promise<ContentBlock[]> {
  const { port } = input
  const out: ContentBlock[] = []
  let added = 0
  for (const block of input.content) {
    const form = attachmentForm(block)
    if (form === 'omitted') throw refused('ATTACHMENT_DATA', 'Attachment data is missing.')
    if (form === 'reference') {
      const ref = block as unknown as ReferenceBlock
      if (!port)
        throw refused('ATTACHMENT_NOT_AUTHORIZED', 'This runtime does not accept attachment references.')
      // An image is read whole to check its header, so its size is bounded before anything is read.
      if (ref.type === 'image' && ref.attachment.bytes > USER_MESSAGE_IMAGE_LIMITS.maxBytesPerImage)
        throw refused('ATTACHMENT_BYTES', 'The image is larger than an image attachment may be.')
      const name = ref.name ?? (ref.type === 'image' ? 'image' : 'attachment')
      await authorized(port, ref.attachment, ref.mimeType, input, name)
      if (ref.thumbnail !== undefined) {
        // A thumbnail is a second object: naming one this session may not read is the same forgery,
        // and it must really be a small image of the size it claims.
        if (!isThumbnail(ref.thumbnail)) throw refused('ATTACHMENT_DATA', 'The image thumbnail is malformed.')
        const thumbnail = ref.thumbnail
        await authorized(port, thumbnail, 'image/jpeg', input, name)
        const image = await storedImage(
          port,
          thumbnail,
          undefined,
          {
            maxBytesPerImage: THUMBNAIL_MAX_BYTES,
            maxAggregateBytes: THUMBNAIL_MAX_BYTES,
            maxPixelsPerImage: THUMBNAIL_MAX_EDGE * THUMBNAIL_MAX_EDGE,
            maxAggregatePixels: THUMBNAIL_MAX_EDGE * THUMBNAIL_MAX_EDGE,
          },
          input.signal,
        )
        if (image.width !== thumbnail.width || image.height !== thumbnail.height)
          throw refused('ATTACHMENT_DATA', 'The thumbnail does not match its declared size.')
      }
      if (ref.type === 'image') {
        const image = await storedImage(
          port,
          ref.attachment,
          ref.mimeType,
          USER_MESSAGE_IMAGE_LIMITS,
          input.signal,
        )
        if (image.width !== ref.width || image.height !== ref.height)
          throw refused('ATTACHMENT_DATA', 'The image does not match its declared size.')
      }
      out.push(block)
      continue
    }
    if (form !== 'inline' || !port?.storeByReference) {
      out.push(block)
      continue
    }
    const inline = block as unknown as InlineBlock
    const bytes = decodeAttachmentData(inline.data, USER_MESSAGE_ATTACHMENT_LIMITS.maxAggregateBytes)
    let stored: Ref
    try {
      stored = await port.store(
        {
          bytes,
          mimeType: inline.mimeType,
          sessionKey: input.sessionKey,
          sessionBytes: input.sessionBytes() + added,
        },
        input.signal,
      )
    } catch (error) {
      throw storeFailure(error, 'UPLOAD_UNAVAILABLE')
    }
    added += stored.bytes
    if (inline.type === 'image') {
      // Validated as a safe image before admission; this reads its size for the reference.
      const image = decodeSafeImageBytes({ bytes, mimeType: inline.mimeType }, USER_MESSAGE_IMAGE_LIMITS)
      out.push({
        type: 'image',
        mimeType: image.mime,
        attachment: { sha256: stored.sha256, bytes: stored.bytes },
        width: image.width,
        height: image.height,
        ...(inline.name ? { name: inline.name } : {}),
      } as ContentBlock)
    } else
      out.push({
        type: 'file',
        mimeType: inline.mimeType,
        name: inline.name as string,
        attachment: { sha256: stored.sha256, bytes: stored.bytes },
      } as ContentBlock)
  }
  // Only references count: an attachment kept inline (the switch is off) is bounded by the frame size.
  const attachmentBytes = utf8.encode(
    JSON.stringify(out.filter((b) => attachmentForm(b) === 'reference')),
  ).byteLength
  if (attachmentBytes > MAX_ATTACHMENT_ROW_BYTES)
    throw refused(
      'ATTACHMENT_COUNT',
      'Too many attachments or attachment names are too long for one message.',
    )
  return out
}
