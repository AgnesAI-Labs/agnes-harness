import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHost, type ProfileInputs, type ResolvedProfile, resolveProfile } from '@agnes/host'
import { describe, expect, it, vi } from 'vitest'
import { resolveLaunchResources } from '../launch/resources.js'
import { assembleLocalHost, enforceSafeMode, safeModeInputs } from '../src/boot/local.js'
import { TEST_LOCK, testDeps } from './boot-host.js'

vi.mock('@agnes/host', async (original) => ({
  ...(await original<typeof import('@agnes/host')>()),
  createHost: vi.fn(async () => {
    throw new Error('assembly reached')
  }),
}))
vi.mock('../launch/resources.js', () => ({ resolveLaunchResources: vi.fn() }))

it.each([false, true])('passes the packaged Node runtime only for SEA=%s', async (seaMode) => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-local-runtime-'))
  const sea = vi.spyOn(process.getBuiltinModule('node:sea'), 'isSea').mockReturnValue(seaMode)
  try {
    const runtimeNode = join(root, 'runtime', 'node.exe')
    vi.mocked(resolveLaunchResources).mockReturnValue({
      mode: 'sea',
      root,
      runtimeNode,
      daemonEntry: join(root, 'daemon.mjs'),
      workerEntry: join(root, 'worker.mjs'),
      webRoot: join(root, 'web'),
    })
    const profile = await resolveProfile(
      { builtin: 'local-dev', lock: TEST_LOCK },
      {
        platform: { os: 'win32', arch: 'x64', capabilities: {} },
        agnesVersion: '0.0.0',
        now: '2026-09-14T00:00:00Z',
      },
    )
    const { createHostImpl: _drop, ...deps } = testDeps(root)
    await expect(
      assembleLocalHost(
        profile,
        'local-dev',
        root,
        {
          ...deps,
          loader: {
            importPackage: async () => {
              throw new Error('unused loader')
            },
          },
        },
        {
          ask: async () => {
            throw new Error('unused prompter')
          },
        },
      ),
    ).rejects.toThrow('assembly reached')
    const options = vi.mocked(createHost).mock.calls.at(-1)?.[1]
    expect(options?.windowsNodeExecutable).toBe(seaMode ? runtimeNode : undefined)
    expect(resolveLaunchResources).toHaveBeenCalledTimes(seaMode ? 1 : 0)
  } finally {
    sea.mockRestore()
    vi.clearAllMocks()
    rmSync(root, { recursive: true, force: true })
  }
})

describe('--safe-mode', () => {
  const lockEntry = (ref: string) => ({
    source: { type: 'file', ref },
    version: '1.0.0',
    integrity: `sha256-${'a'.repeat(64)}`,
    trust: 'trusted' as const,
    enabled: true,
  })
  const lock = {
    packages: {
      'acme/user': lockEntry('/p/user'),
      'acme/overlay': lockEntry('/p/overlay'),
      'acme/rootplugin': lockEntry('/p/rootplugin'),
    },
    workspace: { path: '/w', hash: `sha256-${'b'.repeat(64)}`, manifestId: 'ws' },
  }
  const ref = (id: string) => ({ id, source: `/p/${id.split('/')[1]}`, version: '1.0.0', enabled: true })
  // A non-built-in package from the user profile, from the workspace overlay, and from a local plugin
  // root (bootLocal adds the root's inventory as user rows). Host ignores packages in the local and
  // flags layers, so those are not cases.
  const inputs = (): ProfileInputs => ({
    builtin: 'local-dev',
    lock,
    user: {
      name: 'u',
      packages: [{ id: '@agnes/base', source: 'builtin' }, ref('acme/user'), ref('acme/rootplugin')],
    },
    workspaceOverlay: { packages: [ref('acme/overlay')] },
  })
  const resolve = (input: ProfileInputs) =>
    resolveProfile(input, {
      platform: { os: 'darwin', arch: 'arm64', capabilities: {} },
      agnesVersion: '0.0.0',
      now: '2026-09-14T00:00:00Z',
    })
  const enabled = (profile: ResolvedProfile) =>
    Object.fromEntries(profile.packages.map((pkg) => [pkg.id, pkg.enabled]))
  const NON_BUILTIN = ['acme/user', 'acme/overlay', 'acme/rootplugin']

  it('leaves the packages enabled without the flag, which makes the cases below meaningful', async () => {
    const on = enabled(await resolve(inputs()))
    for (const id of ['@agnes/base', ...NON_BUILTIN]) expect(on[id], id).toBe(true)
  })

  it.each([
    ['the resolved profile', async () => enforceSafeMode(await resolve(inputs()))],
    ['the inputs', async () => resolve(safeModeInputs(inputs()))],
    ['both', async () => enforceSafeMode(await resolve(safeModeInputs(inputs())))],
  ])('switches off user, workspace-overlay and local-plugin-root packages via %s', async (_name, build) => {
    const off = enabled(await build())
    expect(off['@agnes/base']).toBe(true)
    for (const id of NON_BUILTIN) expect(off[id], id).toBe(false)
  })

  it('re-hashes the safe profile and refuses to start when a package could not be switched off', async () => {
    const resolved = await resolve(inputs())
    expect(enforceSafeMode(resolved).hash).not.toBe(resolved.hash)
    expect(() => enforceSafeMode(resolved, (pkg) => pkg)).toThrow(
      /could not switch off .*acme\/user.*refusing to start/,
    )
  })
})
