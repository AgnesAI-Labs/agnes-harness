import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHost, type HostOptions, type ResolvedProfile } from '@agnes/host'
import {
  activeRuntimePinId,
  createPackageManager,
  emptyLock,
  parseSource,
  writeLock,
} from '@agnes/package-manager'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assembleLocalHost } from '../src/boot/local.js'

vi.mock('@agnes/host', async (original) => ({
  ...(await original<typeof import('@agnes/host')>()),
  createHost: vi.fn(async () => ({}) as never),
}))
vi.mock('@agnes/package-manager', async (original) => ({
  ...(await original<typeof import('@agnes/package-manager')>()),
  createPackageManager: vi.fn(),
}))

const prompter = {} as never
let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agnes-boot-snapshots-'))
})
afterEach(() => {
  vi.clearAllMocks()
  rmSync(home, { recursive: true, force: true })
})

const pkg = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  integrity: `sha256-${id}`,
  trust: 'trusted',
  enabled: true,
  ...over,
})
const profile = (packages: unknown[]) =>
  ({
    name: 'local-dev',
    dataDir: join(home, 'data'),
    cacheDir: join(home, 'cache'),
    packages,
    presets: { default: 'standard', allowed: ['standard'] },
  }) as unknown as ResolvedProfile
const source = (packageId: string, integrity: string) => ({
  snapshot: { snapshotId: integrity, packageId, integrity },
  generation: 1,
  trusted: true,
})
const deps = () => ({ env: {}, home, cwd: home, agnesVersion: '1.2.3', log: () => undefined })
const handedToHost = (): HostOptions => vi.mocked(createHost).mock.calls[0]?.[1] as HostOptions

describe('the embedded host is handed the snapshots of the packages the profile names', () => {
  it('admits a snapshot only for an enabled, non-builtin package at the integrity the profile pins', async () => {
    const lookup = vi.fn(async () => [
      source('@acme/track', 'sha256-@acme/track'),
      source('@acme/track-moved', 'sha256-different'),
      source('@acme/not-in-profile', 'sha256-@acme/not-in-profile'),
      source('@acme/disabled', 'sha256-@acme/disabled'),
      source('@agnes/base', 'sha256-@agnes/base'),
    ])
    vi.mocked(createPackageManager).mockReturnValue({ runtimePluginSnapshots: lookup } as never)

    await assembleLocalHost(
      profile([
        pkg('@acme/track'),
        pkg('@acme/track-moved'),
        pkg('@acme/disabled', { enabled: false }),
        pkg('@agnes/base', { trust: 'builtin' }),
      ]),
      'local-dev',
      home,
      deps(),
      prompter,
    )

    const options = handedToHost()
    expect(options.runtimePluginSnapshots?.map((entry) => entry.snapshot.packageId)).toEqual(['@acme/track'])
    // Read the way the daemon's workers read it: the same store, from the profile directory.
    expect(createPackageManager).toHaveBeenCalledWith({
      dataDir: join(home, 'data'),
      agnesVersion: '0.0.0',
    })
    expect(lookup).toHaveBeenCalledWith(join(home, 'profiles', 'local-dev'))
    // Later targets re-read the store, as they do under a worker.
    expect(await options.runtimePluginSources?.()).toHaveLength(5)
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('does not touch the package store for a profile that names only built-in or disabled packages', async () => {
    await assembleLocalHost(
      profile([pkg('@agnes/base', { trust: 'builtin' }), pkg('@acme/off', { enabled: false })]),
      'local-dev',
      home,
      deps(),
      prompter,
    )
    expect(createPackageManager).not.toHaveBeenCalled()
    expect(handedToHost()).not.toHaveProperty('runtimePluginSnapshots')
    expect(handedToHost()).not.toHaveProperty('runtimePluginSources')
  })

  it('leaves package sources to a caller that supplies its own loader', async () => {
    await assembleLocalHost(
      profile([pkg('@acme/track')]),
      'local-dev',
      home,
      { ...deps(), loader: { load: async () => ({}) } as never },
      prompter,
    )
    expect(createPackageManager).not.toHaveBeenCalled()
    expect(handedToHost()).not.toHaveProperty('runtimePluginSnapshots')
  })

  it('does not hide a failure to read the store behind a missing-snapshot message', async () => {
    const failure = Object.assign(new Error('E_LOCK_MISMATCH: runtime source changed during snapshot read'), {
      code: 'E_LOCK_MISMATCH',
    })
    vi.mocked(createPackageManager).mockReturnValue({
      runtimePluginSnapshots: async () => {
        throw failure
      },
    } as never)
    await expect(
      assembleLocalHost(profile([pkg('@acme/track')]), 'local-dev', home, deps(), prompter),
    ).rejects.toBe(failure)
    expect(createHost).not.toHaveBeenCalled()
  })
})

describe('against a real package store', () => {
  it('finds the snapshot of an installed, trusted, pinned package, which the embedded host never looked for', async () => {
    const real = await vi.importActual<typeof import('@agnes/package-manager')>('@agnes/package-manager')
    vi.mocked(createPackageManager).mockImplementation(real.createPackageManager)
    const id = 'acme/track'
    const dataDir = join(home, 'data')
    const profileDir = join(home, 'profiles', 'local-dev')
    const sourceDir = join(home, 'source')
    mkdirSync(profileDir, { recursive: true })
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(
      join(sourceDir, 'package.json'),
      JSON.stringify({
        name: id,
        version: '1.0.0',
        license: 'MIT',
        dependencies: {},
        exports: './index.mjs',
        agnes: { plugins: [{ export: 'runtime', id: 'ext:acme/track', runtime: 'in-process' }] },
      }),
    )
    writeFileSync(join(sourceDir, 'index.mjs'), 'export const runtime = { apply() { return {} } }\n')
    writeLock(profileDir, {
      ...emptyLock('local-dev', '0.1.0'),
      resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
      seams: Object.fromEntries(
        [
          'approval',
          'checkpoint',
          'ledger',
          'sandbox',
          'verifier',
          'repair',
          'artifacts',
          'principals',
          'platform',
          'harness',
        ].map((name) => [name, '@agnes/base']),
      ),
      policySnapshot: { capabilityCeiling: ['tools'], workspacePackages: 'require-project-trust' },
    })
    const installer = real.createPackageManager({
      dataDir,
      cwd: home,
      agnesVersion: '0.1.0',
      now: () => '2026-09-13T00:00:00Z',
      references: async () => [],
    })
    const preview = await installer.inspect(profileDir, parseSource('file:./source'))
    await installer.install(profileDir, parseSource('file:./source'), {
      expectedIntegrity: preview.integrity,
    })
    const row = (await installer.inventory(profileDir)).packages[0]
    if (!row?.entry.treeIntegrity) throw new Error('package was not installed')
    await installer.trust(profileDir, id, {
      integrity: row.entry.integrity,
      capabilityHash: row.capabilityHash,
    })
    const pinId = activeRuntimePinId({ packageId: id, integrity: row.entry.integrity })
    await installer.pinRuntimeSnapshot(profileDir, {
      pinId,
      operationId: pinId,
      packageId: id,
      purpose: 'active',
      selector: {
        kind: 'installed',
        expectedIntegrity: row.entry.integrity,
        expectedTreeIntegrity: row.entry.treeIntegrity,
      },
    })

    await assembleLocalHost(
      profile([pkg(id, { integrity: row.entry.integrity })]),
      'local-dev',
      home,
      deps(),
      prompter,
    )

    expect(handedToHost().runtimePluginSnapshots).toEqual([
      expect.objectContaining({
        trusted: true,
        snapshot: expect.objectContaining({ packageId: id, integrity: row.entry.integrity }),
      }),
    ])

    // The same package at an integrity the profile does not pin is not handed over.
    vi.mocked(createHost).mockClear()
    await assembleLocalHost(
      profile([pkg(id, { integrity: 'sha512-another-build' })]),
      'local-dev',
      home,
      deps(),
      prompter,
    )
    expect(handedToHost().runtimePluginSnapshots).toEqual([])
  })
})
