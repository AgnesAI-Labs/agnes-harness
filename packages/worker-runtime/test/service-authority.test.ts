import { expect, it } from 'vitest'
import { createWorkerServiceAuthority } from '../src/service-authority.js'

it('accepts only bounded supervisor-verified session read scopes and preserves legacy envelopes', async () => {
  const authority = createWorkerServiceAuthority()
  const envelope = {
    kind: 'surface-service',
    source: 'client-web',
    subjectCredential: { kind: 'local' },
    grants: [{ extension: 'plugin/0123456789abcdef', name: 'reports.read', range: '*' }],
  }
  expect(await authority.resolve(envelope)).not.toHaveProperty('sessionReads')
  const verified = await authority.resolve({ ...envelope, sessionReads: ['owned-session'] })
  expect(verified.sessionReads).toEqual(['owned-session'])
  expect(Object.isFrozen(verified.sessionReads)).toBe(true)
  for (const sessionReads of [
    'owned-session',
    [''],
    ['x'.repeat(513)],
    Array.from({ length: 17 }, (_, n) => String(n)),
    ['duplicate', 'duplicate'],
  ])
    await expect(authority.resolve({ ...envelope, sessionReads })).rejects.toThrow(
      'invalid service authority',
    )
  await expect(authority.resolve({ ...envelope, actor: { role: 'admin' } })).rejects.toThrow(
    'invalid service authority',
  )
})
