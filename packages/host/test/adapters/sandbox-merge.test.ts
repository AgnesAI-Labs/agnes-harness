import { Context } from '@agnes/cordis'
import { ProviderError, type SandboxProvider } from '@agnes/extension-api'
import { resolveProfile } from '@agnes/host-common/profile/resolve'
import { checkTemplateShape } from '@agnes/host-common/profile/templates'
import type { LockState, ResolveEnv } from '@agnes/host-common/profile/types'
import type { PackageModule } from '@agnes/host-extensions/assemble/packages'
import { installHostPlatform } from '@agnes/host-providers/adapters/platform-provider'
import { installSandboxProviders } from '@agnes/host-providers/adapters/sandbox-providers'
import { defineRemoteSandboxProvider } from '@agnes/sandbox-remote'
import { describe, expect, it } from 'vitest'
import { remoteSandboxModule } from '../../src/runtime/adapters/index.js'
import { localSandboxProbe, sandboxBackendPackages } from '../../src/runtime/assemble/workspace-runtime.js'

const env: ResolveEnv = {
  platform: { os: 'linux', arch: 'x64', capabilities: {} },
  agnesVersion: '0.1.0',
  now: '2026-10-12T00:00:00Z',
}
const lock: LockState = {
  packages: {
    '@agnes/base': { version: '0.1.0', integrity: 'sha512-b', trust: 'builtin', enabled: true },
    '@agnes/code': { version: '0.1.0', integrity: 'sha512-c', trust: 'builtin', enabled: true },
    '@agnes/ai': { version: '0.1.0', integrity: 'sha512-a', trust: 'builtin', enabled: true },
  },
}
const probe = (async () => ({})) as unknown as NonNullable<PackageModule['sandboxWorkspaceProbe']>
const remote = defineRemoteSandboxProvider({
  id: 'acme-remote',
  version: '1.0.0',
  openTransport: async () => {
    throw new Error('not opened here')
  },
})

describe('sandbox provider resolution', () => {
  it('finds the selected remote provider by id, and nothing for the local default', () => {
    const modules = new Map<string, PackageModule>([['acme', { id: 'acme', sandboxProvider: remote }]])
    expect(remoteSandboxModule({ sandbox: { provider: 'acme-remote' } }, modules)).toMatchObject({
      packageId: 'acme',
    })
    expect(remoteSandboxModule({}, modules)).toBeUndefined()
    expect(remoteSandboxModule({ sandbox: { provider: 'other' } }, modules)).toBeUndefined()
  })

  it('takes the local probe only from a builtin package', async () => {
    const profile = await resolveProfile({ builtin: 'local-dev', lock }, env)
    const evil = { id: 'evil', sandboxWorkspaceProbe: probe }
    const base = { id: '@agnes/base', sandboxWorkspaceProbe: probe }
    expect(localSandboxProbe(profile, new Map([['evil', evil]]))).toBeUndefined()
    expect(localSandboxProbe(profile, new Map([['@agnes/base', base]]))).toBe(probe)
  })

  it('treats the probe supplier and the selected provider package as immutable backend code', async () => {
    const profile = await resolveProfile(
      { builtin: 'local-dev', lock, user: { name: 'p', sandbox: { provider: 'acme-remote' } } },
      env,
    )
    const modules = new Map<string, PackageModule>([
      ['@agnes/base', { id: '@agnes/base', sandboxWorkspaceProbe: probe }],
      ['acme', { id: 'acme', sandboxProvider: remote }],
      ['other', { id: 'other' }],
    ])
    expect(sandboxBackendPackages(profile, modules)).toEqual(['@agnes/base', 'acme'])
  })

  it('registers a package-exported provider in the sandbox catalog and keeps selection restart-bound', async () => {
    const root = new Context()
    const registry = installSandboxProviders(root)
    root.providers.register('sandbox', 'acme', remote)
    expect(root.providers.catalog().find((entry) => entry.id === 'acme-remote')).toMatchObject({
      kind: 'sandbox',
      sourcePackage: 'acme',
      restartRequired: true,
      authority: 'open',
    })
    const other: SandboxProvider = { ...remote, id: 'other-remote' }
    root.providers.register('sandbox', 'acme', other)
    await registry.select('acme-remote')
    await expect(registry.select('other-remote')).rejects.toThrow(/requires a restart/)
  })
})

describe('removed seam keys', () => {
  it('refuses seams.sandbox and seams.platform with the replacement', async () => {
    await expect(
      resolveProfile(
        { builtin: 'local-dev', lock, user: { name: 'p', seams: { sandbox: '@agnes/base' } as never } },
        env,
      ),
    ).rejects.toThrow(/seams\.sandbox was removed; select the sandbox with the top-level/)
    await expect(
      resolveProfile(
        { builtin: 'local-dev', lock, user: { name: 'p', seams: { platform: '@agnes/host' } as never } },
        env,
      ),
    ).rejects.toThrow(/seams\.platform was removed/)
    expect(() =>
      checkTemplateShape({ name: 't', schemaVersion: 1, seams: { sandbox: '@agnes/base' } }, 't'),
    ).toThrow(/seams\.sandbox was removed/)
  })

  it('does not expose either key on a resolved profile', async () => {
    const profile = await resolveProfile({ builtin: 'local-dev', lock }, env)
    expect(Object.keys(profile.seams)).not.toContain('sandbox')
    expect(Object.keys(profile.seams)).not.toContain('platform')
  })
})

describe('platform is host-only', () => {
  it('is listed read-only with host authority', () => {
    const root = new Context()
    installHostPlatform(root, 'linux')
    expect(root.providers.catalog().find((entry) => entry.kind === 'platform')).toMatchObject({
      id: 'host',
      sourcePackage: '@agnes/host',
      authority: 'host',
      restartRequired: true,
      active: false,
    })
  })

  it('refuses registration and selection through the package path', () => {
    const root = new Context()
    installHostPlatform(root, 'linux')
    const attempt = () =>
      root.providers.register('platform' as never, 'acme', {
        id: 'host',
        version: '1.0.0',
        os: 'linux',
      } as never)
    expect(attempt).toThrow(ProviderError)
    expect(attempt).toThrow(/host-owned/)
    expect(() => root.providers.select('platform', 'host')).toThrow(/host-owned/)
  })
})
