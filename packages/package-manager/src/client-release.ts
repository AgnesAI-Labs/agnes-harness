import { join } from 'node:path'
import type { PackageContributionSummary } from '@agnes/protocol'
import { bundledReleaseEntry, matchesShippedRelease, shippedBundledRelease } from './bundled-origin.js'
import { DEFAULT_ENABLED_BUNDLED_PACKAGES, OPTIONAL_BUNDLED_PACKAGES } from './bundled-plugin-source.js'
import { inspectVerifiedTree } from './inspect.js'
import { canonical, readStaticJson } from './integrity.js'
import { reviewedContributionsMatch } from './inventory-client-compatibility.js'
import { type PackageSource, parseSource } from './sources.js'

/** Input from the verified installed/rollback inventory or a verified generation tree. */
export type VerifiedClientTree = Readonly<{
  packageId: string
  directory: string
  source?: PackageSource
  version: string
  integrity: string
  treeIntegrity: string
  capabilityHash: string
  contributions: readonly PackageContributionSummary[]
}>

/** Historical metadata is not an authority. Derive client declarations and capabilities from the
 * exact archived tree, and compare them to the generation record before projecting any client. */
export function checkedArchiveClientTree(candidate: VerifiedClientTree) {
  try {
    const manifest = readStaticJson(join(candidate.directory, 'package.json'))
    if (manifest.name !== candidate.packageId || manifest.version !== candidate.version) return undefined
    const dependencies: Record<string, string> = {}
    if (manifest.dependencies !== undefined) {
      if (
        !manifest.dependencies ||
        typeof manifest.dependencies !== 'object' ||
        Array.isArray(manifest.dependencies)
      )
        return undefined
      for (const [id, spec] of Object.entries(manifest.dependencies)) {
        if (typeof spec !== 'string') return undefined
        Object.defineProperty(dependencies, id, { value: spec, enumerable: true })
      }
    }
    const source = candidate.source ?? parseSource('file:./archive')
    const { preview } = inspectVerifiedTree(
      {
        dir: candidate.directory,
        source,
        fetched: {
          dir: candidate.directory,
          version: candidate.version,
          integrity: candidate.source ? candidate.integrity : candidate.treeIntegrity,
          ...(typeof manifest.license === 'string' ? { license: manifest.license } : {}),
          dependencies,
        },
      },
      candidate.treeIntegrity,
    )
    if (
      preview.capabilityHash !== candidate.capabilityHash ||
      !reviewedContributionsMatch(preview.contributions, [...candidate.contributions])
    )
      return undefined
    return preview
  } catch {
    return undefined
  }
}

/** Exact release-owned bytes. Only independently verified legacy archives may omit source. */
export function clientReleaseEvidence(
  candidate: VerifiedClientTree,
  legacyArchive: boolean,
): string | undefined {
  const entry =
    candidate.source !== undefined
      ? bundledReleaseEntry(candidate.packageId, candidate.source)
      : legacyArchive
        ? [...DEFAULT_ENABLED_BUNDLED_PACKAGES, ...OPTIONAL_BUNDLED_PACKAGES].find(
            (p) => p.id === candidate.packageId,
          )
        : undefined
  if (
    !entry ||
    candidate.integrity !== candidate.treeIntegrity ||
    !/^[a-f0-9]{64}$/.test(candidate.capabilityHash)
  )
    return undefined
  const shipped = shippedBundledRelease(entry.ref)
  if (!matchesShippedRelease(entry, { version: candidate.version, digest: candidate.treeIntegrity }, shipped))
    return undefined
  if (!checkedArchiveClientTree(candidate)) return undefined
  return canonical([entry.ref, candidate.version, candidate.treeIntegrity, candidate.capabilityHash])
}
