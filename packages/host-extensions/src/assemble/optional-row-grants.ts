import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ResolvedPackage } from '@agnes/host-common/profile/types'
import {
  bundledPluginSource,
  bundledReleaseEntry,
  DEFAULT_ENABLED_BUNDLED_PACKAGES,
  HOST_CAPABILITY_GRANTS,
  type HostCapabilityGrant,
  type HostGrantDeclaration,
  matchesShippedRelease,
  OPTIONAL_BUNDLED_PACKAGES,
  optionalRowGrant,
  parseAgnesPluginEntries,
  type RuntimePluginSnapshot,
  type ShippedBundledRelease,
  shippedBundledRelease,
  verifiedDirectoryDigest,
} from '@agnes/package-manager'
import type { RowOrigin } from '@agnes/plugin-runtime/host'
import { jcs } from '@agnes/protocol'

const empty: HostCapabilityGrant = Object.freeze({})

/** Assembly-scoped authority for verified installed rows, separate from builtin factory pins.
 * The caller supplies origins only from its live RowOriginLookup, never from plugin input.
 * `packages` is the assembly's package list, or a lookup of the verified package entry that the
 * generation selecting the origin's snapshot owns (it follows in-place publications). */
export function pinOptionalBundledRowGrants(
  packages: readonly ResolvedPackage[] | ((origin: Readonly<RowOrigin>) => ResolvedPackage | undefined),
  sourceFor: (packageId: string, snapshotId: string) => Readonly<RuntimePluginSnapshot> | undefined,
  declarations: readonly HostGrantDeclaration[] = HOST_CAPABILITY_GRANTS,
  releaseSourceFor = bundledPluginSource,
  optionalPackages: readonly Readonly<{ id: string; ref: string }>[] = [
    ...DEFAULT_ENABLED_BUNDLED_PACKAGES,
    ...OPTIONAL_BUNDLED_PACKAGES,
  ],
) {
  const expected = new Map<string, ShippedBundledRelease | undefined>()
  // One proven identity per package entry: an entry never changes the code it grants. A newly
  // published generation's entry (an in-place update) is proven afresh, as in a fresh container.
  const bindings = new WeakMap<ResolvedPackage, string>()
  const packageFor = (origin: Readonly<RowOrigin>) =>
    typeof packages === 'function'
      ? packages(origin)
      : packages.find((candidate) => candidate.id === origin.packageId)
  // Missing or unreadable release evidence is undefined and never grants a capability.
  const shipped = (ref: string): ShippedBundledRelease | undefined => {
    if (!expected.has(ref)) expected.set(ref, shippedBundledRelease(ref, releaseSourceFor))
    return expected.get(ref)
  }
  return (origin: Readonly<RowOrigin>): HostCapabilityGrant => {
    const pkg = packageFor(origin)
    const source = sourceFor(origin.packageId, origin.snapshotId)
    const declaration = declarations.find((d) => d.packageId === origin.packageId)
    if (
      !pkg?.enabled ||
      pkg.id !== origin.packageId ||
      pkg.trust !== 'trusted' ||
      !source?.trusted ||
      source.enabled === false ||
      !declaration ||
      origin.trustTier !== 'third-party'
    )
      return empty
    const snapshot = source.snapshot
    // The same canonical-source and release-table proof the install review's bundled origin uses.
    const provenance = snapshot.source
    const optional = bundledReleaseEntry(pkg.id, provenance, optionalPackages)
    if (
      !optional ||
      !provenance ||
      optional.ref !== pkg.source ||
      snapshot.packageId !== pkg.id ||
      snapshot.snapshotId !== origin.snapshotId ||
      snapshot.version !== pkg.version ||
      snapshot.integrity !== pkg.integrity
    )
      return empty
    let identity: string
    let proof: { digest: string; rows: ReturnType<typeof parseAgnesPluginEntries> }
    try {
      identity = jcs({
        packageId: snapshot.packageId,
        profile: snapshot.profile,
        snapshotId: snapshot.snapshotId,
        version: snapshot.version,
        integrity: snapshot.integrity,
        treeIntegrity: snapshot.treeIntegrity,
        capabilityHash: snapshot.capabilityHash,
        source: provenance,
      })
      if (bindings.has(pkg) && bindings.get(pkg) !== identity) return empty
      // Fresh catalogue wrappers are normal. Authority is content-bound; verify this directory and row.
      proof = {
        digest: verifiedDirectoryDigest(snapshot.directory, snapshot),
        rows: parseAgnesPluginEntries(
          pkg.id,
          JSON.parse(readFileSync(join(snapshot.directory, 'package.json'), 'utf8')).agnes?.plugins,
        ),
      }
    } catch {
      return empty
    }
    if (
      !proof ||
      proof.digest !== snapshot.treeIntegrity ||
      !matchesShippedRelease(optional, { version: pkg.version, digest: proof.digest }, shipped(optional.ref))
    )
      return empty
    const row = proof.rows.find((r) => r.id === origin.rowId && r.export === origin.exportName)
    const grant = row && optionalRowGrant(declaration, row)
    if (!grant) return empty
    bindings.set(pkg, identity)
    return Object.freeze(grant)
  }
}
