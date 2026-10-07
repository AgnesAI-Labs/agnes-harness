import type { ContentBlock } from '@agnes/protocol'
import {
  decodeSafeImages,
  SafeImageError,
  USER_MESSAGE_IMAGE_LIMITS,
  validateUserAttachments,
} from '@agnes/protocol-validation'
import { CoreError } from '../types.js'

type UserImage = Extract<ContentBlock, { type: 'image' }>

/** Validate untrusted image blocks before an inbox event can persist them. */
export function validateUserMessageImages(content: readonly ContentBlock[]): void {
  try {
    validateUserAttachments(content)
  } catch (error) {
    throw new CoreError('E_ENVELOPE', error instanceof Error ? error.message : 'Invalid attachment.')
  }
  const images = content.filter((block): block is UserImage => block.type === 'image')
  if (images.length === 0) return

  try {
    decodeSafeImages(images, USER_MESSAGE_IMAGE_LIMITS)
  } catch (error) {
    if (error instanceof SafeImageError)
      throw new CoreError('E_ENVELOPE', `user image rejected (${error.code})`)
    throw error
  }
}
