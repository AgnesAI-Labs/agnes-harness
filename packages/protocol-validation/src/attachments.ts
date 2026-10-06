import { decodeAttachmentData, USER_MESSAGE_IMAGE_LIMITS } from './safe-image.js'

export const USER_MESSAGE_ATTACHMENT_LIMITS = Object.freeze({
  maxCount: 50,
  maxAggregateBytes: USER_MESSAGE_IMAGE_LIMITS.maxAggregateBytes,
})

/** Applies to files and images together, independently of the model's image limits. */
export function validateUserAttachments(
  content: readonly { type: string; data?: string; name?: string; mimeType?: string }[],
): void {
  const attachments = content.filter((block) => block.type === 'file' || block.type === 'image')
  if (attachments.length > USER_MESSAGE_ATTACHMENT_LIMITS.maxCount)
    throw new Error('A message can hold at most 50 attachments.')
  let total = 0
  for (const block of attachments) {
    if (typeof block.data !== 'string') throw new Error('Attachment data must be Base64.')
    if (
      block.type === 'file' &&
      (typeof block.name !== 'string' ||
        block.name.length === 0 ||
        block.name.length > 256 ||
        [...block.name].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ) ||
        typeof block.mimeType !== 'string' ||
        !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu.test(block.mimeType) ||
        block.mimeType.length > 128)
    )
      throw new Error('Attachment name or MIME type is invalid.')
    const remaining = USER_MESSAGE_ATTACHMENT_LIMITS.maxAggregateBytes - total
    const decodedSize =
      (block.data.length / 4) * 3 - (block.data.endsWith('==') ? 2 : block.data.endsWith('=') ? 1 : 0)
    if (decodedSize > remaining)
      throw new Error('Attachments in one message must total no more than 100 MiB.')
    const bytes = decodeAttachmentData(block.data, Math.max(remaining, 1))
    total += bytes.byteLength
    if (total > USER_MESSAGE_ATTACHMENT_LIMITS.maxAggregateBytes)
      throw new Error('Attachments in one message must total no more than 100 MiB.')
  }
}
