import { describe, expect, it } from 'vitest'
import { validateRuntime } from '../../../protocol/src/runtime/index.js'
import { cleanup } from './network-secrets-fixture.js'
import { fixture } from './sandbox-exec-fixture.js'

describe('sandbox service boundary', () => {
  it('refuses malformed requests before any probe and drains repeat close', async () => {
    const f = await fixture()
    try {
      expect(validateRuntime('FsPolicySnapshot', f.policy).ok).toBe(true)
      expect(validateRuntime('SandboxCreateRequest', f.createInput).ok).toBe(true)
      const bad = await f.sandbox.create({}, f.auth.call())
      expect(bad.ok).toBe(false)
      await f.sandbox.close()
      expect((await f.sandbox.create(f.createInput, f.auth.call())).ok).toBe(false)
      await f.sandbox.close()
    } finally {
      await f.close()
      cleanup(f.directory)
    }
  })
})
