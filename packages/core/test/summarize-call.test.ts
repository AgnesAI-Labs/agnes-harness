import { expect, it } from 'vitest'
import { summarizeCall } from '../src/step/summarize-call.js'

it.each([
  ['write', { content: 'private content', path: 'src/a.ts' }, 'Write file · src/a.ts'],
  ['edit', { edits: [{ oldText: 'private', newText: 'body' }], path: 'src/a.ts' }, 'Edit file · src/a.ts'],
  ['read', { path: 'a.md', offset: 10, limit: 5 }, 'Read file · a.md'],
  ['shell', { command: 'echo SECRET', cwd: '/private' }, 'Run command'],
  ['shell', { command: 'echo SECRET', description: 'Verify the report' }, 'Run command · Verify the report'],
  ['custom', { sql: 'select private', limit: 3 }, 'Run tool'],
  ['custom', [1, 2], 'Run tool'],
])('names %s by human action and scope without exposing code or bodies', (name, args, expected) => {
  expect(summarizeCall(name, args)).toBe(expected)
})

it('uses declared action, scope, summary and purpose without repeating the tool identifier', () => {
  const args = { command: 'echo SECRET', cwd: '/private', object: 'record-1', token: 'hidden' }
  expect(
    summarizeCall('plain_review', args, {
      title: 'Review record',
      description: 'Check before signing',
      summary: 'Prepare for review',
    }),
  ).toBe('Review record · record-1 · Prepare for review · Check before signing')
})

it('bounds long summaries without splitting a surrogate pair', () => {
  const summary = summarizeCall('custom', { path: 'x'.repeat(1987) + '😀tail'.repeat(1000) })
  expect(summary.length).toBeLessThanOrEqual(2000)
  expect(summary).toMatch(/…$/)
  expect(summary).not.toMatch(/[\ud800-\udbff]…/)
})
