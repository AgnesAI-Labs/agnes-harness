import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InstalledInventory, InstalledPackage } from '../src/inventory.js'
import {
  activeRuntimePinId,
  createLivePackageSnapshotVerifier,
  createPackageSnapshotVerifier,
  installedRuntimeSnapshotId,
  loadPackagePlugins,
  runtimePluginSnapshotsFromInventory,
  runtimePluginSnapshotsFromPins,
} from '../src/package-plugin-loader.js'
import type { RuntimePin, RuntimeSnapshot } from '../src/runtime-snapshots.js'
import { hashDirectory } from '../src/sources.js'

const roots: string[] = []

function packageSnapshot(
  plugins: unknown,
  extraAgnes: Record<string, unknown> = {},
): { directory: string; snapshot: RuntimeSnapshot } {
  const directory = mkdtempSync(join(tmpdir(), 'agnes-package-plugin-'))
  roots.push(directory)
  writeFileSync(
    join(directory, 'package.json'),
    `${JSON.stringify({
      name: '@acme/example',
      version: '1.2.3',
      agnes: { ...extraAgnes, ...(plugins === undefined ? {} : { plugins }) },
    })}\n`,
  )
  const treeIntegrity = hashDirectory(directory, { exclude: [] })
  return {
    directory,
    snapshot: Object.freeze({
      snapshotId: `sha256-${'1'.repeat(64)}`,
      profile: 'default',
      packageId: '@acme/example',
      version: '1.2.3',
      integrity: `sha256-${'2'.repeat(64)}`,
      treeIntegrity,
      capabilityHash: 'capability',
      directory,
      contributions: Object.freeze([]),
    }),
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('package plugin loader', () => {
  it('uses only trusted active pin directories as executable sources', () => {
    const { snapshot } = packageSnapshot([])
    const pkg = {
      id: snapshot.packageId,
      trusted: true,
      blockers: [],
    } as unknown as InstalledPackage
    const inventory = { profile: snapshot.profile, hash: 'fixture', packages: [pkg] } as InstalledInventory
    const active = {
      pinId: activeRuntimePinId(snapshot),
      operationId: activeRuntimePinId(snapshot),
      purpose: 'active',
      snapshot,
    } as RuntimePin
    expect(runtimePluginSnapshotsFromPins(inventory, [active])).toMatchObject([
      { snapshot: { directory: snapshot.directory, snapshotId: snapshot.integrity }, trusted: true },
    ])
    expect(runtimePluginSnapshotsFromPins(inventory, [{ ...active, purpose: 'candidate' }])).toEqual([])
    expect(
      runtimePluginSnapshotsFromPins({ ...inventory, packages: [{ ...pkg, trusted: false }] }, [active]),
    ).toEqual([])
  })
  it('loads only statically declared named exports and normalizes them for Host', async () => {
    const { snapshot } = packageSnapshot([
      { export: 'main' },
      { export: 'optional', id: 'ext:acme/optional', config: { enabled: true }, default: false },
    ])
    const main = Object.assign(() => {}, { inject: ['clock'], provide: 'acme:main' })
    const optional = { apply() {} }
    const importModule = vi.fn(async () => ({ main, optional, undeclared: () => {} }))

    const loaded = await loadPackagePlugins({ snapshot, generation: 7, importModule })

    expect(importModule).toHaveBeenCalledOnce()
    expect(importModule).toHaveBeenCalledWith(snapshot)
    expect(
      loaded.map(({ declaration, candidate, entry }) => ({ declaration, candidate, entry })),
    ).toMatchObject([
      {
        declaration: {
          export: 'main',
          id: 'ext:@acme/example/main',
          runtime: 'in-process',
          default: true,
        },
        candidate: {
          packageId: '@acme/example',
          snapshotId: snapshot.snapshotId,
          exportName: 'main',
          generation: 7,
        },
        entry: { inject: { clock: null }, provides: ['acme:main'] },
      },
      {
        declaration: {
          export: 'optional',
          id: 'ext:acme/optional',
          runtime: 'in-process',
          config: { enabled: true },
          default: false,
        },
        candidate: {
          packageId: '@acme/example',
          snapshotId: snapshot.snapshotId,
          exportName: 'optional',
          generation: 7,
        },
        entry: { inject: {}, provides: [] },
      },
    ])
    expect(Object.isFrozen(loaded)).toBe(true)
    expect(Object.isFrozen(loaded[0])).toBe(true)
  })

  it('rejects a missing declared export and an invalid plugin shape', async () => {
    const missing = packageSnapshot([{ export: 'main' }]).snapshot
    await expect(
      loadPackagePlugins({ snapshot: missing, generation: 1, importModule: async () => ({}) }),
    ).rejects.toMatchObject({ legacyCode: 'E_EXT_LOAD', detail: { reason: 'plugin-export-missing' } })

    const invalid = packageSnapshot([{ export: 'main' }]).snapshot
    await expect(
      loadPackagePlugins({ snapshot: invalid, generation: 1, importModule: async () => ({ main: 42 }) }),
    ).rejects.toMatchObject({ legacyCode: 'E_EXT_LOAD', detail: { reason: 'plugin-export-shape' } })
  })

  it('fails closed before import when an isolated declaration cannot use the in-process loader', async () => {
    const snapshot = packageSnapshot([{ export: 'main', runtime: 'isolated' }]).snapshot
    const importModule = vi.fn(async () => ({ main: () => {} }))

    await expect(loadPackagePlugins({ snapshot, generation: 1, importModule })).rejects.toMatchObject({
      legacyCode: 'E_EXT_LOAD',
      detail: { reason: 'isolated-runtime-unavailable' },
    })
    expect(importModule).not.toHaveBeenCalled()
  })

  it('rejects a generation that cannot form a verified candidate', async () => {
    const snapshot = packageSnapshot([{ export: 'main' }]).snapshot
    const importModule = vi.fn(async () => ({ main: () => {} }))

    await expect(loadPackagePlugins({ snapshot, generation: 0, importModule })).rejects.toMatchObject({
      legacyCode: 'E_EXT_LOAD',
      detail: { reason: 'generation' },
    })
    expect(importModule).not.toHaveBeenCalled()
  })

  it('rejects stale input and a package mutation during dynamic loading', async () => {
    const stale = packageSnapshot([{ export: 'main' }])
    writeFileSync(join(stale.directory, 'changed.txt'), 'changed')
    await expect(
      loadPackagePlugins({
        snapshot: stale.snapshot,
        generation: 1,
        importModule: async () => ({ main: () => {} }),
      }),
    ).rejects.toMatchObject({ legacyCode: 'E_LOCK_MISMATCH', detail: { reason: 'snapshot-stale' } })

    const changed = packageSnapshot([{ export: 'main' }])
    await expect(
      loadPackagePlugins({
        snapshot: changed.snapshot,
        generation: 1,
        importModule: async () => {
          writeFileSync(
            join(changed.directory, 'package.json'),
            `${JSON.stringify({
              name: '@acme/example',
              version: '1.2.3',
              agnes: { plugins: [{ export: 'replacement' }] },
            })}\n`,
          )
          return { main: () => {} }
        },
      }),
    ).rejects.toMatchObject({ legacyCode: 'E_LOCK_MISMATCH', detail: { reason: 'snapshot-changed' } })
  })

  it('does not execute packages that only have legacy extension declarations', async () => {
    const { snapshot } = packageSnapshot(undefined, { extensions: ['./legacy'] })
    const importModule = vi.fn(async () => ({ main: () => {} }))

    await expect(loadPackagePlugins({ snapshot, generation: 1, importModule })).rejects.toMatchObject({
      detail: { reason: 'legacy-extension-format' },
    })
    expect(importModule).not.toHaveBeenCalled()
  })

  it('refuses a snapshot that declares both executable loading formats before import', async () => {
    const { snapshot } = packageSnapshot([{ export: 'main' }], { extensions: ['./legacy'] })
    const importModule = vi.fn(async () => ({ main: () => {} }))
    await expect(loadPackagePlugins({ snapshot, generation: 1, importModule })).rejects.toMatchObject({
      legacyCode: 'E_EXT_LOAD',
      detail: { reason: 'legacy-extension-format' },
    })
    expect(importModule).not.toHaveBeenCalled()
  })

  it('verifies candidates only against the exact live immutable snapshot generation', async () => {
    const { directory, snapshot } = packageSnapshot([{ export: 'main' }])
    const verifier = createPackageSnapshotVerifier([{ snapshot, generation: 7, trusted: true }])
    const candidate = {
      packageId: snapshot.packageId,
      snapshotId: snapshot.snapshotId,
      exportName: 'main',
      generation: 7,
    }

    await expect(verifier.verify(candidate)).resolves.toMatchObject({
      packageId: snapshot.packageId,
      snapshotId: snapshot.snapshotId,
      generation: 7,
      digest: snapshot.integrity,
      exports: ['main'],
      trusted: true,
    })
    await expect(verifier.verify({ ...candidate, generation: 8 })).rejects.toMatchObject({
      code: 'E_SNAPSHOT_UNAVAILABLE',
    })
    await expect(
      verifier.verify({ ...candidate, snapshotId: `sha256-${'9'.repeat(64)}` }),
    ).rejects.toMatchObject({ code: 'E_SNAPSHOT_UNAVAILABLE' })

    writeFileSync(join(directory, 'changed.txt'), 'changed')
    await expect(verifier.verify(candidate)).rejects.toMatchObject({
      legacyCode: 'E_LOCK_MISMATCH',
      detail: { reason: 'snapshot-changed' },
    })
  })
  it('the live verifier sees a trust change without being rebuilt', async () => {
    const { snapshot } = packageSnapshot([{ export: 'main' }])
    let trusted = true
    const verifier = createLivePackageSnapshotVerifier(() => ({ snapshot, generation: 1, trusted }))
    const candidate = {
      packageId: snapshot.packageId,
      snapshotId: snapshot.snapshotId,
      exportName: 'main',
      generation: 1,
    }
    await expect(verifier.verify(candidate)).resolves.toMatchObject({ trusted: true, exports: ['main'] })
    trusted = false
    await expect(verifier.verify(candidate)).resolves.toMatchObject({ trusted: false })
  })

  it('the live verifier reports an uninstalled or other-generation snapshot as unavailable', async () => {
    const { snapshot } = packageSnapshot([{ export: 'main' }])
    const candidate = {
      packageId: snapshot.packageId,
      snapshotId: snapshot.snapshotId,
      exportName: 'main',
      generation: 1,
    }
    await expect(createLivePackageSnapshotVerifier(() => undefined).verify(candidate)).rejects.toMatchObject({
      code: 'E_SNAPSHOT_UNAVAILABLE',
    })
    const other = createLivePackageSnapshotVerifier(() => ({ snapshot, generation: 2, trusted: true }))
    await expect(other.verify(candidate)).rejects.toMatchObject({ code: 'E_SNAPSHOT_UNAVAILABLE' })
  })
})

describe('runtime plugin snapshots from installed inventory', () => {
  function installed(over: Partial<InstalledPackage> & { treeIntegrity?: string } = {}): InstalledPackage {
    const { treeIntegrity = `sha256-${'3'.repeat(64)}`, ...rest } = over
    return {
      id: '@acme/example',
      entry: {
        version: '1.2.3',
        integrity: `sha256-${'2'.repeat(64)}`,
        ...(treeIntegrity ? { treeIntegrity } : {}),
      } as InstalledPackage['entry'],
      directory: '/store/@acme/example',
      capabilityHash: 'capability',
      trusted: true,
      enabled: true,
      contributions: [],
      blockers: [],
      verifiedRollbackTarget: null,
      ...rest,
    }
  }
  const inventory = (packages: InstalledPackage[]): InstalledInventory => ({
    profile: 'default',
    hash: 'h',
    packages,
  })

  it('names each installed package by the snapshot id desired rows use', () => {
    const pkg = installed()
    const [source] = runtimePluginSnapshotsFromInventory(inventory([pkg]))
    expect(installedRuntimeSnapshotId(pkg)).toBe(pkg.entry.integrity)
    expect(source).toEqual({
      snapshot: {
        snapshotId: pkg.entry.integrity,
        profile: 'default',
        packageId: '@acme/example',
        version: '1.2.3',
        integrity: pkg.entry.integrity,
        treeIntegrity: `sha256-${'3'.repeat(64)}`,
        capabilityHash: 'capability',
        directory: '/store/@acme/example',
        contributions: [],
      },
      generation: 1,
      trusted: true,
    })
  })

  it('carries the lock trust decision and skips packages it cannot verify', () => {
    const sources = runtimePluginSnapshotsFromInventory(
      inventory([
        installed({ id: '@acme/untrusted', trusted: false }),
        installed({ id: '@acme/no-directory', directory: null }),
        installed({ id: '@acme/no-tree', treeIntegrity: '' }),
      ]),
    )
    expect(sources.map((source) => [source.snapshot.packageId, source.trusted])).toEqual([
      ['@acme/untrusted', false],
    ])
  })
  it('exports the kept previous version, trusted only while the current entry is', () => {
    const previous = {
      version: '1.2.2',
      integrity: `sha256-${'4'.repeat(64)}`,
      capabilityHash: 'previous-capability',
      treeIntegrity: `sha256-${'5'.repeat(64)}`,
      directory: '/store/.previous/@acme/example',
      contributions: [],
    }
    const trusted = runtimePluginSnapshotsFromInventory(
      inventory([installed({ verifiedRollbackTarget: previous })]),
    )
    expect(
      trusted.map((s) => [s.snapshot.snapshotId, s.snapshot.version, s.snapshot.directory, s.trusted]),
    ).toEqual([
      [`sha256-${'2'.repeat(64)}`, '1.2.3', '/store/@acme/example', true],
      [previous.integrity, '1.2.2', previous.directory, true],
    ])
    const untrusted = runtimePluginSnapshotsFromInventory(
      inventory([installed({ trusted: false, verifiedRollbackTarget: previous })]),
    )
    expect(untrusted.map((s) => s.trusted)).toEqual([false, false])
    const same = runtimePluginSnapshotsFromInventory(
      inventory([
        installed({ verifiedRollbackTarget: { ...previous, integrity: `sha256-${'2'.repeat(64)}` } }),
      ]),
    )
    expect(same).toHaveLength(1)
  })
})
