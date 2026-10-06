import {
  AttachmentValidationError,
  SafeImageError,
  USER_MESSAGE_ATTACHMENT_LIMITS,
  validateUserAttachments,
} from '@agnes/protocol-validation'
import { describe, expect, it } from 'vitest'

type AttachmentInput = { type: string; data?: string; name?: string; mimeType?: string }

const textFile = (overrides: Partial<AttachmentInput> = {}): AttachmentInput => ({
  type: 'file',
  name: 'note.txt',
  mimeType: 'text/plain',
  data: 'eA==',
  ...overrides,
})

function refusal(content: readonly AttachmentInput[]): AttachmentValidationError {
  try {
    validateUserAttachments(content)
  } catch (error) {
    if (error instanceof AttachmentValidationError) return error
    throw error
  }
  throw new Error('validation accepted the content')
}

describe('user message attachment validation', () => {
  it('names the reason it refused, so callers can pick a localized message', () => {
    const count = refusal(
      Array.from({ length: USER_MESSAGE_ATTACHMENT_LIMITS.maxCount + 1 }, () => textFile()),
    )
    expect(count.code).toBe('ATTACHMENT_COUNT')
    expect(count.name).toBe('AttachmentValidationError')
    expect(count.message).toBe(
      `A message can hold at most ${USER_MESSAGE_ATTACHMENT_LIMITS.maxCount} attachments.`,
    )

    expect(refusal([{ type: 'file', name: 'note.txt', mimeType: 'text/plain' }]).code).toBe('ATTACHMENT_DATA')

    for (const block of [
      textFile({ name: '' }),
      textFile({ name: 'line\nbreak.txt' }),
      textFile({ mimeType: 'not-a-mime' }),
      textFile({ mimeType: `${'a'.repeat(129)}/plain` }),
    ])
      expect(refusal([block]).code, JSON.stringify(block)).toBe('ATTACHMENT_NAME')
  })

  it('reports a file whose data will not decode as file data, never as an image', () => {
    // 文件与图片走同一条 Base64 解码器，它抛的是 SafeImageError：直接透出去会让下游按图片文案
    // 报「图片无效」，而用户换的是普通文件。
    const refusalError = refusal([textFile({ data: '****' })])
    expect(refusalError.code).toBe('ATTACHMENT_DATA')
    expect(refusalError.message).toBe('image data contains invalid base64 characters')
    expect(refusalError.cause).toBeInstanceOf(SafeImageError)
    expect((refusalError.cause as SafeImageError).code).toBe('BASE64_INVALID')
  })

  it('accepts files and images that stay inside the documented limits', () => {
    expect(() => validateUserAttachments([textFile(), { type: 'image', data: 'eA==' }])).not.toThrow()
    expect(() => validateUserAttachments([textFile({ data: '' })])).not.toThrow()
  })
})
