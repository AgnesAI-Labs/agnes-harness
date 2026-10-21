import { expect, it } from 'vitest'
import { summarizeCall } from '../src/step/summarize-call.js'

it.each([
  ['write', { content: 'private content', path: 'src/a.ts' }, 'Write file · src/a.ts'],
  ['edit', { edits: [{ oldText: 'private', newText: 'body' }], path: 'src/a.ts' }, 'Edit file · src/a.ts'],
  ['read', { path: 'a.md', offset: 10, limit: 5 }, 'Read file · a.md'],
  ['shell', { command: 'echo SECRET', cwd: '/private' }, 'Run command'],
  ['shell', { command: 'echo SECRET', description: 'Verify the report' }, 'Run command · Verify the report'],
  ['custom', { sql: 'select private', limit: 3 }, 'custom'],
  ['custom', [1, 2], 'custom'],
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
  expect(
    summarizeCall('business_register', { projectId: 'PRJ-009', body: 'private' }, undefined, '登记项目'),
  ).toBe('登记项目 · PRJ-009')
  expect(
    summarizeCall(
      'business_register',
      { gateId: 'GATE-005' },
      { title: '提交发布评审', description: '请质量负责人核验' },
    ),
  ).toBe('提交发布评审 · GATE-005 · 请质量负责人核验')
  expect(
    summarizeCall('create_project', { title: '本机网页验证', body: 'private' }, undefined, '新建项目'),
  ).toBe('新建项目 · 本机网页验证')
})

it('bounds long summaries without splitting a surrogate pair', () => {
  const summary = summarizeCall('custom', { path: 'x'.repeat(1987) + '😀tail'.repeat(1000) })
  expect(summary.length).toBeLessThanOrEqual(2000)
  expect(summary).toMatch(/…$/)
  expect(summary).not.toMatch(/[\ud800-\udbff]…/)
})
