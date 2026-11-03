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

it('renders an experience review by state, reason and changed entry names', () => {
  expect(
    nodeText({
      kind: 'refinement-run',
      id: 'r',
      seq: 2,
      runId: 'run-1',
      state: 'applied',
      trigger: 'manual',
      edits: [
        { op: 'upsert', kind: 'memory', id: 'build' },
        { op: 'delete', kind: 'skill', id: 'old' },
      ],
      appliedSeq: 4,
      withdrawn: true,
    }),
  ).toBe(
    'Experience review (manual) saved changes. Saved: memory/build. Removed: skill/old. Withdrawn since.',
  )
  expect(
    nodeText({
      kind: 'refinement-run',
      id: 'r2',
      seq: 6,
      runId: 'run-2',
      state: 'rejected',
      trigger: 'model',
      reason: 'no-evidence',
    }),
  ).toBe('Experience review (model) was not applied. Reason: no-evidence.')
})
