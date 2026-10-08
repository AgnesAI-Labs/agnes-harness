import { describe, expect, it } from 'vitest'
import { createPolicyExec } from '../../src/adapters/exec.js'

const okInner = {
  run: async () => ({ code: 0, stdout: '', stderr: '', truncated: false, timedOut: false }),
  killAll: async () => {},
}

describe('exec gate: remote posture', () => {
  it('lets a remote-posture request through even though onUnavailable is deny', async () => {
    const run = createPolicyExec(okInner, {
      boundDigest: () => 'd1',
      state: () => ({ backend: 'remote', onUnavailable: 'deny' }),
      authorizeCwd: async (cwd) => cwd,
    })
    const r = await run(['echo', 'hi'], { cwd: '/work', sandbox: { policyDigest: 'd1', backend: 'remote' } })
    expect(r.code).toBe(0)
  })

  it('still refuses a none-posture request when the preset does not allow unconfined', async () => {
    const run = createPolicyExec(okInner, {
      boundDigest: () => 'd1',
      state: () => ({ backend: 'none', onUnavailable: 'deny' }),
      authorizeCwd: async (cwd) => cwd,
    })
    await expect(
      run(['echo', 'hi'], { cwd: '/work', sandbox: { policyDigest: 'd1', backend: 'none' } }),
    ).rejects.toThrow(/no sandbox backend is available/)
  })
})
