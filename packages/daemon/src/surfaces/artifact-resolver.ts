import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { ResolvedDeployment } from '@agnes/host'
import type { InstalledInventory } from '@agnes/package-manager'
import type { ResolvedSurface, SurfaceArtifactResolver } from './types.js'

/** Maps (deployment, surface) to a trusted absolute entry/cwd. Containment is checked here so a
 * descriptor cannot point outside its own installed package; realpath, symlink and
 * descriptor-entry consistency are already enforced by the runtime before spawn, so they are not
 * repeated. */
export function createSurfaceArtifactResolver(inventory: InstalledInventory): SurfaceArtifactResolver {
  return Object.freeze({
    async resolveNodeArtifact(
      _deployment: ResolvedDeployment,
      surface: ResolvedSurface,
      signal: AbortSignal,
    ) {
      signal.throwIfAborted()
      const row = inventory.packages.find((entry) => entry.id === surface.package)
      if (!row || row.directory === null) throw new Error('surface package is not installed')
      const cwd = resolve(row.directory)
      // SurfaceArtifact is a discriminated union (node | oci); only the node variant carries `entry`.
      const artifact = surface.descriptor.artifact
      if (artifact.kind !== 'node') throw new Error('surface descriptor is not a node artifact')
      const raw = artifact.entry
      if (isAbsolute(raw)) throw new Error('surface artifact entry escapes the package directory')
      const entry = resolve(cwd, raw)
      // I5 (final review, Important): `resolve()` produces `\`-separated paths on Windows, so a
      // manual `entry.startsWith(`${cwd}/`)` prefix check is wrong for every legitimate entry there.
      // Use the same `relative()` + leading-`..`/absolute-result containment idiom already used right
      // next to this file (`local-runtime.ts`'s post-resolve check, `package-manager/src/workspace.ts`'s
      // `isContained`) instead of re-deriving a string-prefix check.
      const rel = relative(cwd, entry)
      const contained = rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
      if (!contained) throw new Error('surface artifact entry escapes the package directory')
      return { entry, cwd }
    },
  })
}
