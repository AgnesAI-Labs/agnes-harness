import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { InstalledInventory, InstalledPackage } from '@agnes/package-manager'
import {
  installedRuntimeSnapshotId,
  isRuntimePackageEligible,
  parseAgnesPluginEntries,
} from '@agnes/package-manager'
import {
  buildRuntimeTarget,
  createPluginRow,
  decodeRuntimeTargetArtifact,
  encodeRuntimeTargetArtifact,
  isResourceOwnedRowId,
  type PluginRow,
  type RuntimeTargetArtifact,
} from '@agnes/plugin-runtime/host'

export type CompositeDesiredOperation = 'enable' | 'disable' | 'update' | 'rollback' | 'remove'

const ORDINARY_MOUNT_REVISION = 'host-ordinary-row:v1'
const WEB_MOUNT_REVISION = 'host-web-row:v1'

function digestHex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function ownsRow(plugin: string, packageId: string): boolean {
  return plugin.startsWith(`builtin:${packageId}/`) || plugin.startsWith(`${packageId}@`)
}

/**
 * The package a row's plugin string names. Mirrors how the Host parses it, but answers undefined for
 * a malformed string: a row that cannot be attributed must not break a revert.
 */
export function packageOfRow(plugin: string): string | undefined {
  if (plugin.startsWith('builtin:')) {
    const value = plugin.slice('builtin:'.length)
    const slash = value.lastIndexOf('/')
    if (slash <= 0 || slash === value.length - 1) return undefined
    return value.slice(0, slash)
  }
  const slash = plugin.lastIndexOf('/')
  const at = slash > 0 ? plugin.lastIndexOf('@', slash) : -1
  if (at <= 0 || slash <= at + 1 || slash === plugin.length - 1) return undefined
  return plugin.slice(0, at)
}

/**
 * Runtime row identity is deliberately finer grained than package identity.
 * A package remains the security/installation subject, while every declared
 * client extension gets an independently reconcilable browser row.  Retain
 * the original id for a one-client package so existing persisted targets do
 * not churn merely because this capability was introduced.
 */
export function clientModuleRowId(packageId: string, extensionId: string, clientCount: number): string {
  return clientModuleRowIdForContribution(packageId, extensionId, clientCount, extensionId)
}

/** Resolve row identity without using entry/style paths or declaration order. */
export function clientModuleRowIdForContribution(
  packageId: string,
  _extensionId: string,
  clientCount: number,
  contributionId: string,
): string {
  if (clientCount === 1) return `web:${packageId}`
  const readable = `web:${packageId}:${contributionId}`
  // The browser protocol bounds a row id to 256 bytes while package/extension
  // identifiers have independent maxima. Keep the readable form where it is
  // valid, and use a deterministic full digest rather than truncating either
  // identity (truncation could silently collide and join two lifecycle lanes).
  if (readable.length <= 256) return readable
  return `web:${createHash('sha256').update(`${packageId}\0${contributionId}`).digest('hex')}`
}

function withDisabled(row: Readonly<PluginRow>, disabled: boolean): Readonly<PluginRow> {
  return Object.freeze({ ...row, disabled })
}

function pluginsFromPackage(pkg: InstalledPackage): ReturnType<typeof parseAgnesPluginEntries> {
  if (!pkg.directory) return Object.freeze([])
  try {
    const manifest = JSON.parse(readFileSync(join(pkg.directory, 'package.json'), 'utf8')) as {
      agnes?: { plugins?: unknown }
    }
    return parseAgnesPluginEntries(pkg.id, manifest.agnes?.plugins)
  } catch {
    return Object.freeze([])
  }
}

function rowsForPackage(pkg: InstalledPackage, disabled: boolean): readonly Readonly<PluginRow>[] {
  const snapshotId = installedRuntimeSnapshotId(pkg)
  const rows: Readonly<PluginRow>[] = []
  for (const entry of pluginsFromPackage(pkg)) {
    // Package declarations own only third-party `ext:` rows. The daemon alone mints `web:` rows
    // from verified client contributions, so a manifest can never forge a browser mount.
    if (isResourceOwnedRowId(entry.id) || !entry.id.startsWith('ext:')) continue
    rows.push(
      createPluginRow({
        id: entry.id,
        plugin: `${pkg.id}@${snapshotId}/${entry.export}`,
        snapshotDigest: snapshotId,
        exportName: entry.export,
        entryRevision: snapshotId,
        extrasRevision: 'none',
        mountRevision: ORDINARY_MOUNT_REVISION,
        ...(entry.config === undefined ? {} : { config: entry.config }),
        // The daemon never imports the module, so the row's service metadata comes from the manifest
        // declaration. The mount checks it against the export's own metadata and refuses a mismatch.
        ...(entry.inject === undefined ? {} : { inject: entry.inject }),
        ...(entry.provide === undefined ? {} : { provides: entry.provide }),
        runtime: entry.runtime,
        disabled,
      }),
    )
  }
  const clientContributions = pkg.contributions.filter(
    (contribution): contribution is Extract<typeof contribution, { kind: 'client' | 'extension' }> =>
      (contribution.kind === 'client' && 'client' in contribution) ||
      (contribution.kind === 'extension' && contribution.client !== undefined),
  )
  // Every verified source gets a daemon-owned row.  Package identity remains
  // in the plugin locator; row identity controls only browser lifecycle.
  for (const contribution of clientContributions) {
    if (!('client' in contribution)) continue
    rows.push(
      createPluginRow({
        id: clientModuleRowIdForContribution(
          pkg.id,
          contribution.id,
          clientContributions.length,
          contribution.client?.id ?? contribution.id,
        ),
        plugin:
          clientContributions.length === 1
            ? `${pkg.id}@${snapshotId}/client`
            : `${pkg.id}@${snapshotId}/client/${contribution.id}`,
        snapshotDigest: snapshotId,
        exportName: 'client',
        entryRevision: snapshotId,
        extrasRevision: 'none',
        mountRevision: WEB_MOUNT_REVISION,
        runtime: 'in-process',
        disabled,
      }),
    )
  }
  return Object.freeze(rows)
}

function encodeComplete(
  rows: readonly Readonly<PluginRow>[],
  resources: Readonly<{ mcp: unknown; skills: unknown }>,
  resourceRows: readonly Readonly<PluginRow>[] = [],
): RuntimeTargetArtifact {
  const draft = buildRuntimeTarget({
    rows: [...rows, ...resourceRows],
    resources,
    resourceRevision: '0'.repeat(64),
    compositeRevision: '0'.repeat(64),
  })
  const resourceRevision = digestHex(
    `${JSON.stringify(draft.resource.resources)}\n${JSON.stringify(draft.resource.rows)}`,
  )
  const compositeRevision = digestHex(`${draft.tree.hash}:${resourceRevision}`)
  return encodeRuntimeTargetArtifact(
    buildRuntimeTarget({
      rows: [...rows, ...resourceRows],
      resources,
      resourceRevision,
      compositeRevision,
    }),
  )
}

/**
 * Rebuild one complete desired artifact after PackageManager commits enable/disable/update/remove.
 * Builtin/seam/resource rows from the previous desired stay; only the named package's ordinary
 * plugin rows are added, enabled, disabled, or dropped.
 */
export function rebuildDesiredFromInventory(input: {
  previous: RuntimeTargetArtifact | undefined
  inventory: InstalledInventory
  packageId: string
  operation: CompositeDesiredOperation
}): RuntimeTargetArtifact | undefined {
  const previous = input.previous ? decodeRuntimeTargetArtifact(input.previous) : undefined
  const resources = previous?.resource.resources ?? { mcp: [], skills: {} }
  const resourceRows = Object.values(previous?.resource.rows ?? {}).filter(
    (row): row is Readonly<PluginRow> => row !== null,
  )
  const kept: Readonly<PluginRow>[] = []
  for (const row of previous?.tree.rows ?? []) {
    if (!ownsRow(row.plugin, input.packageId)) kept.push(row)
  }
  const pkg = input.inventory.packages.find((row) => row.id === input.packageId)
  if (input.operation === 'enable' || input.operation === 'update' || input.operation === 'rollback') {
    if (!pkg || !isRuntimePackageEligible(pkg)) return encodeComplete(kept, resources, resourceRows)
    kept.push(...rowsForPackage(pkg, false))
    return encodeComplete(kept, resources, resourceRows)
  }
  if (input.operation === 'disable') {
    // Trust revocation or a blocker removes the rows entirely, preventing stale recovery from
    // requalifying them without a fresh inventory decision.
    if (pkg && isRuntimePackageEligible({ ...pkg, enabled: true }))
      kept.push(
        ...[...(previous?.tree.rows ?? [])]
          .filter((row) => ownsRow(row.plugin, input.packageId))
          .map((row) => withDisabled(row, true)),
      )
    return encodeComplete(kept, resources, resourceRows)
  }
  if (input.operation === 'remove') return encodeComplete(kept, resources, resourceRows)
  return input.previous
}

/** Remove every row owned by a package from a persisted target. Used by trust revocation before
 * runtime reconciliation; unlike disable, this also sanitizes recovery targets. */
export function withoutPackageRows(
  artifact: RuntimeTargetArtifact,
  packageId: string,
): RuntimeTargetArtifact {
  const decoded = decodeRuntimeTargetArtifact(artifact)
  const rows = decoded.tree.rows.filter((row) => !ownsRow(row.plugin, packageId))
  const resourceRows = Object.values(decoded.resource.rows).filter(
    (row): row is Readonly<PluginRow> => row !== null && !ownsRow(row.plugin, packageId),
  )
  return encodeComplete(rows, decoded.resource.resources, resourceRows)
}

/** Repair only daemon-owned browser rows when an older desired artifact is opened at startup. */
export function reconcileDesiredWebRows(input: {
  desired: RuntimeTargetArtifact | undefined
  inventory: InstalledInventory
}): RuntimeTargetArtifact | undefined {
  if (!input.desired) return undefined
  const desired = decodeRuntimeTargetArtifact(input.desired)
  const eligible = new Map(
    input.inventory.packages
      .filter(
        (pkg) =>
          pkg.trusted &&
          pkg.blockers.length === 0 &&
          pkg.contributions.some(
            (item) =>
              (item.kind === 'client' && 'client' in item) ||
              (item.kind === 'extension' && item.client !== undefined),
          ),
      )
      .map((pkg) => [pkg.id, pkg]),
  )
  const rows = desired.tree.rows.filter((row) => {
    if (!row.id.startsWith('web:')) return true
    const packageId = packageOfRow(row.plugin)
    return (
      packageId !== undefined &&
      eligible.has(packageId) &&
      row.plugin.startsWith(`${packageId}@`) &&
      (row.plugin.endsWith('/client') || row.plugin.includes('/client/'))
    )
  })
  const present = new Set(rows.filter((row) => row.id.startsWith('web:')).map((row) => row.id))
  for (const pkg of [...eligible.values()].sort((left, right) => left.id.localeCompare(right.id))) {
    const missing = rowsForPackage(pkg, false).filter(
      (row) => row.id.startsWith('web:') && !present.has(row.id),
    )
    if (pkg.enabled) rows.push(...missing)
  }
  const resourceRows = Object.values(desired.resource.rows).filter(
    (row): row is Readonly<PluginRow> => row !== null,
  )
  const next = encodeComplete(rows, desired.resource.resources, resourceRows)
  return next.digest === input.desired.digest ? input.desired : next
}

/** `<package>@<snapshot>` to the snapshot id: what a freshly started worker can import right now. */
export type LoadableSnapshots = ReadonlyMap<string, string>

/** What a worker started now could import: the installed, trusted packages at their current snapshot. */
export function loadableSnapshotsFromInventory(inventory: InstalledInventory): LoadableSnapshots {
  const loadable = new Map<string, string>()
  for (const pkg of inventory.packages) {
    if (!pkg.trusted || !pkg.directory || !pkg.entry.treeIntegrity) continue
    const snapshotId = installedRuntimeSnapshotId(pkg)
    loadable.set(`${pkg.id}@${snapshotId}`, snapshotId)
  }
  return loadable
}

function loadableRow(row: Readonly<PluginRow>, loadable: LoadableSnapshots): boolean {
  if (row.plugin.startsWith('builtin:')) return true
  const slash = row.plugin.lastIndexOf('/')
  if (slash <= 0) return false
  const snapshotId = loadable.get(row.plugin.slice(0, slash))
  return snapshotId !== undefined && row.entryRevision === snapshotId
}

/**
 * The target to fall back to after `failed` did not work: what was desired before it, minus the
 * rows a restarted worker could no longer load (an updated or removed package's old snapshot).
 */
export function revertTarget(
  failed: RuntimeTargetArtifact,
  base: RuntimeTargetArtifact | undefined,
  loadable: LoadableSnapshots,
): RuntimeTargetArtifact {
  const source = decodeRuntimeTargetArtifact(base ?? failed)
  const rows = base ? source.tree.rows.filter((row) => loadableRow(row, loadable)) : []
  return encodeComplete(rows, source.resource.resources)
}

/** No rows at all. The Host merges its own builtin, seam and preset rows back in when it applies. */
export function emptyTarget(desired: RuntimeTargetArtifact): RuntimeTargetArtifact {
  return encodeComplete([], decodeRuntimeTargetArtifact(desired).resource.resources)
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * The packages whose rows differ between two targets. Rows are compared by their whole content, so a
 * package that was only switched on or off, or only reconfigured, still counts.
 */
export function differingPackages(
  left: RuntimeTargetArtifact,
  right: RuntimeTargetArtifact,
): Readonly<{ packages: readonly string[]; unattributed: number }> {
  const rowsOf = (artifact: RuntimeTargetArtifact) =>
    new Map(decodeRuntimeTargetArtifact(artifact).tree.rows.map((row) => [canonicalJson(row), row]))
  const a = rowsOf(left)
  const b = rowsOf(right)
  const packages = new Set<string>()
  let unattributed = 0
  for (const [key, row] of [...a, ...b]) {
    if (a.has(key) && b.has(key)) continue
    const owner = packageOfRow(row.plugin)
    if (owner === undefined) unattributed += 1
    else packages.add(owner)
  }
  return Object.freeze({ packages: Object.freeze([...packages].sort()), unattributed })
}

/** Whether two targets would mount the same thing, whatever digests they were encoded with. */
export function sameTargetContent(left: RuntimeTargetArtifact, right: RuntimeTargetArtifact): boolean {
  const view = (artifact: RuntimeTargetArtifact) => {
    const decoded = decodeRuntimeTargetArtifact(artifact)
    return canonicalJson({
      rows: decoded.tree.rows,
      resources: decoded.resource.resources,
      resourceRows: decoded.resource.rows,
    })
  }
  return view(left) === view(right)
}
