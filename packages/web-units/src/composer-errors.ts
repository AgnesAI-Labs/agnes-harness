import type { AttachmentRefusalCode } from '@agnes/protocol'
import {
  AttachmentValidationError,
  SafeImageError,
  USER_MESSAGE_ATTACHMENT_LIMITS,
} from '@agnes/protocol-validation'

/** 词条 key 与插值变量。文案由调用方用自己的 `t` 取，这一层不碰语言。 */
export type AttachmentErrorNotice = Readonly<{
  key: string
  vars?: Record<string, string | number>
}>

/**
 * 附件与图片校验错误 → 词条 key，供输入框和提交路径共用一份映射。
 *
 * 文件数据走的是图片那条解码器，抛出的也是 `SafeImageError`，所以判断顺序是「先看是不是
 * 附件校验错误」：文件数据坏了报成「图片无效」会让用户去换图片格式。返回 undefined 表示
 * 不是校验错误，调用方沿用后台返回的原文案。
 *
 * 词条都在 `composer.*` 下：同一批限制由输入框先报一次、提交时兜底再报一次，两处取同一份
 * 文案才不会各自漂移。
 */
/** The daemon's attachment refusals (`data.code` of the RPC error) and the sentence each gets. */
const REFUSAL_KEYS: Readonly<Partial<Record<AttachmentRefusalCode, string>>> = {
  UPLOAD_QUOTA: 'composer.upload.quota',
  UPLOAD_SIZE_LIMIT: 'composer.upload.tooLarge',
  UPLOAD_NOT_IMAGE: 'composer.image.invalid',
  ATTACHMENT_NOT_AUTHORIZED: 'composer.upload.notAuthorized',
  ATTACHMENT_MISSING: 'composer.upload.missing',
  ATTACHMENT_CORRUPT: 'composer.upload.missing',
  ATTACHMENT_HASH_MISMATCH: 'composer.upload.missing',
  ATTACHMENT_DATA: 'composer.attachment.dataInvalid',
  ATTACHMENT_BYTES: 'composer.attachment.tooLarge',
  ATTACHMENT_IMAGE_TOO_LARGE: 'composer.image.overBudget',
  ATTACHMENT_TIMEOUT: 'composer.attachment.storeTimeout',
  ATTACHMENT_UNAVAILABLE: 'composer.attachment.storeUnavailable',
  ATTACHMENT_TOO_LARGE: 'composer.attachment.storeTooLarge',
}

export function attachmentErrorNotice(error: unknown): AttachmentErrorNotice | undefined {
  const data = (error as { data?: { code?: unknown; name?: unknown } } | null)?.data
  const refusal = data?.code
  // The daemon names an attachment that is gone, so the person knows which one to add again.
  if (refusal === 'ATTACHMENT_MISSING' && typeof data?.name === 'string')
    return { key: 'composer.upload.missingNamed', vars: { name: data.name } }
  if (typeof refusal === 'string' && Object.hasOwn(REFUSAL_KEYS, refusal))
    return { key: REFUSAL_KEYS[refusal as AttachmentRefusalCode] as string }
  if (error instanceof AttachmentValidationError) {
    switch (error.code) {
      case 'ATTACHMENT_COUNT':
        return {
          key: 'composer.attachment.tooMany',
          vars: { count: USER_MESSAGE_ATTACHMENT_LIMITS.maxCount },
        }
      case 'ATTACHMENT_BYTES':
        return { key: 'composer.attachment.tooLarge' }
      case 'ATTACHMENT_DATA':
        return { key: 'composer.attachment.dataInvalid' }
      case 'ATTACHMENT_NAME':
        return { key: 'composer.attachment.nameInvalid' }
    }
  }
  if (error instanceof SafeImageError) {
    if (error.code === 'PIXEL_LIMIT') return { key: 'composer.image.tooLargePixels' }
    if (error.code === 'BYTE_LIMIT') return { key: 'composer.image.tooLarge' }
    return { key: 'composer.image.invalid' }
  }
  return undefined
}
