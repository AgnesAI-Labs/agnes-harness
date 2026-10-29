import { LIVE_RESOURCE_MOUNT_REVISION } from '@agnes/host-extensions/assemble/ext-rows'
import type { OrdinaryPluginLayers } from '@agnes/host-providers/assemble/ordinary-rows'
import { pluginSnapshotIdentity } from '@agnes/host-providers/runtime-plugin-catalogue'
import { buildCompleteRuntimeTarget } from '@agnes/host-providers/runtime-target-builder'
import type { PluginRow, RuntimeTarget } from '@agnes/plugin-runtime/host'

export const targetRows = (target: RuntimeTarget) => [
  ...new Map(
    [...target.tree.rows, ...Object.values(target.resource.rows).flatMap((row) => (row ? [row] : []))].map(
      (row) => [row.id, row],
    ),
  ).values(),
]

export const liveResourceRow = (row: ReturnType<typeof targetRows>[number]) =>
  row.mountRevision === LIVE_RESOURCE_MOUNT_REVISION && row.plugin.startsWith('builtin:')
export const codeRow = (row: ReturnType<typeof targetRows>[number]) => {
  if (!row.liveResources?.length) return row
  const { liveResourceRevision: _revision, mountIdentity: _mount, ...code } = row
  // All code/ownership fields stay in the fingerprint; the derived mount identity also includes resources.
  return { ...code, mountIdentity: row.codeMountIdentity ?? row.mountIdentity }
}
export const codeRevision = (target: RuntimeTarget) =>
  buildCompleteRuntimeTarget({
    rows: targetRows(target)
      .filter((row) => !liveResourceRow(row))
      .map(codeRow),
    resources: { mcp: [], skills: {} },
  }).artifact.digest

export const registryCodeRevision = (target: RuntimeTarget) =>
  codeRevision(
    buildCompleteRuntimeTarget({
      rows: targetRows(target).filter((row) => !row.id.startsWith('web:') && !row.plugin.startsWith('web:')),
      resources: { mcp: [], skills: {} },
    }).target,
  )

/** Apply the selected snapshot's config before its schema is checked during assembly. */
export function pluginWorkspaceLayers(
  rows: readonly PluginRow[],
  layers?: OrdinaryPluginLayers,
): OrdinaryPluginLayers {
  return {
    ...layers,
    workspace: {
      ...layers?.workspace,
      ...Object.fromEntries(
        rows
          .filter((row) => pluginSnapshotIdentity(row.plugin))
          .map((row) => [
            row.id,
            { enabled: !row.disabled, ...(row.config === undefined ? {} : { config: row.config }) },
          ]),
      ),
    },
  }
}
