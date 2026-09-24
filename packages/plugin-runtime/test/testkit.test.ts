import { describe, expect, it, vi } from 'vitest'
import { createPluginRow, normalizePluginExport } from '../src/host/index.js'
import { createVerifiedTestRoot } from '../testkit/index.js'

describe('verified installation testkit', () => {
  it('mounts claimed snapshots and exposes only origin lookup', async () => {
    const called = vi.fn()
    const world = createVerifiedTestRoot()
    const snapshot = world.fixtures.snapshot({
      packageId: '@example/demo',
      snapshotId: 'snapshot-1',
      digest: 'sha256-demo',
      exports: ['main'],
    })
    const plugin = '@example/demo@snapshot-1/main'
    world.fixtures.claim(plugin, {
      trust: 'third-party',
      snapshot,
      entry: normalizePluginExport(called),
      entryRevision: 'entry-1',
      extrasRevision: 'none',
    })
    const row = createPluginRow({
      id: 'ext:@example/demo/main',
      plugin,
      snapshotDigest: snapshot.digest,
      exportName: 'main',
      entryRevision: 'entry-1',
      extrasRevision: 'none',
      mountRevision: 'mount-1',
    })

    await world.apply([row])
    expect(called).toHaveBeenCalledOnce()
    const fiber = world.tree.fiber(row.id)
    expect(fiber && world.origins.lookup(fiber)).toMatchObject({
      trustTier: 'third-party',
      rowId: row.id,
    })
    await world.apply([])
    expect(fiber && world.origins.lookup(fiber)).toBeUndefined()
  })

  it('rejects duplicate claims, fixture shadowing, and removed claims', async () => {
    const world = createVerifiedTestRoot({
      importers: () => [async () => undefined],
    })
    const snapshot = world.fixtures.snapshot({
      packageId: '@example/demo',
      snapshotId: 'snapshot-1',
      digest: 'sha256-demo',
      exports: ['main'],
    })
    const plugin = '@example/demo@snapshot-1/main'
    const fixture = {
      trust: 'third-party' as const,
      snapshot,
      entry: normalizePluginExport(() => {}),
      entryRevision: 'entry-1',
      extrasRevision: 'none',
    }
    world.fixtures.claim(plugin, fixture)
    expect(() => world.fixtures.claim(plugin, fixture)).toThrow(/duplicate/)

    const row = createPluginRow({
      id: 'ext:@example/demo/main',
      plugin,
      snapshotDigest: snapshot.digest,
      exportName: 'main',
      entryRevision: 'entry-1',
      extrasRevision: 'none',
      mountRevision: 'mount-1',
    })
    world.fixtures.remove(plugin)
    await expect(world.apply([row])).rejects.toMatchObject({ code: 'E_ROW_IMPORT' })
  })
})
