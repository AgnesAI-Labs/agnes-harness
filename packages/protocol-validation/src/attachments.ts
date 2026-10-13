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

function validReference(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const { sha256, bytes } = value as { sha256?: unknown; bytes?: unknown }
  return (
    typeof sha256 === 'string' &&
    /^[0-9a-f]{64}$/u.test(sha256) &&
    Number.isSafeInteger(bytes) &&
    (bytes as number) >= 0
  )
}

/**
 * How an `image` or `file` block carries its bytes: `inline` holds them as Base64, `reference`
 * names a stored object by digest, and `omitted` is the lean transfer form that left them in
 * storage. A block that carries none of them, or more than one, has no form: it is malformed.
 * Every other block type has no attachment form either.
 */
export type AttachmentForm = 'inline' | 'reference' | 'omitted'

export function attachmentForm(block: unknown): AttachmentForm | undefined {
  if (!block || typeof block !== 'object') return undefined
  const b = block as Record<string, unknown>
  if (b.type !== 'image' && b.type !== 'file') return undefined
  const forms: AttachmentForm[] = []
  if (b.data !== undefined) forms.push('inline')
  if (b.attachment !== undefined) forms.push('reference')
  if (b.dataOmitted !== undefined) forms.push('omitted')
  if (forms.length !== 1) return undefined
  const [form] = forms
  if (form === 'inline') return typeof b.data === 'string' ? form : undefined
  const carrier = form === 'reference' ? b.attachment : b.dataOmitted
  return carrier && typeof carrier === 'object' ? form : undefined
}

function validName(name: unknown): boolean {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 256 &&
    ![...name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
}

/** Applies to files and images together, independently of the model's image limits. */
export function validateUserAttachments(
  content: readonly {
    type: string
    data?: string
    name?: string
    mimeType?: string
    attachment?: unknown
  }[],
): void {
  const attachments = content.filter((block) => block.type === 'file' || block.type === 'image')
  if (attachments.length > USER_MESSAGE_ATTACHMENT_LIMITS.maxCount)
    throw new AttachmentValidationError(
      'ATTACHMENT_COUNT',
      `A message can hold at most ${USER_MESSAGE_ATTACHMENT_LIMITS.maxCount} attachments.`,
    )
  let total = 0
  for (const block of attachments) {
    // A reference names bytes already in the attachment store: it counts toward the number of
    // attachments, never toward the inline total. Anything else must carry its bytes inline; the
    // lean form only ever travels out of storage and is not something to submit.
    // A block with more than one carrier (data and a reference, say) has no form and is refused.
    const form = attachmentForm(block)
    const reference = form === 'reference'
    if (reference ? !validReference(block.attachment) : form !== 'inline')
      throw new AttachmentValidationError('ATTACHMENT_DATA', 'Attachment data must be Base64.')
    if (
      block.type === 'file' &&
      (!validName(block.name) ||
        typeof block.mimeType !== 'string' ||
        !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu.test(block.mimeType) ||
        block.mimeType.length > 128)
    )
      throw new AttachmentValidationError('ATTACHMENT_NAME', 'Attachment name or MIME type is invalid.')
    // An image name reaches the model in the text that stands in for the image, so it follows the
    // same rule as a file name.
    if (block.type === 'image' && block.name !== undefined && !validName(block.name))
      throw new AttachmentValidationError('ATTACHMENT_NAME', 'Attachment name or MIME type is invalid.')
    if (reference || typeof block.data !== 'string') continue
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
