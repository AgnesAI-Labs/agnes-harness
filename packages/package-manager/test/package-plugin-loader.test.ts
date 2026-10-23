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
  preflightPackagePluginsAsync,
  runtimePluginDataSourcesFromInventory,
  runtimePluginSnapshotsFromInventory,
  runtimePluginSnapshotsFromPins,
} from '../src/package-plugin-loader.js'
import type { RuntimePin, RuntimeSnapshot } from '../src/runtime-snapshots.js'
import { hashDirectory } from '../src/sources.js'
import { verifiedDirectoryDigest, withPackageVerification } from '../src/verification-operation.js'

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
  it('refuses missing or incompatible ranges without invoking the module importer', async () => {
    const importModule = vi.fn(async () => ({ main: () => {} }))
    for (const [apiRange, code] of [
      [undefined, 'E_PROVIDER_INVALID'],
      ['^99.0.0', 'E_PROVIDER_INCOMPATIBLE'],
    ] as const) {
      const { snapshot } = packageSnapshot([{ export: 'main', apiRange }])
      await expect(loadPackagePlugins({ snapshot, generation: 1, importModule })).rejects.toMatchObject({
        code,
        kind: 'plugin',
        operation: 'admit',
      })
    }
    expect(importModule).not.toHaveBeenCalled()
  })
  it('uses only trusted active pin directories as executable sources', () => {
    const { snapshot } = packageSnapshot([])
    const pkg = {
      id: snapshot.packageId,
      entry: {
        version: snapshot.version,
        integrity: snapshot.integrity,
        treeIntegrity: snapshot.treeIntegrity,
      },
      capabilityHash: snapshot.capabilityHash,
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
    for (const changed of [
      { treeIntegrity: `sha256-${'f'.repeat(64)}` },
      { capabilityHash: 'f'.repeat(64) },
      { version: '9.0.0' },
    ])
      expect(() =>
        runtimePluginSnapshotsFromPins(inventory, [{ ...active, snapshot: { ...snapshot, ...changed } }]),
      ).toThrow('active runtime pin differs from installed snapshot')
    const historical = { ...snapshot, integrity: `sha256-${'a'.repeat(64)}` }
    expect(
      runtimePluginSnapshotsFromPins(inventory, [
        { ...active, pinId: activeRuntimePinId(historical), snapshot: historical },
      ]),
    ).toMatchObject([{ snapshot: { directory: snapshot.directory }, enabled: false, trusted: true }])
    expect(
      runtimePluginSnapshotsFromPins({ ...inventory, packages: [{ ...pkg, trusted: false }] }, [active]),
    ).toEqual([])
  })
  it('offers trusted enabled bundle-only packages as data without requiring or importing an executable row', async () => {
    const { snapshot } = packageSnapshot([], {
      bundles: { base: { profile: { toolPolicy: { readOnly: true } } } },
    })
    const pkg = {
      id: snapshot.packageId,
      directory: snapshot.directory,
      enabled: true,
      trusted: true,
      blockers: [],
      capabilityHash: snapshot.capabilityHash,
      contributions: [],
      verifiedRollbackTarget: null,
      entry: {
        version: snapshot.version,
        integrity: snapshot.integrity,
        treeIntegrity: snapshot.treeIntegrity,
      },
    } as unknown as InstalledPackage
    const inventory = { profile: snapshot.profile, hash: 'fixture', packages: [pkg] } as InstalledInventory
    const sources = runtimePluginDataSourcesFromInventory(inventory)
    expect(sources).toMatchObject([
      { enabled: true, trusted: true, snapshot: { packageId: pkg.id, integrity: snapshot.integrity } },
    ])
    const importModule = async () => {
      throw new Error('declarative packages must not import code')
    }
    expect(await loadPackagePlugins({ snapshot: sources[0]!.snapshot, generation: 1, importModule })).toEqual(
      [],
    )
    for (const changed of [{ enabled: false }, { trusted: false }, { blockers: [{ code: 'dependency' }] }])
      expect(
        runtimePluginDataSourcesFromInventory({
          ...inventory,
          packages: [{ ...pkg, ...changed } as InstalledPackage],
        }),
      ).toEqual([])
  })
  it('loads only statically declared named exports and normalizes them for Host', async () => {
    const { snapshot } = packageSnapshot([
      { apiRange: '^5.0.0', export: 'main' },
      {
        apiRange: '^5.0.0',
        export: 'optional',
        id: 'ext:acme/optional',
        config: { enabled: true },
        default: false,
      },
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
          apiRange: '^5.0.0',
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
          apiRange: '^5.0.0',
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

  it('reads required and optional injected services from the manifest entry alone', async () => {
    const { snapshot } = packageSnapshot([
      { apiRange: '^5.0.0', export: 'main', inject: ['tools', 'clock'], optionalInject: ['clock'] },
    ])
    const [loaded] = await loadPackagePlugins({
      snapshot,
      generation: 1,
      importModule: async () => ({ main: { apply() {} } }),
    })
    expect(loaded?.entry.inject).toEqual({ tools: null, clock: { required: false } })
  })

  it('refuses an export whose own inject list disagrees with the manifest entry', async () => {
    const { snapshot } = packageSnapshot([{ apiRange: '^5.0.0', export: 'main', inject: ['tools'] }])
    await expect(
      loadPackagePlugins({
        snapshot,
        generation: 1,
        importModule: async () => ({ main: { inject: ['tools', 'hooks'], apply() {} } }),
      }),
    ).rejects.toMatchObject({ detail: { reason: 'plugin-export-shape' } })
  })

  it('rejects a missing declared export and an invalid plugin shape', async () => {
    const missing = packageSnapshot([{ apiRange: '^5.0.0', export: 'main' }]).snapshot
    await expect(
      loadPackagePlugins({ snapshot: missing, generation: 1, importModule: async () => ({}) }),
    ).rejects.toMatchObject({ legacyCode: 'E_EXT_LOAD', detail: { reason: 'plugin-export-missing' } })

    const invalid = packageSnapshot([{ apiRange: '^5.0.0', export: 'main' }]).snapshot
    await expect(
      loadPackagePlugins({ snapshot: invalid, generation: 1, importModule: async () => ({ main: 42 }) }),
    ).rejects.toMatchObject({ legacyCode: 'E_EXT_LOAD', detail: { reason: 'plugin-export-shape' } })
  })

  it('fails closed before import when an isolated declaration cannot use the in-process loader', async () => {
    const snapshot = packageSnapshot([{ apiRange: '^5.0.0', export: 'main', runtime: 'isolated' }]).snapshot
    const importModule = vi.fn(async () => ({ main: () => {} }))

    await expect(loadPackagePlugins({ snapshot, generation: 1, importModule })).rejects.toMatchObject({
      legacyCode: 'E_EXT_LOAD',
      detail: { reason: 'isolated-runtime-unavailable' },
    })
    expect(importModule).not.toHaveBeenCalled()
  })

  it('rejects a generation that cannot form a verified candidate', async () => {
    const snapshot = packageSnapshot([{ apiRange: '^5.0.0', export: 'main' }]).snapshot
    const importModule = vi.fn(async () => ({ main: () => {} }))

    await expect(loadPackagePlugins({ snapshot, generation: 0, importModule })).rejects.toMatchObject({
      legacyCode: 'E_EXT_LOAD',
      detail: { reason: 'generation' },
    })
    expect(importModule).not.toHaveBeenCalled()
  })

  it('rejects stale input and a package mutation during dynamic loading', async () => {
    const stale = packageSnapshot([{ apiRange: '^5.0.0', export: 'main' }])
    await withPackageVerification(async () => {
      const input = { snapshot: stale.snapshot, generation: 1 }
      await preflightPackagePluginsAsync(input)
      writeFileSync(join(stale.directory, 'changed.txt'), 'changed')
      const importModule = vi.fn(async () => ({ main: () => {} }))
      // An earlier descriptive preflight must never authorize importing modified bytes.
      await expect(loadPackagePlugins({ ...input, importModule })).rejects.toMatchObject({
        legacyCode: 'E_LOCK_MISMATCH',
        detail: { reason: 'snapshot-stale' },
      })
      expect(importModule).not.toHaveBeenCalled()
    })
    // No completed read observation survives into the next independent query.
    await expect(
      preflightPackagePluginsAsync({ snapshot: stale.snapshot, generation: 1 }),
    ).rejects.toMatchObject({
      legacyCode: 'E_LOCK_MISMATCH',
      detail: { reason: 'snapshot-stale' },
    })

    const changed = packageSnapshot([{ apiRange: '^5.0.0', export: 'main' }])
    const workerRead = () =>
      withPackageVerification(
        async () => verifiedDirectoryDigest(changed.directory, changed.snapshot, false, true),
        { settleTrees: true },
      )
    await workerRead()
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
              agnes: { plugins: [{ apiRange: '^5.0.0', export: 'replacement' }] },
            })}\n`,
          )
          return { main: () => {} }
        },
      }),
    ).rejects.toMatchObject({ legacyCode: 'E_LOCK_MISMATCH', detail: { reason: 'snapshot-changed' } })
    // A refused module generation must invalidate an earlier descriptive success in this worker.
    expect(await workerRead()).not.toBe(changed.snapshot.treeIntegrity)
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
    const { snapshot } = packageSnapshot([{ apiRange: '^5.0.0', export: 'main' }], {
      extensions: ['./legacy'],
    })
    const importModule = vi.fn(async () => ({ main: () => {} }))
    await expect(loadPackagePlugins({ snapshot, generation: 1, importModule })).rejects.toMatchObject({
      legacyCode: 'E_EXT_LOAD',
      detail: { reason: 'legacy-extension-format' },
    })
    expect(importModule).not.toHaveBeenCalled()
  })

  it('verifies candidates only against the exact live immutable snapshot generation', async () => {
    const { directory, snapshot } = packageSnapshot([{ apiRange: '^5.0.0', export: 'main' }])
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
    const { snapshot } = packageSnapshot([{ apiRange: '^5.0.0', export: 'main' }])
    let trusted = true
    const verifier = createLivePackageSnapshotVerifier(() => ({ snapshot, generation: 1, trusted }))
    const candidate = {
      packageId: snapshot.packageId,
      snapshotId: snapshot.snapshotId,
      exportName: 'main',
      generation: 1,
    }
    await expect(verifier.verify(candidate)).resolves.toMatchObject({ trusted: true, exports: ['main'] })
    const racing = verifier.verify(candidate)
    trusted = false
    await expect(racing).rejects.toMatchObject({ code: 'E_SNAPSHOT_UNAVAILABLE' })
    await expect(verifier.verify(candidate)).resolves.toMatchObject({ trusted: false })
  })

  it('the live verifier reports an uninstalled or other-generation snapshot as unavailable', async () => {
    const { snapshot } = packageSnapshot([{ apiRange: '^5.0.0', export: 'main' }])
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
