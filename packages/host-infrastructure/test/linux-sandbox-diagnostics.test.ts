import { expect, it } from 'vitest'
import { probeLinuxSandboxSupport } from '../src/adapters/linux-sandbox-diagnostics.js'

it.each([
  { code: undefined, bubblewrap: 'installed', abi: 6, expected: 6 },
  { code: 'ENOENT', bubblewrap: 'missing', abi: 0, expected: 0 },
  { code: 'EPERM', bubblewrap: 'unknown', abi: -1, expected: 'unknown' },
  { code: 'ETIMEDOUT', bubblewrap: 'unknown', abi: Number.NaN, expected: 'unknown' },
])(
  'reports availability without attesting enforcement: $code',
  async ({ code, bubblewrap, abi, expected }) => {
    const result = await probeLinuxSandboxSupport({
      bubblewrap: async () => {
        if (code) throw Object.assign(new Error('private stderr'), { code })
      },
      landlockAbi: () => abi,
    })
    expect(result).toEqual({ bubblewrap, landlockAbi: expected })
  },
)
it('keeps denied or missing native diagnostics unknown without exposing output', async () => {
  expect(
    await probeLinuxSandboxSupport({
      bubblewrap: async () => {},
      landlockAbi: () => {
        throw new Error('secret')
      },
    }),
  ).toEqual({ bubblewrap: 'installed', landlockAbi: 'unknown' })
})
