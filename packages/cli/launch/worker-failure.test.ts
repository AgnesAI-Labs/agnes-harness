import { HostError } from '@agnes/host'
import { expect, it } from 'vitest'
import { workerFailureCode } from './worker-failure.js'

it('reports known startup codes without exposing message, detail or stack', () => {
  expect(workerFailureCode(new HostError('E_SEAM_INIT', 'startup failed'))).toBe('E_SEAM_INIT')
  expect(
    workerFailureCode(Object.assign(new Error('secret content'), { code: 'EPERM', detail: 'secret' })),
  ).toBe('EPERM')
})
it('does not echo unknown codes or invoke a code getter', () => {
  for (const error of [
    null,
    'secret',
    new Error('secret'),
    { code: 'secret' },
    {
      get code() {
        throw new Error('getter called')
      },
    },
  ])
    expect(workerFailureCode(error)).toBe('UNKNOWN')
})
