import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { InstalledPackage } from '@agnes/package-manager'

/** Host ABI imports are validated by code admission, not installed as managed plugins. */
export async function applicationDependencies(
  owner: InstalledPackage,
  inventory: readonly InstalledPackage[],
): Promise<string[]> {
  let manifest: { agnes?: { hostProvidedExternals?: Record<string, unknown> } } = {}
  if (owner.directory) {
    try {
      manifest = JSON.parse(await readFile(join(owner.directory, 'package.json'), 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const externals = manifest.agnes?.hostProvidedExternals
  return Object.keys(owner.entry.dependencies ?? {}).filter(
    (id) =>
      // A managed dependency always remains in the reviewed closure, even if also called external.
      inventory.some((entry) => entry.id === id) ||
      !externals ||
      !Object.hasOwn(externals, id) ||
      typeof externals[id] !== 'string',
  )
}
