import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ResolvedPackage } from '@agnes/host-common/profile/types'
import {
  BUNDLED_PLUGIN_DIGESTS,
  bundledPluginDigest,
  bundledPluginSource,
  HOST_CAPABILITY_GRANTS,
  type HostCapabilityGrant,
  type HostGrantDeclaration,
  hashDirectory,
  OPTIONAL_BUNDLED_PACKAGES,
  parseAgnesPluginEntries,
  type RuntimePluginSnapshot,
  verifiedDirectoryDigest,
} from '@agnes/package-manager'
import type { RowOrigin } from '@agnes/plugin-runtime/host'

const empty: HostCapabilityGrant = Object.freeze({})

/** Assembly-scoped authority for verified installed rows, separate from builtin factory pins.
 * The caller supplies origins only from its live RowOriginLookup, never from plugin input. */
export function pinOptionalBundledRowGrants(
  packages: readonly ResolvedPackage[],
  sourceFor: (packageId: string, snapshotId: string) => Readonly<RuntimePluginSnapshot> | undefined,
  declarations: readonly HostGrantDeclaration[] = HOST_CAPABILITY_GRANTS,
  releaseSourceFor = bundledPluginSource,
) {
  const expected = new Map<string, string | undefined>()
  const observed = new WeakMap<
    object,
    { digest: string; rows: ReturnType<typeof parseAgnesPluginEntries> } | undefined
  >()
  const bindings = new Map<string, Readonly<RuntimePluginSnapshot>>()
  const releaseDigest = (ref: string): string | undefined => {
    if (expected.has(ref)) return expected.get(ref)
    let digest: string | undefined
    try {
      const source = releaseSourceFor(ref)
      if (source) {
        let absent = false
        try {
          lstatSync(join(source.root, BUNDLED_PLUGIN_DIGESTS))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          absent = true
        }
        digest = absent ? hashDirectory(join(source.root, source.path)) : bundledPluginDigest(source)
      }
    } catch {
      /* Missing or unreadable release evidence never grants a capability. */
    }
    expected.set(ref, digest)
    return digest
  }
  return (origin: Readonly<RowOrigin>): HostCapabilityGrant => {
    const pkg = packages.find((p) => p.id === origin.packageId)
    const source = sourceFor(origin.packageId, origin.snapshotId)
    const declaration = declarations.find((d) => d.packageId === origin.packageId)
    if (
      !pkg?.enabled ||
      !source?.trusted ||
      source.enabled === false ||
      !declaration ||
      origin.trustTier !== 'third-party'
    )
      return empty
    const optional = OPTIONAL_BUNDLED_PACKAGES.find((p) => p.id === pkg.id && p.ref === pkg.source)
    const snapshot = source.snapshot
    if (
      !optional ||
      snapshot.packageId !== pkg.id ||
      snapshot.snapshotId !== origin.snapshotId ||
      snapshot.version !== pkg.version ||
      snapshot.integrity !== pkg.integrity
    )
      return empty
    const key = `${pkg.id}\0${origin.snapshotId}`
    if (bindings.has(key) && bindings.get(key) !== source) return empty
    if (!observed.has(source)) {
      try {
        observed.set(source, {
          digest: verifiedDirectoryDigest(snapshot.directory, snapshot),
          rows: parseAgnesPluginEntries(
            pkg.id,
            JSON.parse(readFileSync(join(snapshot.directory, 'package.json'), 'utf8')).agnes?.plugins,
          ),
        })
      } catch {
        observed.set(source, undefined)
      }
    }
    const proof = observed.get(source)
    const expectedDigest = releaseDigest(optional.ref)
    if (
      !proof ||
      !expectedDigest ||
      proof.digest !== snapshot.treeIntegrity ||
      proof.digest !== expectedDigest
    )
      return empty
    const row = proof.rows.find((r) => r.id === origin.rowId && r.export === origin.exportName)
    if (!row || row.runtime !== 'in-process' || !declaration.extensions[row.id]) return empty
    bindings.set(key, source)
    return Object.freeze({ ...declaration.package, ...declaration.extensions[row.id] })
  }
}
