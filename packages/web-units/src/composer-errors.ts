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
export function attachmentErrorNotice(error: unknown): AttachmentErrorNotice | undefined {
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
