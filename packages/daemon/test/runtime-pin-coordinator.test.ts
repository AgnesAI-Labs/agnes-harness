import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ownsRow, rebuildDesiredFromInventory } from '@agnes/daemon-foundation/composite-desired'
import type { InstalledInventory, InstalledPackage, PackageManager, RuntimePin } from '@agnes/package-manager'
import { activeRuntimePinId } from '@agnes/package-manager'
import {
  buildRuntimeTarget,
  createPluginRow,
  decodeRuntimeTargetArtifact,
  encodeRuntimeTargetArtifact,
  type RuntimeTargetArtifact,
} from '@agnes/plugin-runtime/host'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sqliteTables } from '../../daemon-foundation/test/sqlite-tables.js'
import { CompositeTargetStore } from '../src/storage/composite-target-store.js'
import { createCompositeTargetActivation } from '../src/supervisor/publication/composite-target-activation.js'
import { createRuntimePinCoordinator } from '../src/supervisor/publication/runtime-pin-coordinator.js'

const integrity = `sha256-${'a'.repeat(64)}`
const treeIntegrity = `sha256-${'b'.repeat(64)}`
const revision = 'c'.repeat(64)
const packageId = '@acme/pin-test'

function artifact(disabled = false, exports = ['main']) {
  return encodeRuntimeTargetArtifact(
    buildRuntimeTarget({
      rows: exports.map((exportPath, index) =>
        createPluginRow({
          id: exportPath.startsWith('client') ? `web:acme/pin-test:${index}` : 'ext:acme/pin-test',
          plugin: `${packageId}@${integrity}/${exportPath}`,
          snapshotDigest: integrity,
          exportName: exportPath.split('/')[0]!,
          entryRevision: integrity,
          extrasRevision: 'none',
          mountRevision: 'test:v1',
          disabled,
        }),
      ),
      resources: { mcp: [], skills: {} },
      resourceRevision: revision,
      compositeRevision: revision,
    }),
  )
}

/** What `runtimePinRecords` reports for these pins: their bookkeeping, with only pinned snapshots kept. */
function records(pins: Iterable<RuntimePin>, extraSnapshots: readonly string[] = []) {
  const list = [...pins]
  return {
    pins: list.map((pin) => ({
      pinId: pin.pinId,
      purpose: pin.purpose,
      packageId: pin.snapshot.packageId,
      snapshotId: pin.snapshot.snapshotId,
      integrity: pin.snapshot.integrity,
      treeIntegrity: pin.snapshot.treeIntegrity,
    })),
    snapshotIds: [...new Set([...list.map((pin) => pin.snapshot.snapshotId), ...extraSnapshots])],
  }
}

function fixture() {
  const tables = sqliteTables()
  const store = new CompositeTargetStore(tables.table('composite'), 'default')
  const active = new Map<string, RuntimePin>()
  /** Snapshot ids the store still holds with no pin naming them. */
  const unpinned: string[] = []
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
    runtimePinRecords: vi.fn(async () => records(active.values(), unpinned)),
    pinRuntimeSnapshots: vi.fn(async (_dir: string, requests: readonly { pinId: string }[]) =>
      requests.map((request) => {
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
    ),
    releaseRuntimePins: vi.fn(async (_dir: string, requests: readonly { pinId: string }[]) => {
      for (const request of requests) active.delete(request.pinId)
    }),
    collectRuntimeSnapshots: vi.fn(async () => ({ removed: [], retained: [] })),
  } as unknown as PackageManager
  const coordinator = createRuntimePinCoordinator({ store, manager, profileDirectory: '/profile' })
  return {
    store,
    manager,
    coordinator,
    active,
    unpinned,
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
  it.each([['main'], ['client'], ['client/acme/primary', 'client/acme/secondary']])(
    'publishes and recovers snapshot pins for %j',
    async (...exports) => {
      const f = fixture()
      const value = artifact(false, exports)
      await f.coordinator.publish(value, async () => {
        expect(f.active.has(activeRuntimePinId({ packageId, integrity }))).toBe(true)
        expect(f.store.pins()).toEqual([activeRuntimePinId({ packageId, integrity })])
      })
      expect(f.store.desired()).toEqual(value)
      expect(f.store.pins()).toEqual([])
      expect(f.active.size).toBe(1)
      expect(f.manager.pinRuntimeSnapshots).toHaveBeenCalledTimes(1)
      const recovered = createRuntimePinCoordinator({
        store: f.store,
        manager: f.manager,
        profileDirectory: '/profile',
      })
      await recovered.recover()
      expect(f.store.desired()).toEqual(value)
      expect(f.active.size).toBe(1)
    },
  )

  it('releases every unreferenced active pin in one call', async () => {
    const f = fixture()
    // Pins left by an earlier build: a Worker reads their state unlocked while they are released.
    const stale = ['e', 'f', 'g'].map((digit) => {
      const old = `sha256-${digit.repeat(64)}`
      const pin = {
        pinId: activeRuntimePinId({ packageId, integrity: old }),
        operationId: 'old',
        purpose: 'active',
        snapshot: { snapshotId: old, packageId, integrity: old },
      } as unknown as RuntimePin
      f.active.set(pin.pinId, pin)
      return pin.pinId
    })
    await f.coordinator.collect()
    expect(f.manager.releaseRuntimePins).toHaveBeenCalledTimes(1)
    expect(vi.mocked(f.manager.releaseRuntimePins).mock.calls[0]![1].map((request) => request.pinId)).toEqual(
      stale,
    )
    expect(f.active.size).toBe(0)
  })

  it('runs no verified release or collection pass when nothing is left to release or collect', async () => {
    const f = fixture()
    await f.coordinator.publish(artifact(), async () => {})
    vi.mocked(f.manager.releaseRuntimePins).mockClear()
    vi.mocked(f.manager.collectRuntimeSnapshots).mockClear()
    await f.coordinator.collect()
    expect(f.manager.releaseRuntimePins).not.toHaveBeenCalled()
    expect(f.manager.collectRuntimeSnapshots).not.toHaveBeenCalled()
    expect(f.manager.listRuntimePins).not.toHaveBeenCalled()
    // A snapshot no pin names any more is collected.
    f.unpinned.push(`sha256-${'9'.repeat(64)}`)
    await f.coordinator.collect()
    expect(f.manager.collectRuntimeSnapshots).toHaveBeenCalledTimes(1)
  })

  it('retains a live session pin even when releasing an active pin for the same snapshot', async () => {
    const f = fixture()
    await f.coordinator.publish(artifact(), async () => {})
    const active = [...f.active.values()][0]!
    const turn: RuntimePin = {
      ...active,
      pinId: 'live-session',
      operationId: 'live-session',
      purpose: 'turn',
    }
    f.active.set(turn.pinId, turn)
    await f.coordinator.revokePackage(packageId)
    await f.coordinator.releaseRetiring(packageId)
    expect([...f.active.keys()]).toEqual([turn.pinId])
    expect(await f.manager.runtimePinRecords('/profile')).toMatchObject({
      pins: [{ pinId: turn.pinId, snapshotId: turn.snapshot.snapshotId }],
      snapshotIds: [turn.snapshot.snapshotId],
    })
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

  it('rejects a trust change during business Worker apply before committing desired', async () => {
    const f = fixture()
    const value = artifact()
    let restored = false
    await expect(
      f.coordinator.publish(
        value,
        async () => {},
        undefined,
        async () => {
          f.setTrusted(false)
          return {
            generation: 1,
            report: { hash: value.identity.treeHash, ok: true, rows: [] },
            restore: async () => {
              restored = true
            },
          }
        },
      ),
    ).rejects.toThrow('E_RUNTIME_TARGET_INVENTORY_STALE')
    expect(restored).toBe(true)
    expect(f.store.desired()).toBeUndefined()
    expect(f.store.configAudit.facts(['ext:acme/pin-test'])).toEqual([])
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

describe('concurrent reconcile publication', () => {
  const alpha = 'acme/alpha'
  const quill = 'acme/quill'
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  function packageDirectory(id: string): string {
    const directory = mkdtempSync(join(tmpdir(), 'agnes-concurrent-reconcile-'))
    directories.push(directory)
    const plugins = [
      { apiRange: '^5.0.0', export: 'main', id: `ext:${id}`, runtime: 'in-process', default: true },
    ]
    writeFileSync(
      join(directory, 'package.json'),
      `${JSON.stringify({ name: id, version: '1.0.0', agnes: { plugins } })}\n`,
    )
    return directory
  }

  function installed(id: string, directory: string, fill: string, enabled: boolean): InstalledPackage {
    return {
      id,
      directory,
      entry: {
        version: '1.0.0',
        integrity: `sha256-${fill.repeat(64)}`,
        treeIntegrity: `sha256-${fill === 'a' ? 'b'.repeat(64) : 'f'.repeat(64)}`,
        source: { kind: 'path', ref: directory },
      } as unknown as InstalledPackage['entry'],
      capabilityHash: 'capability',
      trusted: true,
      enabled,
      contributions: [],
      blockers: [],
      verifiedRollbackTarget: null,
    } as InstalledPackage
  }

  function reconcileFixture() {
    const store = new CompositeTargetStore(sqliteTables().table('composite'), 'default')
    const alphaDirectory = packageDirectory(alpha)
    const quillDirectory = packageDirectory(quill)
    let inventory: InstalledInventory = {
      profile: 'default',
      hash: 'h0',
      packages: [installed(alpha, alphaDirectory, 'a', true)],
    }
    const active = new Map<string, RuntimePin>()
    const manager = {
      inventory: async () => inventory,
      listRuntimePins: async () => [...active.values()],
      runtimePinRecords: async () => records(active.values()),
      pinRuntimeSnapshots: async (
        _directory: string,
        requests: readonly {
          pinId: string
          packageId: string
          selector: { expectedIntegrity: string; expectedTreeIntegrity: string }
        }[],
      ) =>
        requests.map((request) => {
          const pin = {
            pinId: request.pinId,
            operationId: request.pinId,
            purpose: 'active',
            snapshot: {
              snapshotId: request.selector.expectedIntegrity,
              profile: 'default',
              packageId: request.packageId,
              integrity: request.selector.expectedIntegrity,
              treeIntegrity: request.selector.expectedTreeIntegrity,
              version: '1.0.0',
              capabilityHash: 'capability',
              directory: '/immutable/snapshot',
              contributions: [],
            },
          } as unknown as RuntimePin
          active.set(pin.pinId, pin)
          return pin
        }),
      releaseRuntimePins: async (_directory: string, requests: readonly { pinId: string }[]) => {
        for (const request of requests) active.delete(request.pinId)
      },
      collectRuntimeSnapshots: async () => ({ removed: [], retained: [] }),
    } as unknown as PackageManager
    const coordinator = createRuntimePinCoordinator({ store, manager, profileDirectory: '/profile' })
    let gate: Promise<void> | undefined
    let release = () => {}
    let probeEntered = false
    const probe = async () => {
      if (!gate) return
      const held = gate
      gate = undefined
      probeEntered = true
      await held
    }
    let publishCalls = 0
    const activation = createCompositeTargetActivation({
      store,
      probe,
      // The same wiring as the supervisor's activation, counting calls.
      publish: (artifact, check, derivedFrom) => {
        publishCalls++
        return coordinator.publish(artifact, check, derivedFrom)
      },
      collectPins: coordinator.collect,
      revokePackage: coordinator.revokePackage,
      releaseRetiring: coordinator.releaseRetiring,
      desiredFor: async ({ packageId, operation }) =>
        rebuildDesiredFromInventory({
          previous: store.desired(),
          inventory: await manager.inventory('/profile'),
          packageId,
          operation,
          configuration: (rowId) => store.configAudit.value(packageId, rowId),
        }),
    })
    const reconcile = (id: string, operation: 'enable' | 'disable' | 'update') =>
      activation.reconcile({
        profile: 'default',
        packageId: id,
        operationId: `${operation}:${id}`,
        operation,
        signal: new AbortController().signal,
      })
    return {
      store,
      reconcile,
      /** An administrator disabled alpha and approved quill; both lockfile writes committed. */
      disableAlphaAndApproveQuill() {
        inventory = {
          profile: 'default',
          hash: 'h1',
          packages: [
            installed(alpha, alphaDirectory, 'a', false),
            installed(quill, quillDirectory, 'e', true),
          ],
        }
      },
      armGate() {
        gate = new Promise<void>((resolve) => {
          release = resolve
        })
        probeEntered = false
      },
      releaseGate: () => release(),
      probeEntered: () => probeEntered,
      publishCalls: () => publishCalls,
    }
  }

  function summary(target: RuntimeTargetArtifact | undefined) {
    const rows = target ? decodeRuntimeTargetArtifact(target).tree.rows : []
    return {
      alphaDisabled: rows.filter((row) => ownsRow(row.plugin, alpha)).map((row) => row.disabled),
      quillPresent: rows.some((row) => ownsRow(row.plugin, quill)),
    }
  }

  async function waitFor(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (condition()) return
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error('condition did not become true')
  }

  it.each(['sequential', 'target', 'inventory'] as const)(
    'keeps a disable and a concurrent enable both in the desired target (change=%s)',
    async (change) => {
      const f = reconcileFixture()
      expect((await f.reconcile(alpha, 'enable')).error).toBeUndefined()
      expect(summary(f.store.desired())).toEqual({ alphaDisabled: [false], quillPresent: false })
      if (change === 'inventory') {
        f.armGate()
        const enable = f.reconcile(quill, 'update')
        await waitFor(f.probeEntered)
        f.disableAlphaAndApproveQuill()
        f.releaseGate()
        expect((await enable).error).toBeUndefined()
        expect((await f.reconcile(alpha, 'disable')).error).toBeUndefined()
      } else if (change === 'target') {
        f.disableAlphaAndApproveQuill()
        const before = f.publishCalls()
        f.armGate()
        const disable = f.reconcile(alpha, 'disable')
        await waitFor(f.probeEntered)
        // Quill derives from the target alpha has not replaced yet, then queues behind alpha's probe.
        const enable = f.reconcile(quill, 'enable')
        await waitFor(() => f.publishCalls() === before + 2)
        f.releaseGate()
        const [disabled, enabled] = await Promise.all([disable, enable])
        expect([disabled.error, enabled.error]).toEqual([undefined, undefined])
      } else {
        f.disableAlphaAndApproveQuill()
        expect((await f.reconcile(alpha, 'disable')).error).toBeUndefined()
        expect((await f.reconcile(quill, 'enable')).error).toBeUndefined()
      }
      expect(summary(f.store.desired())).toEqual({ alphaDisabled: [true], quillPresent: true })
    },
  )
})
