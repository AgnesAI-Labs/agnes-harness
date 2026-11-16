import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { jcs, type PackageBundledOrigin, validatePackageAdminData } from '@agnes/protocol'
import {
  BUNDLED_PLUGIN_DIGESTS,
  bundledPluginDigest,
  bundledPluginSource,
  OPTIONAL_BUNDLED_PACKAGES,
} from './bundled-plugin-source.js'
import { hashDirectory } from './directory-digest.js'
import { HOST_CAPABILITY_GRANTS, type HostGrantDeclaration, optionalRowGrant } from './host-grants.js'
import { parseSource } from './sources.js'

/** The release-table identity of one optional shipped plugin. */
export type BundledReleaseEntry = Readonly<{ id: string; ref: string }>
/** What this AGH ships under a reserved reference: the payload's own name and version and its digest. */
export type ShippedBundledRelease = Readonly<{ id: string; version: string; digest: string }>

/** The release-table entry a package names, only when `source` is exactly the canonical reserved
 * source object for it. Reads no files, so callers check it before any hashing. */
export function bundledReleaseEntry(
  id: string,
  source: unknown,
  table: readonly BundledReleaseEntry[] = OPTIONAL_BUNDLED_PACKAGES,
): BundledReleaseEntry | undefined {
  const ref = source && typeof source === 'object' ? (source as { ref?: unknown }).ref : undefined
  const entry = table.find((item) => item.id === id && item.ref === ref)
  if (!entry) return undefined
  try {
    if (!validatePackageAdminData('PackageSource', source).ok || jcs(parseSource(entry.ref)) !== jcs(source))
      return undefined
  } catch {
    return undefined
  }
  return entry
}

/** The shipped payload behind `ref`. A present digest manifest is authoritative (a corrupt or partial
 * one is never re-derived); only its absence, a development checkout, hashes the payload itself.
 * Missing or unreadable release evidence is undefined and never proves anything. */
export function shippedBundledRelease(
  ref: string,
  releaseSourceFor: (ref: string) => { root: string; path: string } | undefined = bundledPluginSource,
): ShippedBundledRelease | undefined {
  try {
    const source = releaseSourceFor(ref)
    if (!source) return undefined
    let absent = false
    try {
      lstatSync(join(source.root, BUNDLED_PLUGIN_DIGESTS))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      absent = true
    }
    const digest = absent ? hashDirectory(join(source.root, source.path)) : bundledPluginDigest(source)
    const manifest: unknown = JSON.parse(readFileSync(join(source.root, source.path, 'package.json'), 'utf8'))
    const { name, version } = (manifest && typeof manifest === 'object' ? manifest : {}) as Record<
      string,
      unknown
    >
    return digest && typeof name === 'string' && typeof version === 'string'
      ? { id: name, version, digest }
      : undefined
  } catch {
    return undefined
  }
}

/** Exact: the shipped payload is this release-table entry, at this version, with this tree digest. */
export function matchesShippedRelease(
  entry: BundledReleaseEntry,
  candidate: Readonly<{ version: string; digest: string }>,
  shipped: ShippedBundledRelease | undefined,
): boolean {
  return (
    shipped !== undefined &&
    shipped.id === entry.id &&
    shipped.version === candidate.version &&
    shipped.digest === candidate.digest
  )
}

/** Whether the release grants a row of this package the bundled-application runtime, composed by
 * the same rule the Host grant pin applies. */
function grantsOwnerApplication(
  id: string,
  rows: readonly Readonly<{ id: string; runtime: string }>[],
  declarations: readonly HostGrantDeclaration[],
): boolean {
  const declaration = declarations.find((item) => item.packageId === id)
  return (
    declaration !== undefined && rows.some((row) => optionalRowGrant(declaration, row)?.bundledApp === true)
  )
}

/** The read-only fact that a reviewed tree is the optional plugin this AGH ships, or undefined. The
 * name, a catalogue label or a local path proves nothing; the same bytes from another source are an
 * ordinary package. It is never publisher evidence and grants nothing by itself. */
export function provenBundledOrigin(
  candidate: Readonly<{
    id: string
    version: string
    source: unknown
    treeIntegrity: string
    rows: readonly Readonly<{ id: string; runtime: string }>[]
  }>,
  shipped: (ref: string) => ShippedBundledRelease | undefined = shippedBundledRelease,
  declarations: readonly HostGrantDeclaration[] = HOST_CAPABILITY_GRANTS,
): PackageBundledOrigin | undefined {
  const entry = bundledReleaseEntry(candidate.id, candidate.source)
  if (
    !entry ||
    !matchesShippedRelease(
      entry,
      { version: candidate.version, digest: candidate.treeIntegrity },
      shipped(entry.ref),
    )
  )
    return undefined
  return grantsOwnerApplication(candidate.id, candidate.rows, declarations) ? { ownerApplication: true } : {}
}
