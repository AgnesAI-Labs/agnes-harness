import { AttachmentValidationError, SafeImageError } from '@agnes/protocol-validation'
import { describe, expect, it } from 'vitest'
import { attachmentErrorNotice } from '../src/composer-errors.js'

const attachment = (code: AttachmentValidationError['code']) => new AttachmentValidationError(code, 'refused')

const image = (code: SafeImageError['code']) => new SafeImageError(code, 'refused')

describe('attachment and image validation errors map to composer entries', () => {
  it('keeps file refusals on file entries', () => {
    // 文件与图片共用一条解码器，但「文件数据坏了」不能报成「图片无效」。
    expect(attachmentErrorNotice(attachment('ATTACHMENT_DATA'))).toEqual({
      key: 'composer.attachment.dataInvalid',
    })
    expect(attachmentErrorNotice(attachment('ATTACHMENT_NAME'))).toEqual({
      key: 'composer.attachment.nameInvalid',
    })
    expect(attachmentErrorNotice(attachment('ATTACHMENT_BYTES'))).toEqual({
      key: 'composer.attachment.tooLarge',
    })
    expect(attachmentErrorNotice(attachment('ATTACHMENT_COUNT'))).toEqual({
      key: 'composer.attachment.tooMany',
      vars: { count: 50 },
    })
  })

  it('splits image refusals by cause', () => {
    expect(attachmentErrorNotice(image('PIXEL_LIMIT'))).toEqual({ key: 'composer.image.tooLargePixels' })
    expect(attachmentErrorNotice(image('BYTE_LIMIT'))).toEqual({ key: 'composer.image.tooLarge' })
    for (const code of ['BASE64_INVALID', 'FORMAT_INVALID', 'MIME_MISMATCH', 'DIMENSIONS_INVALID'] as const)
      expect(attachmentErrorNotice(image(code)), code).toEqual({ key: 'composer.image.invalid' })
  })

  it('leaves unrelated failures to the caller', () => {
    // 后台错误、网络错误没有词条，调用方沿用原文案。
    expect(attachmentErrorNotice(new Error('follow-up rejected'))).toBeUndefined()
    expect(attachmentErrorNotice(undefined)).toBeUndefined()
  })
})
