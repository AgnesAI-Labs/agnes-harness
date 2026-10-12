import { buildCompleteRuntimeTarget } from '@agnes/host-providers/runtime-target-builder'
import type { RuntimeTarget } from '@agnes/plugin-runtime/host'

export const targetRows = (target: RuntimeTarget) => [
  ...new Map(
    [...target.tree.rows, ...Object.values(target.resource.rows).flatMap((row) => (row ? [row] : []))].map(
      (row) => [row.id, row],
    ),
  ).values(),
]

export const liveResource = (id: string) => /^ext:agnes\/mcp-[a-z0-9-]+-[a-f0-9]{8}$/.test(id)
export const liveResourceRow = (row: ReturnType<typeof targetRows>[number]) =>
  liveResource(row.id) && row.plugin.startsWith('builtin:@agnes/base/')
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
