import type { Context } from '@agnes/cordis'
import type { ExtensionFactory, ExtensionManifest } from '@agnes/extension-api'
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

/** Builtin extensions supplied by their own `ext:` row. Skills has one Host-owned row refreshed
 * at the next turn; the retired mcp-client id remains reserved in the resource target format. */
export const EXT_ROW_EXTENSION_IDS: ReadonlySet<string> = new Set([
  'agnes/tools-core',
  'agnes/tools-search',
  'agnes/tools-web',
  'agnes/compaction',
  'agnes/refine',
  'agnes/subagent',
  'agnes/computer-use',
  'agnes/code-mode',
  'agnes/hooks-runner',
  'agnes/privacy',
  'agnes/mcp-search',
  'agnes/skills',
])

/**
 * Fixed dispatch position for the built-in hook layer (third-party-transform-directive-hooks design
 * §3 point 2), keyed the same way `EXTENSION_ROW_GRANTS` below is (`ext:<extension id>`). The order
 * is measured, not assumed: `agnes/skills` has a dedicated early row and also appears in
 * `EXT_ROW_EXTENSION_IDS`; deduplicating gives it the early rank exactly once. Every other
 * ext-row id follows `EXT_ROW_EXTENSION_IDS`'s own declared iteration order, which is what
 * actually drives row-build order today (`assemble.ts`'s `for (const extensionId of
 * EXT_ROW_EXTENSION_IDS)` loops) - `base-tools.test.ts`'s `host.extensions()` order assertion is the
 * empirical proof for every id present in that profile. `agnes/code-mode` is not enabled in that
 * profile, so its rank is inferred from its position in the same declared list rather than
 * separately measured. A fixed table, not registration order, survives hot-reload/reconciliation
 * re-registering a built-in: registration order alone would push it behind the third-party layer.
 */
export const BUILTIN_HOOK_RANKS: ReadonlyMap<string, number> = new Map(
  [...new Set(['agnes/skills', ...EXT_ROW_EXTENSION_IDS])].map((id, index) => [`ext:${id}`, index]),
)

/**
 * An extension that exists only at runtime, one instance per resource (an MCP server): stage 2b,
 * D107′. Its spec and manifest are supplied by the composition layer instead of being read from a
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
}>

/** Builtin extensions whose `ext:` row supplies them through the shared row host. */
export const MIGRATED_EXTENSION_IDS: ReadonlySet<string> = new Set([
  'agnes/tools-search',
  'agnes/tools-core',
  'agnes/tools-web',
  'agnes/compaction',
  'agnes/code-mode',
  'agnes/subagent',
  'agnes/refine',
  'agnes/privacy',
  'agnes/computer-use',
  'agnes/hooks-runner',
  'agnes/mcp-search',
  'agnes/skills',
])

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
  load(): Promise<BuiltinRowHandle>
}>

/** The lifecycle of a migrated row. A failed load leaves the row mounted and empty, as before. */
export function createFacadeRowPlugin(input: FacadeRowLifecycleInput) {
  return async (_ctx: Context, _config: unknown) => {
    const handle = await input.load()
    return () => handle.release('operator')
  }
}

export function buildExtensionRow(
  input: Readonly<{
    extensionId: string
    packageId: string
    entryRevision: string
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
    extrasRevision: EMPTY_EXTRAS_REVISION,
    mountRevision: EXT_ROW_MOUNT_REVISION,
    ...(input.config === undefined ? {} : { config: input.config }),
    inject: [],
    provides: [],
    ...(input.disabled === undefined ? {} : { disabled: input.disabled }),
  })
  return Object.freeze({ row, claim: Object.freeze({ row, entry }) })
}

/** Privileged inputs a builtin ext: row may receive, keyed on the ROW id. A row is the only way an
 * id gets here through the tree - a third-party ROW never obtains a builtin claim (the publisher
 * refuses it with E_RUNTIME_TARGET_STATIC_CLAIM) and `host:`/`spine:` ids and provides are refused
 * outright (plugin-runtime/src/row-mount.ts:502-509). The table is NOT self-sufficient, though:
 * its consumer (`buildEcosystemContext`) runs for every extension the factory selector loads, rows
 * and non-rows alike, so the owner must be checked too - see `extensionRowGrantFor`. */
export const EXTENSION_ROW_GRANTS: ReadonlyMap<string, Readonly<{ computerUse: true }>> = new Map([
  ['ext:agnes/computer-use', Object.freeze({ computerUse: true as const })],
])

/** The only package whose extensions may receive a builtin row's privileged inputs. */
const BUILTIN_ROW_OWNER = '@agnes/base'

/**
 * The privileged inputs `extensionId` may receive when supplied by `owner`, or undefined.
 *
 * Two independent conditions, deliberately. The row-id table decides WHICH extension gets a grant.
 * The owner check is defence in depth and stays until stage 2: nothing reserves the `agnes/` id
 * scope at runtime, so a TRUSTED THIRD-PARTY package whose root manifest id is `agnes/computer-use`
 * is loaded by assemble's own `specs` loop with the same extension id, reaching the same context
 * builder without ever being a row. On the row-id table alone it would be handed the Computer Use
 * backend provider.
 */
export function extensionRowGrantFor(
  owner: string,
  extensionId: string,
): Readonly<{ computerUse: true }> | undefined {
  return owner === BUILTIN_ROW_OWNER ? EXTENSION_ROW_GRANTS.get(`ext:${extensionId}`) : undefined
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
  const owned = new Set([...EXT_ROW_EXTENSION_IDS].map((id) => `ext:${id}`))
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
