import { attachmentLink } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { nodeText } from '../src/node-text.js'

it('renders original file and image reference metadata in terminal history without their bytes', () => {
  const content = [
    attachmentLink({ sha256: 'a'.repeat(64), size: 100, mime: 'image/png' }, 'photo.png', {
      image: { width: 1, height: 1 },
    }),
    attachmentLink({ sha256: 'b'.repeat(64), size: 200, mime: 'application/pdf' }, 'report.pdf'),
  ]
  const text = nodeText({ kind: 'user', id: 'u', seq: 1, content })
  expect(text).toContain('[image: photo.png (image/png, 100 B)]')
  expect(text).toContain('[file: report.pdf (application/pdf, 200 B)]')
  expect(text).not.toContain('base64')
})
