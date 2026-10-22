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
import { invalidatePackageVerification, withPackageVerification } from './verification-operation.js'

/** Share only an unfinished read with the same policy/runtime boundary, never a completed verdict. */
export function createRuntimeSourceReader() {
  const pending = new Map<
    string,
    { boundary: string; promise: ReturnType<typeof readRuntimePluginSnapshots> }
  >()
  return (profileDir: string, input: Parameters<typeof readRuntimePluginSnapshots>[1]) =>
    withPackageVerification(async () => {
      const boundary = readBoundary(profileDir, [
        'agnes-lock.json',
        'plugin-capabilities.json',
        'package-sources.json',
        '.agnes-runtime-snapshots.json',
        '.agnes-package-transaction.json',
        '.agnes-runtime-transaction.json',
      ])
      const prior = pending.get(profileDir)
      if (prior?.boundary === boundary) return prior.promise
      let promise: ReturnType<typeof readRuntimePluginSnapshots>
      const clear = () => {
        if (pending.get(profileDir)?.promise === promise) pending.delete(profileDir)
      }
      promise = readRuntimePluginSnapshots(profileDir, input).then(
        (value) => {
          clear()
          return value
        },
        (error) => {
          clear()
          throw error
        },
      )
      pending.set(profileDir, { boundary, promise })
      return promise
    })
}

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
    let writerObserved = transacting()
    try {
      const beforeLock = load()
      // Both reads use the same captured lock and have no publication side effects.
      // Settle both before rechecking the lock/policy boundary or starting a retry.
      const [inventoryRead, pinsRead] = await Promise.allSettled([
        readInventoryAsync(beforeLock, {
          ...store,
          ceiling: ceiling(beforeLock),
          verificationCache,
        }),
        listRuntimePinsStoreAsync(store, beforeLock),
      ])
      writerObserved ||= transacting()
      if (inventoryRead.status === 'rejected') throw inventoryRead.reason
      if (pinsRead.status === 'rejected') throw pinsRead.reason
      const before = inventoryRead.value,
        pins = pinsRead.value
      const afterLock = load()
      const after = await readInventoryAsync(afterLock, {
        ...store,
        ceiling: ceiling(afterLock),
        verificationCache,
      })
      writerObserved ||= transacting()
      if (before.hash === after.hash && committed() === boundary && !writerObserved) {
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
      // A verified read can still straddle an announced write. Give that writer the same
      // backoff as the exception path, rather than consuming every retry while it is active.
      if (writerObserved || committed() !== boundary) await delay(50 * (attempt + 1))
    } catch (error) {
      // A failure no writer explains is tampering and stays fatal; otherwise let the writer finish.
      if (!writerObserved && !transacting() && committed() === boundary) throw error
      invalidatePackageVerification()
      await delay(50 * (attempt + 1))
    }
  }
  throw new PackageError('E_LOCK_MISMATCH', 'runtime source changed during snapshot read', {
    detail: { reason: 'runtime-source-stale' },
  })
}
