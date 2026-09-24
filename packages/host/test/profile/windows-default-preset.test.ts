import { describe, expect, it } from 'vitest'
import { resolveProfile } from '../../src/profile/resolve.js'
import type { ProfileInputs, ResolveEnv } from '../../src/profile/types.js'

const env = (os: ResolveEnv['platform']['os']): ResolveEnv => ({
  platform: { os, arch: 'x64', capabilities: {} },
  agnesVersion: '0.1.0',
  now: '2026-09-14T00:00:00Z',
  homeDir: 'C:/agnes',
})
describe('Windows builtin default preset selection', () => {
  it.each(['linux', 'darwin', 'win32'] as const)('selects the builtin default for %s', async (os) => {
    const profile = await resolveProfile({ builtin: 'local-dev' }, env(os))
    const expected = os === 'win32' ? 'standard-windows' : 'standard'
    expect(profile.presets).toEqual({ default: expected, allowed: [expected] })
  })
  it.each([
    { default: 'standard' },
    { allowed: ['standard'] },
    {},
    { default: 'custom', allowed: ['custom'] },
  ])('preserves explicit user selection %j', async (presets) => {
    const inputs: ProfileInputs = { builtin: 'local-dev', user: { name: 'custom', presets } }
    const before = structuredClone(inputs)
    const profile = await resolveProfile(inputs, env('win32'))
    expect(profile.presets).toEqual({ default: 'standard', allowed: ['standard'], ...presets })
    expect(inputs).toEqual(before)
  })
  it('keeps a verified workspace fragment from changing the builtin selection', async () => {
    const profile = await resolveProfile(
      {
        builtin: 'local-dev',
        workspaceOverlay: {},
        lock: { packages: {}, workspace: { path: 'C:/repo', hash: 'hash', manifestId: 'fixture' } },
      },
      env('win32'),
    )
    expect(profile.presets).toEqual({ default: 'standard-windows', allowed: ['standard-windows'] })
  })
  it('does not change enterprise defaults or waive workspace verification', async () => {
    expect((await resolveProfile({ builtin: 'enterprise' }, env('win32'))).presets.default).toBe('standard')
    await expect(
      resolveProfile({ builtin: 'local-dev', workspaceOverlay: {} }, env('win32')),
    ).rejects.toThrow('E_WORKSPACE_UNTRUSTED')
  })
  it('keeps the resolved hash deterministic and leaves later POSIX resolution unchanged', async () => {
    const inputs = { builtin: 'local-dev' }
    const a = await resolveProfile(inputs, env('win32'))
    const b = await resolveProfile(inputs, env('win32'))
    expect(a.hash).toBe(b.hash)
    expect((await resolveProfile(inputs, env('linux'))).presets.default).toBe('standard')
  })
})
