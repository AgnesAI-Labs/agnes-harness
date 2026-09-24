import type { RuntimePluginSnapshot } from '@agnes/package-manager'
import type { RuntimeTarget } from '@agnes/plugin-runtime/host'

function key(packageId: string, snapshotId: string): string {
  return `${packageId}\0${snapshotId}`
}

export function pluginSnapshotIdentity(
  plugin: string,
): Readonly<{ packageId: string; snapshotId: string }> | undefined {
  if (plugin.startsWith('builtin:')) return undefined
  const slash = plugin.lastIndexOf('/')
  const at = slash > 0 ? plugin.lastIndexOf('@', slash) : -1
  if (at <= 0 || slash <= at + 1 || slash === plugin.length - 1) {
    throw new Error(`E_RUNTIME_TARGET_PLUGIN: invalid snapshot plugin identity ${plugin}`)
  }
  return Object.freeze({ packageId: plugin.slice(0, at), snapshotId: plugin.slice(at + 1, slash) })
}

/** Host-owned immutable authority used to resolve every package referenced by a RuntimeTarget. */
export class RuntimePluginCatalogue {
  readonly #byIdentity = new Map<string, Readonly<RuntimePluginSnapshot>>()

  constructor(sources: readonly Readonly<RuntimePluginSnapshot>[]) {
    this.replace(sources)
  }

  replace(sources: readonly Readonly<RuntimePluginSnapshot>[]): void {
    this.#byIdentity.clear()
    for (const source of sources) {
      const identity = key(source.snapshot.packageId, source.snapshot.snapshotId)
      if (this.#byIdentity.has(identity)) {
        throw new Error(
          `E_RUNTIME_TARGET_PLUGIN: duplicate catalogue snapshot ${source.snapshot.packageId}@${source.snapshot.snapshotId}`,
        )
      }
      this.#byIdentity.set(identity, source)
    }
  }

  /** The installed source for one snapshot, as of the latest refresh. */
  get(packageId: string, snapshotId: string): Readonly<RuntimePluginSnapshot> | undefined {
    return this.#byIdentity.get(key(packageId, snapshotId))
  }

  /** What Host inventory knows about one installed snapshot. */
  describe(
    packageId: string,
    snapshotId: string,
  ): Readonly<{ version: string; integrity: string }> | undefined {
    const source = this.#byIdentity.get(key(packageId, snapshotId))
    return source && { version: source.snapshot.version, integrity: source.snapshot.integrity }
  }

  /** Resolve one complete target before importing any candidate module. */
  select(target: RuntimeTarget): readonly Readonly<RuntimePluginSnapshot>[] {
    const selected = new Map<string, Readonly<RuntimePluginSnapshot>>()
    const rows = [...target.tree.rows, ...Object.values(target.resource.rows).filter((row) => row !== null)]
    for (const row of rows) {
      const identity = pluginSnapshotIdentity(row.plugin)
      if (!identity) continue
      const source = this.#byIdentity.get(key(identity.packageId, identity.snapshotId))
      if (!source) {
        throw new Error(
          `E_RUNTIME_TARGET_PLUGIN: unavailable snapshot ${identity.packageId}@${identity.snapshotId}`,
        )
      }
      const previous = selected.get(identity.packageId)
      if (previous && previous.snapshot.snapshotId !== identity.snapshotId) {
        throw new Error(
          `E_RUNTIME_TARGET_PLUGIN: target selects multiple snapshots for ${identity.packageId}`,
        )
      }
      selected.set(identity.packageId, source)
    }
    return Object.freeze(
      [...selected.values()].sort((left, right) =>
        left.snapshot.packageId.localeCompare(right.snapshot.packageId),
      ),
    )
  }
}
