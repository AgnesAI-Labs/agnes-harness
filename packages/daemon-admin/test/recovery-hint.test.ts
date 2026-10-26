import { expect, it } from 'vitest'
import { failureHelp, recoveryHint } from '../src/packages/operation-error.js'

it('names the file a refused recovery points at, with its repair step, within the fix hint limit', () => {
  const help = { fixHint: 'Restore the package.', docsUrl: 'https://docs.invalid' }
  expect(recoveryHint(help, { reason: 'tree-mismatch' })).toBe(help)
  expect(recoveryHint(help, { path: '/p/packages/a', reason: 'tree-mismatch' })).toEqual({
    fixHint: 'Restore the package. File: /p/packages/a.',
    docsUrl: 'https://docs.invalid',
  })
  expect(recoveryHint({ fixHint: '' }, { path: '/p/audit.jsonl', repair: 'Move it aside.' })).toEqual({
    fixHint: 'File: /p/audit.jsonl. Move it aside.',
  })
  expect(recoveryHint({ fixHint: '' }, { path: `/${'x'.repeat(600)}` }).fixHint).toHaveLength(512)
})

it('keeps the closed hint for a blocked capability and adds the file a refusal names', () => {
  const blocked = [{ references: ['capability-blocked'] }]
  expect(failureHelp(blocked, undefined, 'E_PACKAGE_STATE')).toEqual(failureHelp(blocked, {}, 'x'))
  expect(
    failureHelp([], { reason: 'tree-mismatch', path: '/p/packages/a' }, 'E_PACKAGE_STATE').fixHint,
  ).toContain('File: /p/packages/a.')
})
