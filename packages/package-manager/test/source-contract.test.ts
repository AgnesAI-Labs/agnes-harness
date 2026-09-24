import { validatePackageAdminData } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { parseSource } from '../src/sources.js'

const commit = 'a'.repeat(40)
const refs = [
  'npm:pkg@1.0.0',
  'npm:@scope/pkg@1.0.0+build.1',
  'npm:pkg@latest',
  'npm:pkg@^1.0.0',
  `npm:pkg@1.0.0-${'a'.repeat(65)}`,
  `npm:pkg@1.0.0-${'a'.repeat(58)}`,
  'file:./some folder',
  'file:./a/../b',
  'file:./a/./b',
  'file:./a//b',
  'file:/tmp/a',
  'workspace:extensions/a',
  'workspace:other/a',
  ...[
    'https://example.com/a',
    'https://[::1]/a',
    'https://[::::]/a',
    'https://example.com:99999/a',
    'https://example.com:000080/a',
    'https://user:password@example.com/a',
    'http://example.com/a',
    'https://example.com/a?query=1',
    'https://example.com/a#extra',
    'https://example.com/@scope/a',
  ].map((url) => `git:${url}#${commit}`),
]
it.each(refs)('management source contract agrees with the existing PackageManager parser: %s', (ref) => {
  let accepted = false
  try {
    parseSource(ref)
    accepted = true
  } catch {
    /* expected rejection */
  }
  const type = ref.slice(0, ref.indexOf(':'))
  expect(validatePackageAdminData('PackageSource', { type, ref }).ok).toBe(accepted)
})
