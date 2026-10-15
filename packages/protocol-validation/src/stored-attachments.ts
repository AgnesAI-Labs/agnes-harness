import { AttachmentError } from './attachment-errors.js'

export type StoredAttachmentInput = {
  type: 'resource_link'
  uri: string
  name: string
  mimeType: string
  attachment: {
    artifact: { sha256: string; size: number; mime: string }
    image?: { width: number; height: number }
    thumbnail?: { sha256: string; size: number; mime: string }
    receiptId?: string
  }
}
const MIME = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const ref = (value: unknown): boolean =>
  object(value) &&
  typeof value.sha256 === 'string' &&
  /^[a-f0-9]{64}$/u.test(value.sha256) &&
  Number.isSafeInteger(value.size) &&
  (value.size as number) >= 0 &&
  typeof value.mime === 'string' &&
  value.mime.length <= 128 &&
  MIME.test(value.mime)

/** Validates untrusted metadata before any storage read, including the independent thumbnail. */
export function validateStoredAttachment(value: unknown): asserts value is StoredAttachmentInput {
  if (
    !object(value) ||
    value.type !== 'resource_link' ||
    !object(value.attachment) ||
    !ref(value.attachment.artifact)
  )
    throw new AttachmentError('ATTACHMENT_DATA')
  const artifact = value.attachment.artifact as StoredAttachmentInput['attachment']['artifact']
  if (value.uri !== `artifact://${artifact.sha256}` || value.mimeType !== artifact.mime)
    throw new AttachmentError('ATTACHMENT_MIME')
  if (
    typeof value.name !== 'string' ||
    !value.name ||
    value.name.length > 256 ||
    [...value.name].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw new AttachmentError('ATTACHMENT_DATA')
  const { image, thumbnail, receiptId } = value.attachment
  if (receiptId !== undefined && (typeof receiptId !== 'string' || !/^[a-f0-9-]{36}$/u.test(receiptId)))
    throw new AttachmentError('ATTACHMENT_DATA')
  if (
    image !== undefined &&
    (!object(image) ||
      !Number.isSafeInteger(image.width) ||
      !Number.isSafeInteger(image.height) ||
      (image.width as number) < 1 ||
      (image.height as number) < 1 ||
      (image.width as number) > 65535 ||
      (image.height as number) > 65535 ||
      !['image/png', 'image/jpeg'].includes(artifact.mime))
  )
    throw new AttachmentError('ATTACHMENT_DATA')
  if (
    thumbnail !== undefined &&
    (!ref(thumbnail) ||
      !['image/png', 'image/jpeg'].includes((thumbnail as Record<string, unknown>).mime as string) ||
      ((thumbnail as Record<string, unknown>).size as number) > 256 * 1024 ||
      ((thumbnail as Record<string, unknown>).size as number) < 1)
  )
    throw new AttachmentError('ATTACHMENT_DATA')
}
