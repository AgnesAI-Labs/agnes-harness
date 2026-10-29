import { Context } from '@agnes/cordis'
import { ProviderError, type SandboxProvider, sandboxKind } from '@agnes/extension-api'
import { resolveProfile } from '@agnes/host-common/profile/resolve'
import { checkTemplateShape } from '@agnes/host-common/profile/templates'
import type { LockState, ResolveEnv } from '@agnes/host-common/profile/types'
import type { PackageModule } from '@agnes/host-extensions/assemble/packages'
import { installHostPlatform } from '@agnes/host-providers/adapters/platform-provider'
import { installSandboxProviders } from '@agnes/host-providers/adapters/sandbox-providers'
import { defineRemoteSandboxProvider } from '@agnes/sandbox-remote'
import { describe, expect, it } from 'vitest'
import { remoteSandboxModule } from '../../src/runtime/adapters/index.js'
import {
  degradeLoopbackServe,
  localSandboxProbe,
  loopbackServeSupported,
  sandboxBackendPackages,
} from '../../src/runtime/assemble/workspace-runtime.js'

const env: ResolveEnv = {
  platform: { os: 'linux', arch: 'x64', capabilities: {} },
  agnesVersion: '0.1.0',
  now: '2026-10-12T00:00:00Z',
}
const lock: LockState = {
  packages: {
    '@agnes/base': {
      version: '0.1.0',
      source: { type: 'builtin' as const, ref: 'builtin' },
      integrity: 'builtin:0.1.0',
      trust: 'builtin',
      enabled: true,
    },
    '@agnes/code': {
      version: '0.1.0',
      source: { type: 'builtin' as const, ref: 'builtin' },
      integrity: 'builtin:0.1.0',
      trust: 'builtin',
      enabled: true,
    },
    '@agnes/ai': {
      version: '0.1.0',
      source: { type: 'builtin' as const, ref: 'builtin' },
      integrity: 'builtin:0.1.0',
      trust: 'builtin',
      enabled: true,
    },
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
      {
        builtin: 'local-dev',
        lock,
        user: { name: 'p', providers: { sandbox: { provider: 'acme-remote' } } },
      },
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
    root.providers.registerHost(sandboxKind, 'acme', remote)
    expect(root.providers.catalog().find((entry) => entry.id === 'acme-remote')).toMatchObject({
      kind: 'sandbox',
      sourcePackage: 'acme',
      restartRequired: true,
      authority: 'open',
    })
    const other: SandboxProvider = { ...remote, id: 'other-remote' }
    root.providers.registerHost(sandboxKind, 'acme', other)
    await registry.select('acme-remote')
    await expect(registry.select('other-remote')).rejects.toThrow(/requires a restart/)
  })
})

describe('removed seam keys', () => {
  it('selects the sandbox in the providers table and refuses the places it was written before', async () => {
    const resolve = (user: object) => resolveProfile({ builtin: 'local-dev', lock, user: user as never }, env)
    await expect(resolve({ name: 'p', sandbox: { provider: 'acme-remote' } })).rejects.toThrow(
      /sandbox\.provider is selected with providers\.sandbox/,
    )
    await expect(resolve({ name: 'p', seams: { approval: { provider: 'x' } } })).rejects.toThrow(
      /seams was replaced by providers/,
    )
    await expect(resolve({ name: 'p', providers: { sandbox: '@agnes/base' } })).rejects.toThrow(
      /providers\.sandbox requires \{ provider/,
    )
    await expect(resolve({ name: 'p', providers: { platform: { provider: 'host' } } })).rejects.toThrow(
      /providers\.platform was removed/,
    )
    expect(() =>
      checkTemplateShape({ name: 't', schemaVersion: 1, providers: { platform: { provider: 'host' } } }, 't'),
    ).toThrow(/providers\.platform was removed/)
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
      root.providers.registerHost('platform' as never, 'acme', {
        id: 'host',
        version: '1.0.0',
        os: 'linux',
      } as never)
    expect(attempt).toThrow(ProviderError)
    expect(attempt).toThrow(/host-owned/)
    expect(() => root.providers.select('platform', 'host')).toThrow(/host-owned/)
  })
})

// DevBoard's coordinator preset requests loopback_serve. Where the listener cannot be provided the session
// still opens and only that capability is dropped; it is never replaced by anything broader.
it.each([
  ['darwin', false, true],
  ['win32', false, false],
  ['linux', false, false],
  ['darwin', true, false],
])('loopback_serve on %s (remote=%s) is supported: %s', (os, remote, supported) => {
  expect(loopbackServeSupported(os, remote)).toBe(supported)
})

describe('loopback_serve degrade', () => {
  const requested = {
    level: 'L1',
    access: 'restricted',
    loopbackServe: true,
    required: false,
    onUnavailable: 'deny',
    extraPaths: [],
    denyPaths: [],
    networkAllow: [],
  } as const

  it('drops only the loopback grant where it is unsupported and keeps every other limit', () => {
    const { loopbackServe: _grant, ...rest } = requested
    expect(degradeLoopbackServe(requested, false)).toEqual(rest)
  })

  it('leaves a supported host and a request without the grant untouched', () => {
    expect(degradeLoopbackServe(requested, true)).toBe(requested)
    const plain: { loopbackServe?: boolean; level: string } = { level: 'L1' }
    expect(degradeLoopbackServe(plain, false)).toBe(plain)
  })
})
