import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { PackageError } from './errors.js'
import { type InventoryVerificationCache, readInventoryAsync } from './inventory.js'
import { readBoundary } from './inventory-boundary.js'
import type { Lockfile } from './lockfile.js'
import {
  runtimePluginDataSourcesFromInventory,
  runtimePluginSnapshotsFromPins,
} from './package-plugin-loader.js'
import { listRuntimePinsStoreAsync, type RuntimeSnapshotStore } from './runtime-snapshots.js'
import { invalidatePackageVerification } from './verification-operation.js'

/** Retry torn reads, but keep unexplained byte/policy changes fatal. */
export async function readRuntimePluginSnapshots(
  profileDir: string,
  input: {
    store: RuntimeSnapshotStore
    load(): Lockfile
    ceiling(lock: Lockfile): readonly string[]
    verificationCache: InventoryVerificationCache
  },
) {
  const { store, load, ceiling, verificationCache } = input
  // Package and runtime-snapshot writers publish a journal before moving any tree and replace
  // the lock or runtime state when they commit; either explains a torn lock-free read.
  const committed = () => readBoundary(profileDir, ['agnes-lock.json', '.agnes-runtime-snapshots.json'])
  const transacting = () =>
    ['.agnes-package-transaction.json', '.agnes-runtime-transaction.json'].some((file) =>
      existsSync(join(profileDir, file)),
    )
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) invalidatePackageVerification()
    const boundary = committed()
    try {
      const beforeLock = load()
      const before = await readInventoryAsync(beforeLock, {
        ...store,
        ceiling: ceiling(beforeLock),
        verificationCache,
      })
      const pins = await listRuntimePinsStoreAsync(store, beforeLock)
      const afterLock = load()
      const after = await readInventoryAsync(afterLock, {
        ...store,
        ceiling: ceiling(afterLock),
        verificationCache,
      })
      if (before.hash === after.hash && committed() === boundary && !transacting()) {
        const pinned = runtimePluginSnapshotsFromPins(after, pins)
        const identities = new Set(
          pinned.map(({ snapshot }) => `${snapshot.packageId}\0${snapshot.integrity}`),
        )
        return Object.freeze([
          ...pinned,
          ...runtimePluginDataSourcesFromInventory(after).filter(
            ({ snapshot }) => !identities.has(`${snapshot.packageId}\0${snapshot.integrity}`),
          ),
        ])
      }
    } catch (error) {
      // A failure no writer explains is tampering and stays fatal; otherwise let the writer finish.
      if (!transacting() && committed() === boundary) throw error
      invalidatePackageVerification()
      await delay(50 * (attempt + 1))
    }
  }
  throw new PackageError('E_LOCK_MISMATCH', 'runtime source changed during snapshot read', {
    detail: { reason: 'runtime-source-stale' },
  })
}
