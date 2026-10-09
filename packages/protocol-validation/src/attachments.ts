import { decodeAttachmentData, SafeImageError, USER_MESSAGE_IMAGE_LIMITS } from './safe-image.js'

export const USER_MESSAGE_ATTACHMENT_LIMITS = Object.freeze({
  maxCount: 50,
  maxAggregateBytes: USER_MESSAGE_IMAGE_LIMITS.maxAggregateBytes,
})

export type AttachmentValidationCode =
  | 'ATTACHMENT_BYTES'
  | 'ATTACHMENT_COUNT'
  | 'ATTACHMENT_DATA'
  | 'ATTACHMENT_NAME'

/**
 * 附件校验失败的可判别标记。调用方按 `code` 取本地化词条，不去解析英文原文；
 * 与 `SafeImageError` 一样挂在 error 对象自身，不放进 `error.data`。
 */
export class AttachmentValidationError extends Error {
  readonly code: AttachmentValidationCode

  constructor(code: AttachmentValidationCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AttachmentValidationError'
    this.code = code
  }
}

/**
 * 文件数据走的是图片那条 Base64 解码器，抛出来的却是 `SafeImageError`。在这里换成本函数的
 * 错误码并保留原错误：正在校验的是普通文件，让下游按图片错误取词会把「文件数据坏了」报成
 * 「图片无效」。原消息一并保留，只读 `.message` 的调用点显示结果不变。
 */
function decodeAttachmentSize(data: string, maxBytes: number): number {
  try {
    return decodeAttachmentData(data, maxBytes).byteLength
  } catch (error) {
    if (error instanceof SafeImageError)
      throw new AttachmentValidationError(
        error.code === 'BYTE_LIMIT' ? 'ATTACHMENT_BYTES' : 'ATTACHMENT_DATA',
        error.message,
        { cause: error },
      )
    throw error
  }
}

/** Applies to files and images together, independently of the model's image limits. */
export function validateUserAttachments(
  content: readonly { type: string; data?: string; name?: string; mimeType?: string }[],
): void {
  const attachments = content.filter((block) => block.type === 'file' || block.type === 'image')
  if (attachments.length > USER_MESSAGE_ATTACHMENT_LIMITS.maxCount)
    throw new AttachmentValidationError(
      'ATTACHMENT_COUNT',
      `A message can hold at most ${USER_MESSAGE_ATTACHMENT_LIMITS.maxCount} attachments.`,
    )
  let total = 0
  for (const block of attachments) {
    if (typeof block.data !== 'string')
      throw new AttachmentValidationError('ATTACHMENT_DATA', 'Attachment data must be Base64.')
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
      throw new AttachmentValidationError('ATTACHMENT_NAME', 'Attachment name or MIME type is invalid.')
    const remaining = USER_MESSAGE_ATTACHMENT_LIMITS.maxAggregateBytes - total
    const decodedSize =
      (block.data.length / 4) * 3 - (block.data.endsWith('==') ? 2 : block.data.endsWith('=') ? 1 : 0)
    if (decodedSize > remaining)
      throw new AttachmentValidationError(
        'ATTACHMENT_BYTES',
        'Attachments in one message must total no more than 100 MiB.',
      )
    total += decodeAttachmentSize(block.data, Math.max(remaining, 1))
    if (total > USER_MESSAGE_ATTACHMENT_LIMITS.maxAggregateBytes)
      throw new AttachmentValidationError(
        'ATTACHMENT_BYTES',
        'Attachments in one message must total no more than 100 MiB.',
      )
  }
}
