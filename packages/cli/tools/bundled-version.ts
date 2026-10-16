import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseSemver, type Semver } from '@agnes/extension-api'
import { PUBLIC_PACKAGE_VERSION } from './release-version.mjs'

/** Distribution version used for unpublished placeholders. */
export function bundledReleaseVersion(version: string): string {
  const release = version === '0.0.0' ? PUBLIC_PACKAGE_VERSION : version
  if (!parseSemver(release) || release === '0.0.0')
    throw new Error('Bundled plugins require a release version')
  return release
}

function compareVersions(a: Semver, b: Semver): number {
  const core = a.major - b.major || a.minor - b.minor || a.patch - b.patch
  if (core || a.pre === b.pre) return core
  if (a.pre === undefined) return 1
  if (b.pre === undefined) return -1
  const left = a.pre.split('.')
  const right = b.pre.split('.')
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i]
    const y = right[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) return BigInt(x) < BigInt(y) ? -1 : 1
    if (xn !== yn) return xn ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

/** Workspace builds preserve real versions; explicit releases may raise them, never lower them. */
export function bundledPackageVersion(declaredVersion: string, buildVersion = '0.0.0'): string {
  const declared = parseSemver(declaredVersion)
  if (!declared) throw new Error('Bundled plugins require a declared SemVer version')
  const release = bundledReleaseVersion(buildVersion)
  const candidate = parseSemver(release)
  if (!candidate) throw new Error('Bundled plugins require a release version')
  const comparison = compareVersions(candidate, declared)
  if (declaredVersion === '0.0.0') {
    if (comparison < 0) throw new Error('Bundled release version is lower than the placeholder')
    return release
  }
  if (buildVersion === '0.0.0' || comparison <= 0) return declaredVersion
  return release
}

/** Stamp only the copied release payload, before its integrity is inspected or advertised. */
export async function stampBundledPackageVersion(directory: string, version: string): Promise<void> {
  const file = join(directory, 'package.json')
  const manifest = JSON.parse(await readFile(file, 'utf8'))
  manifest.version = bundledPackageVersion(manifest.version, version)
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`)
}
