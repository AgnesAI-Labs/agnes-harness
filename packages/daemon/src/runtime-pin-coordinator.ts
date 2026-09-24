import {
  activeRuntimePinId,
  type InstalledInventory,
  isSnapshotPackageEligible,
  type PackageManager,
  type RuntimePin,
  type RuntimeSnapshotSelector,
} from '@agnes/package-manager'
import { decodeRuntimeTargetArtifact, type RuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import { publishProbedRuntimeTarget } from './runtime-target-publisher.js'
import type { CompositeTargetStore } from './storage/composite-target-store.js'

type SnapshotRef = Readonly<{ packageId: string; integrity: string }>

function references(artifact: RuntimeTargetArtifact | undefined): readonly SnapshotRef[] {
  if (!artifact) return []
  const refs = new Map<string, SnapshotRef>()
  for (const row of decodeRuntimeTargetArtifact(artifact).tree.rows) {
    if (row.plugin.startsWith('builtin:')) continue
    const slash = row.plugin.lastIndexOf('/')
    const at = row.plugin.lastIndexOf('@', slash)
    if (slash < 0 || at < 1) continue
    const ref = { packageId: row.plugin.slice(0, at), integrity: row.plugin.slice(at + 1, slash) }
    if (ref.integrity !== row.entryRevision) throw new Error('E_RUNTIME_TARGET_SNAPSHOT_MISMATCH')
    refs.set(activeRuntimePinId(ref), ref)
  }
  return [...refs.values()]
}

export function referencedRuntimePins(store: CompositeTargetStore): ReadonlySet<string> {
  const held = new Set(store.pins())
  for (const artifact of [store.desired(), store.previous(), store.lastGood()])
    for (const ref of references(artifact)) held.add(activeRuntimePinId(ref))
  return held
}

function selector(inventory: InstalledInventory, ref: SnapshotRef): RuntimeSnapshotSelector | undefined {
  const pkg = inventory.packages.find((row) => row.id === ref.packageId)
  if (!pkg || !isSnapshotPackageEligible(pkg)) return undefined
  if (pkg.entry.integrity === ref.integrity && pkg.entry.treeIntegrity)
    return {
      kind: 'installed',
      expectedIntegrity: ref.integrity,
      expectedTreeIntegrity: pkg.entry.treeIntegrity,
    }
  const previous = pkg.verifiedRollbackTarget
  if (previous?.integrity === ref.integrity)
    return {
      kind: 'previous',
      expectedIntegrity: ref.integrity,
      expectedTreeIntegrity: previous.treeIntegrity,
    }
  return undefined
}

/** Serialize target publication and runtime pin collection for one profile. */
export function createRuntimePinCoordinator(
  input: Readonly<{
    store: CompositeTargetStore
    manager: PackageManager
    profileDirectory: string
  }>,
) {
  let tail: Promise<unknown> = Promise.resolve()
  const retiring = new Map<string, ReadonlySet<string>>()
  const exclusive = <T>(task: () => Promise<T>): Promise<T> => {
    const running = tail.then(task, task)
    tail = running.catch(() => undefined)
    return running
  }
  const pins = () => input.manager.listRuntimePins(input.profileDirectory)
  const held = () =>
    new Set([...referencedRuntimePins(input.store), ...[...retiring.values()].flatMap((ids) => [...ids])])
  const collect = async () => {
    const referenced = held()
    for (const pin of await pins()) {
      if (pin.purpose !== 'active' || pin.pinId !== activeRuntimePinId(pin.snapshot)) continue
      if (!referenced.has(pin.pinId))
        await input.manager.releaseRuntimePin(input.profileDirectory, {
          pinId: pin.pinId,
          expectedSnapshotId: pin.snapshot.snapshotId,
        })
    }
    await input.manager.collectRuntimeSnapshots(input.profileDirectory)
  }
  const ensure = async (artifact: RuntimeTargetArtifact): Promise<string> => {
    const inventory = await input.manager.inventory(input.profileDirectory)
    const existing = new Map((await pins()).map((pin) => [pin.pinId, pin]))
    for (const ref of references(artifact)) {
      const id = activeRuntimePinId(ref)
      input.store.pin(id)
      const source = selector(inventory, ref)
      const pkg = inventory.packages.find((row) => row.id === ref.packageId)
      if (!pkg || !isSnapshotPackageEligible(pkg))
        throw new Error(`E_RUNTIME_TARGET_UNTRUSTED: ${ref.packageId}`)
      const prior: RuntimePin | undefined = existing.get(id)
      if (prior) {
        if (
          prior.purpose !== 'active' ||
          prior.snapshot.integrity !== ref.integrity ||
          (source && prior.snapshot.treeIntegrity !== source.expectedTreeIntegrity)
        )
          throw new Error(`E_RUNTIME_TARGET_PIN_MISMATCH: ${ref.packageId}`)
        continue
      }
      if (!source) throw new Error(`E_RUNTIME_TARGET_SNAPSHOT_MISSING: ${ref.packageId}`)
      await input.manager.pinRuntimeSnapshot(input.profileDirectory, {
        pinId: id,
        operationId: id,
        packageId: ref.packageId,
        purpose: 'active',
        selector: source,
      })
    }
    return inventory.hash
  }
  return Object.freeze({
    /** Recover crash leftovers before a worker may boot from a persisted target. */
    recover: () =>
      exclusive(async () => {
        input.store.sweepPins()
        const inventory = await input.manager.inventory(input.profileDirectory)
        const eligible = new Set(inventory.packages.filter(isSnapshotPackageEligible).map((pkg) => pkg.id))
        for (const artifact of [input.store.desired(), input.store.previous(), input.store.lastGood()])
          for (const ref of references(artifact))
            if (!eligible.has(ref.packageId)) input.store.revokePackage(ref.packageId)
        for (const artifact of [input.store.desired(), input.store.previous(), input.store.lastGood()])
          if (artifact) await ensure(artifact)
        input.store.sweepPins()
        await collect()
      }),
    publish: (artifact: RuntimeTargetArtifact, probe: (target: RuntimeTargetArtifact) => Promise<void>) =>
      exclusive(async () => {
        const baseline = input.store.desired()?.digest
        try {
          const inventoryHash = await ensure(artifact)
          await publishProbedRuntimeTarget({
            store: input.store,
            artifact,
            probe: async (target) => {
              await probe(target)
              if (input.store.desired()?.digest !== baseline) throw new Error('E_RUNTIME_TARGET_STALE')
              // PackageManager effects, especially trust revocation, can run during a slow probe.
              const inventory = await input.manager.inventory(input.profileDirectory)
              if (inventory.hash !== inventoryHash) throw new Error('E_RUNTIME_TARGET_INVENTORY_STALE')
              for (const ref of references(target))
                if (
                  !inventory.packages.some(
                    (pkg) => pkg.id === ref.packageId && isSnapshotPackageEligible(pkg),
                  )
                )
                  throw new Error(`E_RUNTIME_TARGET_UNTRUSTED: ${ref.packageId}`)
            },
          })
        } finally {
          input.store.sweepPins()
          await collect()
        }
      }),
    collect: () => exclusive(collect),
    revert: (run: () => Promise<void>) =>
      exclusive(async () => {
        await run()
        await collect()
      }),
    revokePackage: (packageId: string) =>
      exclusive(async () => {
        // A failed removal may retry after the targets were already sanitized. Keep its earlier
        // retiring pins until the worker has actually acknowledged the sanitized target.
        const ids = new Set(retiring.get(packageId) ?? [])
        for (const artifact of [input.store.desired(), input.store.previous(), input.store.lastGood()])
          for (const ref of references(artifact))
            if (ref.packageId === packageId) ids.add(activeRuntimePinId(ref))
        retiring.set(packageId, ids)
        input.store.revokePackage(packageId)
      }),
    releaseRetiring: (packageId: string) =>
      exclusive(async () => {
        retiring.delete(packageId)
        await collect()
      }),
    inspectOrphans: () => exclusive(async () => (await pins()).filter((pin) => !held().has(pin.pinId))),
    releaseOrphans: (pinIds: readonly string[]) =>
      exclusive(async () => {
        const outcomes: Array<Readonly<{ pinId: string; released: boolean }>> = []
        for (const pinId of pinIds) {
          if (held().has(pinId)) {
            outcomes.push({ pinId, released: false })
            continue
          }
          const pin = (await pins()).find((row) => row.pinId === pinId)
          if (pin)
            await input.manager.releaseRuntimePin(input.profileDirectory, {
              pinId,
              expectedSnapshotId: pin.snapshot.snapshotId,
            })
          outcomes.push({ pinId, released: true })
        }
        return outcomes
      }),
  })
}
