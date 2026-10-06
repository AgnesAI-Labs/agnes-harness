import {
  AttachmentValidationError,
  USER_MESSAGE_ATTACHMENT_LIMITS,
  validateUserAttachments,
} from '@agnes/protocol-validation'
import { expect, it } from 'vitest'
import { MAX_FRAME_BYTES } from '../src/index.js'

it('accepts exactly 100 MiB of attachments, fits the transport, and rejects an extra byte', () => {
  const size = 100 * 1024 * 1024
  expect(USER_MESSAGE_ATTACHMENT_LIMITS.maxAggregateBytes).toBe(size)
  const content = [
    {
      type: 'file',
      name: 'large.bin',
      mimeType: 'application/octet-stream',
      data: Buffer.alloc(size).toString('base64'),
    },
  ]
  expect(() => validateUserAttachments(content)).not.toThrow()
  expect(
    Buffer.byteLength(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'test',
        method: '_agnes/v1/submit',
        params: { clientId: 'test', commandId: 'test', kind: 'startTask', payload: { content } },
      }),
    ),
  ).toBeLessThan(MAX_FRAME_BYTES - 4096)
  let overLimit: unknown
  try {
    validateUserAttachments([
      ...content,
      {
        type: 'file',
        name: 'extra.txt',
        mimeType: 'text/plain',
        data: 'eA==',
      },
    ])
  } catch (error) {
    overLimit = error
  }
  expect(overLimit).toBeInstanceOf(AttachmentValidationError)
  expect((overLimit as AttachmentValidationError).code).toBe('ATTACHMENT_BYTES')
  expect((overLimit as Error).message).toMatch(/100 MiB/)
}, 30000)
