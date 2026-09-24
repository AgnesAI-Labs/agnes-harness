import type { RuntimePluginSnapshot, RuntimeSnapshot } from '@agnes/package-manager'
import {
  buildRuntimeTarget,
  createPluginRow,
  normalizePluginExport,
  type ThirdPartyRowMountFactory,
} from '@agnes/plugin-runtime/host'
import { describe, expect, it, vi } from 'vitest'
import type { PackageModule } from '../src/assemble/packages.js'
import { loadRuntimeTargetClaims } from '../src/runtime-target-claims.js'

const revision = 'a'.repeat(64)

function source(packageId: string, snapshotId: string): RuntimePluginSnapshot {
  const snapshot: RuntimeSnapshot = Object.freeze({
    snapshotId,
    profile: 'default',
    packageId,
    version: '1.0.0',
    integrity: `sha256-${'b'.repeat(64)}`,
    treeIntegrity: `sha256-${'c'.repeat(64)}`,
    capabilityHash: revision,
    directory: `/snapshots/${snapshotId}`,
    contributions: Object.freeze([]),
  })
  return Object.freeze({ snapshot, generation: 7, trusted: true })
}

function row(id: string, plugin: string, entryRevision: string) {
  const slash = plugin.lastIndexOf('/')
  return createPluginRow({
    id,
    plugin,
    snapshotDigest: `sha256-${'b'.repeat(64)}`,
    exportName: plugin.slice(slash + 1),
    entryRevision,
    extrasRevision: 'none',
    mountRevision: revision,
    inject: [],
    provides: [],
  })
}

function target(...rows: ReturnType<typeof row>[]) {
  return buildRuntimeTarget({
    rows,
    resourceRevision: revision,
    compositeRevision: revision,
    resources: { mcp: [], skills: {} },
  })
}

function module(source: RuntimePluginSnapshot, exports: readonly string[]): PackageModule {
  return {
    id: source.snapshot.packageId,
    plugins: exports.map((exportName) => ({
      declaration: { id: `ext:${exportName}`, export: exportName, runtime: 'in-process', default: true },
      entry: normalizePluginExport((() => undefined) as never),
      candidate: {
        packageId: source.snapshot.packageId,
        snapshotId: source.snapshot.snapshotId,
        exportName,
        generation: source.generation,
      },
      snapshotDigest: source.snapshot.integrity,
    })),
  }
}

function mounts() {
  const verifyAndCreate = vi.fn(async () => ({}) as never)
  return {
    bindExtras: vi.fn((slot, revision, values) => ({ slot, revision, values })),
    verifyAndCreate,
  } satisfies ThirdPartyRowMountFactory
}

describe('runtime target candidate claims', () => {
  it('loads only the exact trusted target export and binds it to its immutable snapshot', async () => {
    const selected = source('@scope/demo', 'snapshot-a')
    const selectedRow = row('ext:chosen', '@scope/demo@snapshot-a/chosen', 'snapshot-a')
    const load = vi.fn(async () => module(selected, ['chosen', 'unselected']))
    const claims = await loadRuntimeTargetClaims({
      target: target(selectedRow),
      sources: [selected],
      load,
      trust: () => 'trusted',
    })
    expect(load).toHaveBeenCalledTimes(1)
    expect(claims.privateInput.builtinClaims).toEqual([])
    const factory = mounts()
    const mounted = await claims.pluginImporter(factory)(selectedRow)
    expect(mounted).toBeDefined()
    expect(factory.verifyAndCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        row: selectedRow,
        snapshot: {
          packageId: '@scope/demo',
          snapshotId: 'snapshot-a',
          exportName: 'chosen',
          generation: 7,
        },
      }),
    )
  })

  it('routes a builtin target row through Host-private claims, never the third-party importer', async () => {
    const selected = source('@agnes/base', 'builtin-snapshot')
    const selectedRow = row('ext:builtin', 'builtin:@agnes/base/builtin', 'builtin-snapshot')
    const claims = await loadRuntimeTargetClaims({
      target: target(selectedRow),
      sources: [selected],
      load: async () => module(selected, ['builtin']),
      trust: () => 'builtin',
    })
    expect(claims.privateInput.builtinClaims).toHaveLength(1)
    expect(claims.privateInput.builtinClaims?.[0]?.row).toStrictEqual(selectedRow)
    expect(await claims.pluginImporter(mounts())(selectedRow)).toBeUndefined()
  })

  it('leaves Host-private builtin rows to static authority when no snapshot is selected', async () => {
    const load = vi.fn(async () => undefined)
    const builtinRow = row('preset:default', 'builtin:host/preset/default', 'host-row:v1')
    const claims = await loadRuntimeTargetClaims({
      target: target(builtinRow),
      sources: [],
      load,
      trust: () => undefined,
    })
    expect(load).not.toHaveBeenCalled()
    expect(claims.privateInput.builtinClaims).toEqual([])
    expect(await claims.pluginImporter(mounts())(builtinRow)).toBeUndefined()
  })

  it('fails closed before mounting when identity, revision, trust, or export proof differs', async () => {
    const selected = source('demo', 'snapshot-a')
    const load = vi.fn(async () => module(selected, ['chosen']))
    await expect(
      loadRuntimeTargetClaims({
        target: target(row('ext:wrong-version', 'demo@snapshot-b/chosen', 'snapshot-a')),
        sources: [selected],
        load,
        trust: () => 'trusted',
      }),
    ).rejects.toThrow('plugin identity does not match')
    expect(load).not.toHaveBeenCalled()

    await expect(
      loadRuntimeTargetClaims({
        target: target(row('ext:wrong-revision', 'demo@snapshot-a/chosen', 'not-snapshot-a')),
        sources: [selected],
        load,
        trust: () => 'trusted',
      }),
    ).rejects.toThrow('entry revision does not match')

    await expect(
      loadRuntimeTargetClaims({
        target: target(row('ext:wrong-trust', 'builtin:demo/chosen', 'snapshot-a')),
        sources: [selected],
        load,
        trust: () => 'trusted',
      }),
    ).rejects.toThrow('plugin identity does not match')

    await expect(
      loadRuntimeTargetClaims({
        target: target(row('ext:missing-export', 'demo@snapshot-a/missing', 'snapshot-a')),
        sources: [selected],
        load,
        trust: () => 'trusted',
      }),
    ).rejects.toThrow('no unique claimed export')
  })
})
