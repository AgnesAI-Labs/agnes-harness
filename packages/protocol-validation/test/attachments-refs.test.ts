import {
  AttachmentValidationError,
  attachmentForm,
  USER_MESSAGE_ATTACHMENT_LIMITS,
  validateUserAttachments,
} from '@agnes/protocol-validation'
import { describe, expect, it } from 'vitest'

type Block = Parameters<typeof validateUserAttachments>[0][number] & Record<string, unknown>

const sha = 'b'.repeat(64)
const fileRef = (overrides: Record<string, unknown> = {}): Block => ({
  type: 'file',
  mimeType: 'application/zip',
  name: 'insects.zip',
  attachment: { sha256: sha, bytes: 95_000_000 },
  ...overrides,
})
const imageRef = (): Block => ({
  type: 'image',
  mimeType: 'image/png',
  name: 'shot.png',
  attachment: { sha256: sha, bytes: 1234 },
  width: 640,
  height: 480,
})

function refusal(content: readonly Block[]): AttachmentValidationError {
  try {
    validateUserAttachments(content)
  } catch (error) {
    if (error instanceof AttachmentValidationError) return error
    throw error
  }
  throw new Error('validation accepted the content')
}

describe('reference attachments in a user message', () => {
  it('accepts as many references as attachments are allowed, and counts one more', () => {
    const max = USER_MESSAGE_ATTACHMENT_LIMITS.maxCount
    expect(() =>
      validateUserAttachments(Array.from({ length: max }, (_, i) => (i % 2 ? imageRef() : fileRef()))),
    ).not.toThrow()
    expect(refusal(Array.from({ length: max + 1 }, () => fileRef())).code).toBe('ATTACHMENT_COUNT')
  })

  it('leaves references out of the inline byte total', () => {
    // 99 MiB inline plus a 95 MB reference: only the inline bytes count toward the 100 MiB cap.
    const inline = 'A'.repeat((99 * 1024 * 1024 * 4) / 3)
    expect(() =>
      validateUserAttachments([
        fileRef(),
        { type: 'file', mimeType: 'application/octet-stream', name: 'big.bin', data: inline },
      ]),
    ).not.toThrow()
  })

  it('refuses a malformed reference as attachment data', () => {
    for (const attachment of [
      { sha256: 'xyz', bytes: 1 },
      { sha256: 'B'.repeat(64), bytes: 1 },
      { sha256: `${sha}0`, bytes: 1 },
      { sha256: sha, bytes: -1 },
      { sha256: sha, bytes: 1.5 },
      { sha256: sha, bytes: Number.MAX_SAFE_INTEGER + 1 },
      { sha256: sha },
    ])
      expect(refusal([fileRef({ attachment })]).code, JSON.stringify(attachment)).toBe('ATTACHMENT_DATA')
  })

  it('keeps the file name and MIME rules for a referenced file', () => {
    expect(refusal([fileRef({ name: '' })]).code).toBe('ATTACHMENT_NAME')
    expect(refusal([fileRef({ mimeType: 'not a mime' })]).code).toBe('ATTACHMENT_NAME')
  })

  it('refuses a block that carries both inline data and a reference', () => {
    expect(refusal([fileRef({ data: 'eA==' })]).code).toBe('ATTACHMENT_DATA')
    expect(refusal([{ ...imageRef(), data: 'eA==' }]).code).toBe('ATTACHMENT_DATA')
    expect(attachmentForm({ ...imageRef(), data: 'eA==' })).toBeUndefined()
  })

  it('holds a reference image name to the file name rule', () => {
    for (const name of ['', 'a\u0007b.png', 'line\nbreak.png', 'x'.repeat(257)])
      expect(refusal([{ ...imageRef(), name }]).code, JSON.stringify(name)).toBe('ATTACHMENT_NAME')
    const { name: _name, ...unnamed } = imageRef()
    expect(() => validateUserAttachments([unnamed as Block])).not.toThrow()
  })

  it('refuses the lean transfer form, which is never something to submit', () => {
    expect(
      refusal([{ type: 'file', mimeType: 'application/zip', name: 'a.zip', dataOmitted: { bytes: 1 } }]).code,
    ).toBe('ATTACHMENT_DATA')
  })
})
