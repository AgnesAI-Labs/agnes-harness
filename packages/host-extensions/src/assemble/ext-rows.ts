import type { Context } from '@agnes/cordis'
import type { ExtensionManifest } from '@agnes/extension-api'
import type { ExtensionFactory } from '@agnes/extension-api/host'
import {
  createPluginRow,
  EMPTY_EXTRAS_REVISION,
  normalizePluginExport,
  type PluginRow,
  RESOURCE_OWNED_ROW_IDS,
} from '@agnes/plugin-runtime/host'
import type { BuiltinRowHandle } from '../ext-host/builtin-row-host.js'
import type { ExtensionSpec } from '../ext-host/index.js'
import type { SeamInitContext } from './packages.js'
import type { HostBuiltinRowClaim } from './seams-cordis.js'

/** The mount-identity discriminator that routes a row to the ext-row importer. NOT the `ext:` id
 * prefix: `ext:<pkg>/<export>` is the default id of every `agnes.plugins` entry
 * (packages/package-manager/src/plugin-manifest.ts:72), so routing on the prefix would hijack
 * ordinary third-party Cordis rows. */
export const EXT_ROW_MOUNT_REVISION = 'host-ext-row:v1'
/** Only Host-owned live resource factories receive this mount identity. */
export const LIVE_RESOURCE_MOUNT_REVISION = 'host-live-resource:v1'

export {
  RELEASE_EXTENSION_IDS as EXT_ROW_EXTENSION_IDS,
  RELEASE_HOOK_RANKS as BUILTIN_HOOK_RANKS,
} from '@agnes/package-manager'

import { RELEASE_EXTENSION_IDS } from '@agnes/package-manager'

/**
 * An extension that exists only at runtime, one instance per resource (an MCP server).
 * Its spec and manifest are supplied by the composition layer instead of being read from a
 * package on disk, and it is loaded through the row-owned builtin facade. The row id is
 * `ext:<spec.id>`, and the row owns whatever the factory opens: unmounting the row closes it.
 *
 * `factory` receives the same `SeamInitContext` a bundled ecosystem factory gets for its
 * owner/extension id (`buildEcosystemContext(spec.package, spec.id)`). That is how per-Host shared
 * state reaches a dynamic row without Host core importing the package that defines it: e.g. every
 * MCP server row and `agnes/mcp-search` reach one `McpCatalogHub` through
 * `mcpCatalogHubFor(ctx)` (@agnes/base), keyed by this Host's `ctx.signal`. Host core only hands the
 * context over; it never sees what is built from it (see host/test/boundary.test.ts).
 */
export type DynamicExtension = Readonly<{
  spec: ExtensionSpec
  manifest: ExtensionManifest
  factory: (ctx: SeamInitContext) => ExtensionFactory | undefined | Promise<ExtensionFactory | undefined>
  /** Declarative private input from which a worker can recreate this factory after restart. */
  generation?: Readonly<{ kind: string; data: import('@agnes/protocol').JsonValue }>
}>

/** Migrated and declared row identities have identical membership. */
export const MIGRATED_EXTENSION_IDS = RELEASE_EXTENSION_IDS

export type ExtRowLoadResult = Readonly<{
  id: string
  loaded: boolean
  error?: { code?: string; message?: string }
}>

/** The managed ext host as the row sees it. `load` RESOLVES with an error rather than rejecting
 * (ext-host/managed-host.ts:206-212), so `apply` has to inspect the result itself. */
export type ExtRowLoader = Readonly<{
  load(extensionId: string): Promise<ExtRowLoadResult>
  revoke(extensionId: string, reason: string): Promise<void>
}>

const extRowConfig = Object.freeze({
  '~standard': Object.freeze({
    version: 1 as const,
    vendor: 'agnes-host',
    validate(value: unknown) {
      if (value === undefined) return { value: Object.freeze({}) }
      if (!value || typeof value !== 'object' || Array.isArray(value))
        return { issues: [{ message: 'ext row config must be an object' }] }
      return { value }
    },
  }),
})

export type BuiltExtensionRow = Readonly<{
  row: ReturnType<typeof createPluginRow>
  claim: Readonly<HostBuiltinRowClaim>
}>

export type ExtensionRowLifecycleInput = Readonly<{
  extensionId: string
  loader: ExtRowLoader
  /**
   * Which row instance currently owns the managed-host record for this extension id. The managed
   * ext host is ONE process-wide registry shared by the live tree and every candidate tree, while
   * applyRuntimeTarget builds the candidate tree BEFORE retiring the old one. So the new row's
   * apply must evict the incumbent itself, and the old row's disposer must not evict a record a
   * newer row already took over.
   */
  owners: Map<string, symbol>
  /**
   * Where a failed retire is reported. The old tree is retired AFTER applyRuntimeTarget resolves,
   * so a rejecting disposer reaches no caller at all; without this the row silently stays loaded
   * while the convergence report already says it is gone.
   */
  onDisposeError?: (error: unknown) => void
}>

/** The row's whole lifecycle, exported on its own so it can be tested directly: a VerifiedRowEntry
 * only carries an opaque `prepared` (row-mount.ts:35-39), so the callback is unreachable from there. */
export function createExtensionRowPlugin(input: ExtensionRowLifecycleInput) {
  const id = `ext:${input.extensionId}`
  return async (_ctx: Context, _config: unknown) => {
    const token = Symbol(id)
    if (input.owners.has(input.extensionId)) await input.loader.revoke(input.extensionId, 'operator')
    const status = await input.loader.load(input.extensionId)
    if (status.error) {
      // A failed load does not fail the row. managed.load has already audited `extension.failed` and
      // left a dead record (loaded=false, nothing held) that the next apply may overwrite. Throwing
      // would reject the whole candidate tree, and at assembly there is no last-good tree: Host
      // would not exist because ONE extension failed to load. So the row mounts empty and owns
      // nothing; the failure stays visible in host.extensions() and the audit, not in the report.
      input.owners.delete(input.extensionId)
      return async () => {}
    }
    input.owners.set(input.extensionId, token)
    return async () => {
      if (input.owners.get(input.extensionId) !== token) return
      input.owners.delete(input.extensionId)
      try {
        await input.loader.revoke(input.extensionId, 'operator')
      } catch (error) {
        // The old tree is retired AFTER applyRuntimeTarget resolves, so nothing upstream will ever
        // see this rejection: without this hook the row silently stays loaded while the report says
        // it is gone. Report first, then rethrow for whoever does look.
        input.onDisposeError?.(error)
        throw error
      }
    }
  }
}

export type FacadeRowLifecycleInput = Readonly<{
  /** Loads the extension for this row. Resolves with a handle even when the load failed. */
  load(config?: unknown): Promise<BuiltinRowHandle>
}>

/** The lifecycle of a migrated row. A failed load leaves the row mounted and empty, as before. */
export function createFacadeRowPlugin(input: FacadeRowLifecycleInput) {
  return async (_ctx: Context, _config: unknown) => {
    const handle = await input.load(_config)
    return () => handle.release('operator')
  }
}

export function buildExtensionRow(
  input: Readonly<{
    extensionId: string
    packageId: string
    entryRevision: string
    liveResource?: boolean
    liveResources?: readonly string[]
    liveResourceRevision?: string
    /** Set for a migrated id; otherwise the managed host's `loader` and `owners` carry the lifecycle. */
    facade?: FacadeRowLifecycleInput
    loader: ExtRowLoader
    owners: Map<string, symbol>
    onDisposeError?: (error: unknown) => void
    config?: unknown
    disabled?: boolean
  }>,
): BuiltExtensionRow {
  const id = `ext:${input.extensionId}`
  const lifecycle = input.facade ? createFacadeRowPlugin(input.facade) : createExtensionRowPlugin(input)
  const plugin = Object.assign(lifecycle, { Config: extRowConfig })
  const entry = normalizePluginExport(plugin)
  const row = createPluginRow({
    id,
    plugin: `builtin:${input.packageId}/${input.extensionId.split('/').pop() as string}`,
    snapshotDigest: EXT_ROW_MOUNT_REVISION,
    exportName: input.extensionId,
    entryRevision: input.entryRevision,
    ...(input.liveResources === undefined ? {} : { liveResources: input.liveResources }),
    ...(input.liveResourceRevision === undefined ? {} : { liveResourceRevision: input.liveResourceRevision }),
    extrasRevision: EMPTY_EXTRAS_REVISION,
    mountRevision: input.liveResource ? LIVE_RESOURCE_MOUNT_REVISION : EXT_ROW_MOUNT_REVISION,
    ...(input.config === undefined ? {} : { config: input.config }),
    inject: [],
    provides: [],
    ...(input.disabled === undefined ? {} : { disabled: input.disabled }),
  })
  return Object.freeze({ row, claim: Object.freeze({ row, entry, ownerPackage: input.packageId }) })
}

/** The part of the published target this module reads. Structural on purpose: the guard on the
 * runtime-target symbol (tools/guards/cordis-migration-symbols) keeps that name out of files a
 * design review has not signed off, and a published target satisfies this shape as it is. */
type PublishedTargetView = Readonly<{
  tree: Readonly<{ rows: readonly unknown[] }>
  resource: Readonly<{
    rows: Readonly<Record<string, unknown>>
    resources: Readonly<{ mcp: unknown; skills: unknown }>
  }>
}>

/**
 * The complete row set and resources for a target in which ONLY the ext: rows change.
 *
 * `applyRuntimeTarget` never diffs, it rebuilds the whole tree from what it is handed, so a target
 * built from a boot-time snapshot would silently discard whatever was published since (the daemon's
 * rows, the live resources). Only the builtin `ext:<id>` rows this surface owns are replaced by `rows`.
 */
export function composeExtensionRowTarget(
  input: Readonly<{
    live: PublishedTargetView | undefined
    /** Used only when nothing has been published yet. */
    fallbackRows: readonly Readonly<PluginRow>[]
    rows: readonly Readonly<PluginRow>[]
    /** Row ids that belong to this surface beyond the static builtin ids (dynamic resource rows). */
    extraOwnedRowIds?: ReadonlySet<string>
  }>,
): Readonly<{
  rows: readonly Readonly<PluginRow>[]
  resources: Readonly<{ mcp: unknown; skills: unknown }>
}> {
  const owned = new Set([...RELEASE_EXTENSION_IDS].map((id) => `ext:${id}`))
  for (const id of input.extraOwnedRowIds ?? []) owned.add(id)
  const published: readonly Readonly<PluginRow>[] = input.live
    ? [
        ...(input.live.tree.rows as readonly Readonly<PluginRow>[]),
        ...(RESOURCE_OWNED_ROW_IDS.flatMap(
          (id) => input.live?.resource.rows[id] ?? [],
        ) as Readonly<PluginRow>[]),
      ]
    : input.fallbackRows
  const kept = published.filter(
    (row) => !owned.has(row.id) || (!row.plugin.startsWith('builtin:') && !row.disabled),
  )
  return Object.freeze({
    rows: Object.freeze([...kept, ...input.rows.filter((row) => !kept.some((k) => k.id === row.id))]),
    resources: input.live?.resource.resources ?? { mcp: [], skills: {} },
  })
}
