import type { ContentBlock } from '@agnes/protocol'
import {
  decodeSafeImages,
  SafeImageError,
  USER_MESSAGE_IMAGE_LIMITS,
  USER_MESSAGE_IMAGE_MAX_COUNT,
} from '@agnes/protocol-validation'
import { CoreError } from '../types.js'

type UserImage = Extract<ContentBlock, { type: 'image' }>

/** Validate untrusted image blocks before an inbox event can persist them. */
export function validateUserMessageImages(content: readonly ContentBlock[]): void {
  const images = content.filter((block): block is UserImage => block.type === 'image')
  if (images.length === 0) return
  if (images.length > USER_MESSAGE_IMAGE_MAX_COUNT)
    throw new CoreError(
      'E_ENVELOPE',
      `a user message can contain at most ${USER_MESSAGE_IMAGE_MAX_COUNT} images`,
    )

  try {
    decodeSafeImages(images, USER_MESSAGE_IMAGE_LIMITS)
  } catch (error) {
    if (error instanceof SafeImageError)
      throw new CoreError('E_ENVELOPE', `user image rejected (${error.code})`)
    throw error
  }
}
