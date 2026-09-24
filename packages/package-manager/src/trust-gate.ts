import { API_VERSION, checkApiRange, type ExtensionManifest } from '@agnes/extension-api'
import { manifestCapabilities } from './capabilities.js'
import { PackageError } from './errors.js'
import type { LockEntry } from './lockfile.js'
import { hashDirectory } from './sources.js'

export { manifestCapabilities } from './capabilities.js'

export const LICENSE_ALLOWLIST = [
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '0BSD',
  'MPL-2.0',
  'Unlicense',
] as const

/** Capabilities that may not be admitted by a force/skip path. */
export function isDangerous(manifest: ExtensionManifest): boolean {
  const network = manifest.capabilities.network
  return (
    Boolean(!Array.isArray(network) && network?.hosts.includes('*')) ||
    Boolean(manifest.capabilities['tools.invoke'] && manifest.capabilities.subagent)
  )
}

/**
 * Verify the installed tree before any softer trust decision. npm's lock integrity attests the
 * tarball, so its caller supplies a freshly fetched reference tree; directory sources are pinned
 * directly by their tree digest.
 */
export function verifyInstalledIntegrity(
  id: string,
  entry: LockEntry,
  dir: string,
  referenceDir?: string,
): void {
  const actual = hashDirectory(dir)
  const expected = referenceDir === undefined ? entry.integrity : hashDirectory(referenceDir)
  if (actual !== expected)
    throw new PackageError('E_LOCK_MISMATCH', `${id} installed package differs from its trusted source`, {
      detail: { id, reason: 'integrity', expected, actual },
    })
}

/** The four non-integrity trust gates, kept in the specified order. */
export function runTrustGate(input: {
  id: string
  entry: LockEntry
  manifest?: ExtensionManifest
  ceiling: readonly string[]
  now: string
  minimumReleaseAgeMin: number
}): void {
  const { id, entry, manifest } = input
  if (!(LICENSE_ALLOWLIST as readonly string[]).includes(entry.license))
    throw new PackageError('E_PACKAGE_QUARANTINED', `${id} has a license outside the allowlist`, {
      detail: { id, reason: 'license', license: entry.license },
    })
  if (entry.source.type === 'npm' || entry.source.type === 'market') {
    const releasedAt = 'releasedAt' in entry ? entry.releasedAt : undefined
    const ageMin =
      typeof releasedAt === 'string' ? (Date.parse(input.now) - Date.parse(releasedAt)) / 60_000 : Number.NaN
    if (!Number.isFinite(ageMin) || ageMin < input.minimumReleaseAgeMin)
      throw new PackageError('E_PACKAGE_QUARANTINED', `${id} has not completed the release quarantine`, {
        detail: {
          id,
          reason: 'release-age',
          minutesLeft: Number.isFinite(ageMin)
            ? Math.ceil(input.minimumReleaseAgeMin - ageMin)
            : input.minimumReleaseAgeMin,
        },
      })
  }
  if (manifest) {
    try {
      checkApiRange(manifest, API_VERSION)
    } catch (error) {
      throw new PackageError('E_API_RANGE', `${id} is incompatible with this extension API`, {
        detail: { id, apiRange: manifest.apiRange, apiVersion: API_VERSION, cause: String(error) },
      })
    }
    const allowed = new Set(input.ceiling)
    const extra = manifestCapabilities(manifest).filter((capability) => !allowed.has(capability))
    if (extra.length)
      throw new PackageError('E_CEILING_EXCEEDED', `${id} exceeds the profile capability ceiling`, {
        detail: { id, extra },
      })
  }
}
