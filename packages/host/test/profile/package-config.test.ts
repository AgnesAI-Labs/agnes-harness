import { validateProfileFragment, validateProfileManifest, validateResolvedProfile } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { mergePackages, resolveProfile } from '../../src/profile/resolve.js'

const env = {
  platform: { os: 'linux' as const, arch: 'x64', capabilities: {} },
  agnesVersion: '0.1.0',
  now: '2026-09-17',
}
const config = { endpoint: 'https://vendor.example', nested: { region: 'test' }, enabled: true }
const pkg = { id: '@agnes/base', source: 'builtin', config }

describe('B1 package config', () => {
  it('accepts JSON config in a trusted manifest and resolved profile, hashes and freezes it', async () => {
    expect(validateProfileManifest({ name: 'p', packages: [pkg] }).ok).toBe(true)
    const p = await resolveProfile({ builtin: 'local-dev', user: { name: 'p', packages: [pkg] } }, env)
    const plain = await resolveProfile({ builtin: 'local-dev', user: { name: 'p' } }, env)
    expect(p.packages.find((x) => x.id === pkg.id)?.config).toEqual(config)
    expect(p.hash).not.toBe(plain.hash)
    expect(validateResolvedProfile(p).ok).toBe(true)
    expect(Object.isFrozen(p.packages.find((x) => x.id === pkg.id)?.config?.nested)).toBe(true)
  })
  it('replaces config as a whole in a trusted layer', () => {
    const merged = mergePackages([pkg], [{ ...pkg, config: { only: 1 } }], 'user')
    expect(merged[0]?.config).toEqual({ only: 1 })
  })
  it('rejects workspace config in schema and resolution even with a verified lock', async () => {
    expect(validateProfileFragment({ packages: [pkg] }).ok).toBe(false)
    await expect(
      resolveProfile(
        {
          builtin: 'local-dev',
          workspaceOverlay: { packages: [pkg] },
          lock: {
            packages: {},
            workspace: { path: '/w', hash: 'sha256-test', manifestId: 'test' },
          },
        },
        env,
      ),
    ).rejects.toMatchObject({ code: 'E_WORKSPACE_UNTRUSTED' })
  })
  it('carries config on a locked third-party package too', async () => {
    const p = await resolveProfile(
      {
        builtin: 'local-dev',
        user: { name: 'p', packages: [{ ...pkg, id: '@acme/vendor' }] },
        lock: {
          packages: {
            '@acme/vendor': { version: '1', integrity: 'sha512-test', trust: 'trusted', enabled: true },
          },
        },
      },
      env,
    )
    expect(p.packages.find((x) => x.id === '@acme/vendor')?.config).toEqual(config)
  })
})
