import { testFsPolicy } from '@agnes/core/testkit'
import { describe, expect, it, vi } from 'vitest'
import { createPolicyExec } from '../../src/adapters/exec.js'

const okInner = {
  run: async () => ({ code: 0, stdout: '', stderr: '', truncated: false, timedOut: false }),
  killAll: async () => {},
}

describe('exec gate: remote posture', () => {
  it.each([
    [[], { mode: 'deny', hosts: [] }],
    [['*'], { mode: 'allow', hosts: [] }],
    [['example.com'], { mode: 'hosts', hosts: ['example.com'] }],
  ])(
    'carries the authorized network scope %j without broadening file writes',
    async (networkAllow, network) => {
      const policy = { ...testFsPolicy('/work'), networkAllow: networkAllow as string[] }
      const inner = vi.fn(okInner.run)
      const run = createPolicyExec(
        { ...okInner, run: inner },
        {
          policy: () => policy,
          boundDigest: () => policy.digest,
          state: () => ({ backend: 'l1', onUnavailable: 'deny', access: 'workspace-write' }),
          authorizeCwd: async (cwd) => cwd,
        },
      )
      await run(['echo', 'hi'], { cwd: '/work', sandbox: { policyDigest: policy.digest, backend: 'l1' } })
      expect(inner).toHaveBeenCalledWith(
        ['echo', 'hi'],
        expect.objectContaining({
          sandbox: expect.objectContaining({
            policy: expect.objectContaining({
              network,
              fsWrite: expect.objectContaining({ allow: ['/work'] }),
            }),
          }),
        }),
      )
    },
  )

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
