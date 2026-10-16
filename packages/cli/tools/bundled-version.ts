import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseSemver } from '@agnes/extension-api'
import { PUBLIC_PACKAGE_VERSION } from './release-version.mjs'

/** Private workspace builds share the declared public candidate; releases use their exact version. */
export function bundledReleaseVersion(version: string): string {
  const release = version === '0.0.0' ? PUBLIC_PACKAGE_VERSION : version
  if (!parseSemver(release) || release === '0.0.0')
    throw new Error('Bundled plugins require a release version')
  return release
}

/** Stamp only the copied release payload, before its integrity is inspected or advertised. */
export async function stampBundledPackageVersion(directory: string, version: string): Promise<void> {
  const file = join(directory, 'package.json')
  const manifest = JSON.parse(await readFile(file, 'utf8'))
  manifest.version = bundledReleaseVersion(version)
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`)
}
