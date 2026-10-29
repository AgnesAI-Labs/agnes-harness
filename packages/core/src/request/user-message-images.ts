import { CoreError } from '@agnes/core-common/types'
import type { ContentBlock } from '@agnes/protocol'
import {
  AttachmentError,
  decodeSafeImages,
  SafeImageError,
  USER_MESSAGE_IMAGE_LIMITS,
  validateUserAttachments,
} from '@agnes/protocol-validation'

type UserImage = Extract<ContentBlock, { type: 'image' }>

/** Validate untrusted image blocks before an inbox event can persist them. */
export function validateUserMessageImages(content: readonly ContentBlock[]): void {
  try {
    validateUserAttachments(content)
  } catch (error) {
    throw new CoreError('E_ENVELOPE', error instanceof Error ? error.message : 'Invalid attachment.', {
      code:
        error instanceof AttachmentError
          ? error.code
          : error instanceof SafeImageError && error.code === 'BYTE_LIMIT'
            ? 'ATTACHMENT_BYTES'
            : 'ATTACHMENT_DATA',
    })
  }
  const images = content.filter((block): block is UserImage => block.type === 'image')
  if (images.length === 0) return

  try {
    decodeSafeImages(images, USER_MESSAGE_IMAGE_LIMITS)
  } catch (error) {
    if (error instanceof SafeImageError)
      throw new CoreError('E_ENVELOPE', `user image rejected (${error.code})`, {
        code:
          error.code === 'BYTE_LIMIT'
            ? 'ATTACHMENT_BYTES'
            : error.code === 'PIXEL_LIMIT'
              ? 'ATTACHMENT_PIXELS'
              : error.code === 'MIME_MISMATCH'
                ? 'ATTACHMENT_MIME'
                : 'ATTACHMENT_DATA',
      })
    throw error
  }
}
