import type { InstalledInventory, PackageManager, RuntimePin } from '@agnes/package-manager'
import { activeRuntimePinId } from '@agnes/package-manager'
import { buildRuntimeTarget, createPluginRow, encodeRuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import { describe, expect, it, vi } from 'vitest'
import { createCompositeTargetActivation } from '../src/composite-target-activation.js'
import { createRuntimePinCoordinator } from '../src/runtime-pin-coordinator.js'
import { CompositeTargetStore } from '../src/storage/composite-target-store.js'
import { sqliteTables } from './sqlite-tables.js'

const integrity = `sha256-${'a'.repeat(64)}`
const treeIntegrity = `sha256-${'b'.repeat(64)}`
const revision = 'c'.repeat(64)
const packageId = '@acme/pin-test'

function artifact(disabled = false) {
  return encodeRuntimeTargetArtifact(
    buildRuntimeTarget({
      rows: [
        createPluginRow({
          id: 'ext:acme/pin-test',
          plugin: `${packageId}@${integrity}/main`,
          snapshotDigest: integrity,
          exportName: 'main',
          entryRevision: integrity,
          extrasRevision: 'none',
          mountRevision: 'test:v1',
          disabled,
        }),
      ],
      resources: { mcp: [], skills: {} },
      resourceRevision: revision,
      compositeRevision: revision,
    }),
  )
}

function fixture() {
  const tables = sqliteTables()
  const store = new CompositeTargetStore(tables.table('composite'), 'default')
  const active = new Map<string, RuntimePin>()
  let trusted = true
  let hash = 'initial'
  const manager = {
    inventory: vi.fn(
      async () =>
        ({
          profile: 'default',
          hash,
          packages: [
            {
              id: packageId,
              trusted,
              blockers: [],
              entry: { integrity, treeIntegrity, version: '1.0.0' },
              verifiedRollbackTarget: null,
            },
          ],
        }) as unknown as InstalledInventory,
    ),
    listRuntimePins: vi.fn(async () => [...active.values()]),
    pinRuntimeSnapshot: vi.fn(async (_dir: string, request: { pinId: string }) => {
      const pin = {
        pinId: request.pinId,
        operationId: request.pinId,
        purpose: 'active',
        snapshot: {
          snapshotId: `sha256-${'d'.repeat(64)}`,
          profile: 'default',
          packageId,
          integrity,
          treeIntegrity,
          version: '1.0.0',
          capabilityHash: revision,
          directory: '/immutable/snapshot',
          contributions: [],
        },
      } as RuntimePin
      active.set(pin.pinId, pin)
      return pin
    }),
    releaseRuntimePin: vi.fn(async (_dir: string, request: { pinId: string }) => {
      active.delete(request.pinId)
    }),
    collectRuntimeSnapshots: vi.fn(async () => ({ removed: [], retained: [] })),
  } as unknown as PackageManager
  const coordinator = createRuntimePinCoordinator({ store, manager, profileDirectory: '/profile' })
  return {
    store,
    manager,
    coordinator,
    active,
    setTrusted: (v: boolean) => {
      trusted = v
      hash = 'untrusted'
    },
    changeHash: () => {
      hash = 'changed'
    },
  }
}

describe('runtime active pin coordinator', () => {
  it('creates an immutable pin before probing and retains it for the published target', async () => {
    const f = fixture()
    const value = artifact()
    await f.coordinator.publish(value, async () => {
      expect(f.active.has(activeRuntimePinId({ packageId, integrity }))).toBe(true)
      expect(f.store.pins()).toEqual([activeRuntimePinId({ packageId, integrity })])
    })
    expect(f.store.desired()).toEqual(value)
    expect(f.store.pins()).toEqual([])
    expect(f.active.size).toBe(1)
  })

  it('releases a new pin after a failed probe without publishing the target', async () => {
    const f = fixture()
    await expect(
      f.coordinator.publish(artifact(), async () => {
        throw new Error('probe failed')
      }),
    ).rejects.toThrow('probe failed')
    expect(f.store.desired()).toBeUndefined()
    expect(f.active.size).toBe(0)
    expect(f.store.pins()).toEqual([])
  })

  it('rejects trust revocation or inventory replacement during a slow probe', async () => {
    for (const change of ['trust', 'inventory'] as const) {
      const f = fixture()
      await expect(
        f.coordinator.publish(artifact(), async () => {
          if (change === 'trust') f.setTrusted(false)
          else f.changeHash()
        }),
      ).rejects.toThrow('E_RUNTIME_TARGET_INVENTORY_STALE')
      expect(f.store.desired()).toBeUndefined()
      expect(f.active.size).toBe(0)
    }
  })

  it('holds a revoked package pin until its running row has stopped', async () => {
    const f = fixture()
    await f.coordinator.publish(artifact(), async () => {})
    const id = activeRuntimePinId({ packageId, integrity })
    await f.coordinator.revokePackage(packageId)
    expect(f.store.desired()?.digest).not.toBe(artifact().digest)
    expect((await f.coordinator.inspectOrphans()).map((pin) => pin.pinId)).not.toContain(id)
    await f.coordinator.collect()
    expect(f.active.has(id)).toBe(true)
    await f.coordinator.releaseRetiring(packageId)
    expect(f.active.has(id)).toBe(false)
  })

  it('retains the first retiring pin across a removal retry before worker acknowledgement', async () => {
    const f = fixture()
    await f.coordinator.publish(artifact(true), async () => {})
    const id = activeRuntimePinId({ packageId, integrity })
    await f.coordinator.revokePackage(packageId)
    await f.coordinator.revokePackage(packageId)
    await f.coordinator.collect()
    expect(f.active.has(id)).toBe(true)
    await f.coordinator.releaseRetiring(packageId)
    expect(f.active.has(id)).toBe(false)
  })

  it('keeps the retiring pin when removal revocation has not been acknowledged by the worker', async () => {
    const f = fixture()
    const before = artifact(true)
    await f.coordinator.publish(before, async () => {})
    f.store.qualifyConverged(1, before, {
      hash: before.identity.treeHash,
      ok: true,
      rows: [{ id: 'ext:acme/pin-test', state: 'disabled' }],
    })
    const activation = createCompositeTargetActivation({
      store: f.store,
      workerGeneration: () => 1,
      revokePackage: f.coordinator.revokePackage,
      releaseRetiring: f.coordinator.releaseRetiring,
      collectPins: f.coordinator.collect,
      settle: { timeoutMs: 20, intervalMs: 1 },
    })
    await expect(activation.prepareRemoval?.('default', packageId)).rejects.toThrow('E_PACKAGE_STATE')
    expect(f.active.has(activeRuntimePinId({ packageId, integrity }))).toBe(true)
  })

  it('removes a retiring pin after the worker acknowledges the sanitized target', async () => {
    const f = fixture()
    const before = artifact(true)
    await f.coordinator.publish(before, async () => {})
    f.store.qualifyConverged(1, before, {
      hash: before.identity.treeHash,
      ok: true,
      rows: [{ id: 'ext:acme/pin-test', state: 'disabled' }],
    })
    f.store.onDesired((next) => {
      f.store.qualifyConverged(1, next, { hash: next.identity.treeHash, ok: true, rows: [] })
    })
    const activation = createCompositeTargetActivation({
      store: f.store,
      workerGeneration: () => 1,
      revokePackage: f.coordinator.revokePackage,
      releaseRetiring: f.coordinator.releaseRetiring,
      collectPins: f.coordinator.collect,
      settle: { timeoutMs: 20, intervalMs: 1 },
    })
    await activation.prepareRemoval?.('default', packageId)
    expect(f.active.has(activeRuntimePinId({ packageId, integrity }))).toBe(false)
  })
})
