import { createLivePackageSnapshotVerifier, type RuntimePluginSnapshot } from '@agnes/package-manager'
import {
  assertPublishableRows,
  buildRuntimeTarget,
  decodeRuntimeTargetArtifact,
  type EntryRow,
  encodeRuntimeTargetArtifact,
  type HostPluginImporterFactory,
  isResourceOwnedRowId,
  type RuntimeTarget,
} from '@agnes/plugin-runtime/host'
import {
  assembleOrdinaryPluginTree,
  type HostPluginTreeBase,
  type HostPrivatePluginTreeInput,
} from './assemble/seams-cordis.js'
import { type CandidateRuntime, stageCandidateRuntime } from './runtime-candidate.js'
import type { RuntimePluginCatalogue } from './runtime-plugin-catalogue.js'

/**
 * The ordinary half of an invisible C2 runtime candidate.
 *
 * Resource-owned rows deliberately are not mounted here. They are still selected and verified
 * through the same immutable catalogue before this function imports an ordinary row, so a target
 * with a missing resource snapshot cannot publish a tree-only partial candidate.
 */
export type RuntimeTargetOrdinaryAssembly = Readonly<{
  target: RuntimeTarget
  sources: readonly Readonly<RuntimePluginSnapshot>[]
  pluginTree: HostPluginTreeBase
  close(): Promise<void>
}>

/**
 * Return the canonical target consumed by the Host ordinary transaction.
 * `web:` rows remain in the complete target/artifact, but they are not Cordis rows and must never
 * reach Host snapshot claims or EntryTree activation.
 */
export function filterRuntimeTargetOrdinary(target: RuntimeTarget): RuntimeTarget {
  const canonical = decodeRuntimeTargetArtifact(encodeRuntimeTargetArtifact(target))
  const rows = [
    ...canonical.tree.rows.filter((row) => !row.id.startsWith('web:') && !row.plugin.startsWith('web:')),
    ...Object.values(canonical.resource.rows).flatMap((row) => (row ? [row] : [])),
  ]
  return buildRuntimeTarget({
    rows,
    resources: canonical.resource.resources,
    resourceRevision: canonical.resource.target.resourceRevision,
    compositeRevision: canonical.resource.target.compositeRevision,
  })
}

/** Build the immutable ordinary row list, including Host-static boot rows. */
export function runtimeTargetOrdinaryRows(
  target: RuntimeTarget,
  hostStaticRows?: readonly Readonly<EntryRow>[],
): readonly Readonly<EntryRow>[] {
  const ordinary = filterRuntimeTargetOrdinary(target)
  return mergeHostStaticBootRows(hostStaticRows, ordinary.tree.rows)
}

export type RuntimeTargetOrdinaryAssemblerOptions = Readonly<{
  /** May contain cached inactive snapshots; only target-referenced snapshots are selected. */
  catalogue: RuntimePluginCatalogue
  /** The complete artifact target received from the daemon/probe path. */
  target: RuntimeTarget
  /**
   * Candidate-local importer construction. It must load claims from `sources`, never reuse the
   * live Host's mutable package gate or tree. The verified snapshot authority is supplied by this
   * assembler from exactly the selected immutable snapshots.
   */
  createPluginImporter?: (
    sources: readonly Readonly<RuntimePluginSnapshot>[],
  ) => HostPluginImporterFactory | undefined
  /** How long the candidate tree may take to start before it is abandoned; see the tree assembly. */
  startTimeoutMs?: number
  /**
   * Host-private builtin claims, exact extras, and static boot rows (preset/seam/builtin). Desired
   * ordinary rows overlay those static rows; they do not replace the required Host-static set.
   */
  privateInput?: HostPrivatePluginTreeInput
}>

/**
 * Build an independent ordinary Cordis tree for one canonical target.
 *
 * This is intentionally a narrow candidate primitive: it owns neither resource generation nor
 * session overlays. Its only side effect is a newly allocated tree, which callers must close on
 * candidate abort or old-runtime retirement.
 */
export async function assembleRuntimeTargetOrdinaryCandidate(
  options: RuntimeTargetOrdinaryAssemblerOptions,
): Promise<RuntimeTargetOrdinaryAssembly> {
  // RuntimeTarget is a TypeScript shape at this boundary. Re-encoding then decoding gives this
  // Host-only entry point the same canonical/full-shape verification as a wire artifact.
  const target = filterRuntimeTargetOrdinary(options.target)
  const owned = target.tree.rows.find((row) => isResourceOwnedRowId(row.id))
  if (owned) {
    throw new Error(`E_RESOURCE_OWNED_ORDINARY: ${owned.id} cannot enter the ordinary tree`)
  }
  assertPublishableRows(target.tree.rows)
  // Resolve every ordinary and resource-owned row before the first candidate module import.
  const sources = options.catalogue.select(target)
  // The tree outlives this target: mounts in later deliveries, compensation and rollback all verify
  // against what is installed and trusted at that moment, not against this target's selection.
  const snapshots = createLivePackageSnapshotVerifier((packageId, snapshotId) =>
    options.catalogue.get(packageId, snapshotId),
  )
  const pluginImporter = options.createPluginImporter?.(sources)
  const ordinary = await assembleOrdinaryPluginTree(
    {
      snapshots,
      ...(pluginImporter ? { pluginImporter } : {}),
      ...(options.startTimeoutMs === undefined ? {} : { startTimeoutMs: options.startTimeoutMs }),
    },
    {
      ...options.privateInput,
      bootRows: runtimeTargetOrdinaryRows(target, options.privateInput?.bootRows),
    },
  )
  return Object.freeze({
    target,
    sources,
    pluginTree: ordinary.pluginTree,
    close: () => ordinary.close(),
  })
}

/**
 * Stage the ordinary candidate with CandidateRuntime-owned abort cleanup.
 *
 * A successful commit intentionally leaves the tree open; RuntimeState retirement owns `close()`
 * for the previous published assembly. An abort closes this never-published tree in reverse
 * candidate cleanup order.
 */
export function stageRuntimeTargetOrdinaryCandidate(
  options: RuntimeTargetOrdinaryAssemblerOptions,
): Promise<CandidateRuntime<RuntimeTargetOrdinaryAssembly>> {
  return stageCandidateRuntime({
    async build(builder) {
      const assembly = await assembleRuntimeTargetOrdinaryCandidate(options)
      builder.onAbort('ordinary-cordis-tree', () => assembly.close())
      return assembly
    },
  })
}

function mergeHostStaticBootRows(
  hostStatic: HostPrivatePluginTreeInput['bootRows'],
  desired: NonNullable<HostPrivatePluginTreeInput['bootRows']>,
): NonNullable<HostPrivatePluginTreeInput['bootRows']> {
  if (!hostStatic?.length) return desired
  const byId = new Map<string, (typeof desired)[number]>()
  const order: string[] = []
  for (const row of hostStatic) {
    if (!byId.has(row.id)) order.push(row.id)
    byId.set(row.id, row)
  }
  for (const row of desired) {
    // A package row that is switched off replaces nothing: the Host's own row keeps the id.
    if (row.disabled && !row.plugin.startsWith('builtin:') && byId.has(row.id)) continue
    if (!byId.has(row.id)) order.push(row.id)
    byId.set(row.id, row)
  }
  const merged = []
  for (const id of order) {
    const row = byId.get(id)
    if (row) merged.push(row)
  }
  return Object.freeze(merged)
}
