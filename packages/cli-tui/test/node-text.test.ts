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

it('save rows render initiator, outcome and reason without text', () => {
  const save = (extra: object) =>
    nodeText({ kind: 'refinement-save', id: 's', seq: 3, state: 'refused', ...extra } as never)
  expect(save({ state: 'saved', initiator: 'auto', target: 'workspace-memory' })).toBe(
    'Save to workspace: saved to workspace memory (asked by: automatic).',
  )
  expect(save({ reason: 'memory-full', initiator: 'model' })).toMatch(
    /not saved \(asked by: the model\)\. Reason: workspace memory is full.*free space/,
  )
  expect(save({ state: 'awaiting-approval', initiator: 'model' })).toMatch(/Needs attention.*7 days/)
  expect(save({ state: 'unknown' })).toMatch(/hidden.*until you repair or remove it/)
  expect(save({ reason: 'approval-expired' })).toMatch(/not answered within 7 days/)
  expect(save({ reason: 'user-revoked' })).toMatch(/removed or withdrew this before/)
  expect(save({ reason: 'conflict' })).toMatch(/nothing was overwritten/)
  expect(save({ reason: 'unavailable' })).toMatch(/not available right now/)
  expect(save({ reason: 'a-later-reason' })).toContain('Reason: a-later-reason.')
  // A promotion to user memory: what it reaches, where to withdraw it, and whether this workspace reads it.
  const user = { initiator: 'auto', target: 'user-memory' }
  expect(save({ ...user, state: 'saved', userMemoryRead: true })).toMatch(
    /^Task experience: saved to user memory \(all workspaces\) \(asked by: automatic.*withdraw it in the Web memory settings/,
  )
  expect(save({ ...user, state: 'saved', userMemoryRead: true })).not.toMatch(/does not read user memory/)
  expect(save({ ...user, state: 'saved', userMemoryRead: false })).toMatch(
    /This workspace does not read user memory/,
  )
  expect(save({ ...user, reason: 'user-memory-budget' })).toMatch(
    /not saved to user memory.*Reason: user memory has no room for it/,
  )
  expect(save({ ...user, reason: 'model-cannot-write-user' })).toMatch(
    /an earlier version did not let the model write user memory/,
  )
  // At a person's request: the line says so, with the same notes.
  const asked = { initiator: 'user', target: 'user-memory' }
  expect(save({ ...asked, state: 'saved', userMemoryRead: false })).toMatch(
    /^Task experience: saved to user memory at your request \(all workspaces\)\. .*withdraw it in the Web memory settings.*does not read user memory/,
  )
  expect(save({ ...asked, state: 'saved' })).not.toMatch(/asked by/)
  expect(save({ ...asked, reason: 'user-revoked' })).toMatch(/withdrew this from user memory before/)
})
