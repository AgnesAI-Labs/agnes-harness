import { validateAgainst, validateCredential } from '@agnes/protocol'
import { Auth } from '@agnes/protocol/gen/agnes-v1'
import { expect, it } from 'vitest'
import { localAuth } from '../src/auth.js'

it('accepts the real SDK default local credential through the old Auth and new Credential contracts', async () => {
  const credential = await localAuth().build({ clientId: 'fixture', initializeParams: {} })
  expect(credential).toEqual({ kind: 'local' })
  expect(validateAgainst(Auth, credential).ok).toBe(true)
  expect(validateCredential(credential).ok).toBe(true)
})
