import { pluginRowSource } from '@agnes/host-extensions/ext-host/row-extension-host'
import { pluginSnapshotIdentity } from '@agnes/host-providers/runtime-plugin-catalogue'
import { createTreeSnapshot, type RuntimeTarget } from '@agnes/plugin-runtime/host'
import type { ProcessServices } from './process-services.js'
import type { RowHosts } from './row-hosts.js'

/** The current profile alone publishes activation epochs and owns managed background resources. */
export function publishProfileActivations(
  proc: ProcessServices,
  catalogue: RowHosts['pluginCatalogue'],
  target: RuntimeTarget,
): void {
  proc.profileActivations.publish(
    target.tree.rows.flatMap((row) => {
      if (row.disabled) return []
      const identity = pluginSnapshotIdentity(row.plugin)
      const description = identity && catalogue.describe(identity.packageId, identity.snapshotId)
      return description
        ? [
            {
              owner: pluginRowSource(row.id),
              revision: createTreeSnapshot([row]).hash,
              integrity: description.integrity,
            },
          ]
        : []
    }),
  )
  void proc.profileManaged.publish().catch(() => undefined)
}
