import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { validateSurfaceInstance } from '@agnes/protocol'
import { PackageError } from './errors.js'
import { freezeData } from './integrity.js'
import type { PackageReferences } from './lifecycle.js'
import { readDeployManifest } from './workspace.js'

/** Static files only. No discovery, secret resolution or runtime authority. */
export function readSurfaceInstances(directory: string) {
  const root = realpathSync(directory)
  const safe = (path: string) => {
    const file = resolve(root, path),
      rel = relative(root, realpathSync(file)),
      stat = lstatSync(file)
    if (
      isAbsolute(rel) ||
      rel === '..' ||
      rel.startsWith(`..${sep}`) ||
      !stat.isFile() ||
      stat.size > 1048576
    )
      throw new PackageError('E_EXT_LOAD', 'deployment file is unsafe or too large')
    return file
  }
  safe('manifest.json')
  const manifest = readDeployManifest(root)
  const instances = (manifest.surfaces ?? []).map((path) => {
    const text = readFileSync(safe(path), 'utf8')
    if (Buffer.byteLength(text) > 1048576)
      throw new PackageError('E_EXT_LOAD', 'deployment file is too large')
    const checked = validateSurfaceInstance(JSON.parse(text))
    if (!checked.ok) throw new PackageError('E_EXT_LOAD', 'deployment instance is invalid')
    return { path, instance: checked.value }
  })
  return freezeData({ manifest, instances })
}
export function surfaceReferences(
  directory: string,
  id: string,
  extensions: readonly string[] = [],
): string[] {
  const { manifest, instances } = readSurfaceInstances(directory)
  return instances
    .filter(
      ({ instance }) =>
        instance.package === id || instance.grants.some((grant) => extensions.includes(grant.extension)),
    )
    .map(({ path }) => `${manifest.id}:${path}`)
    .sort()
}
/** Caller holds deployment and generation admission until the enclosing mutation returns. */
export function createDeploymentReferences(options: {
  directories: (profile: string) => Promise<readonly string[]>
  runtime: PackageReferences
}): PackageReferences {
  return async (profile, id, operation, extensions = []) => {
    const directories = await options.directories(profile)
    if (directories.length > 256 || new Set(directories).size !== directories.length)
      throw new PackageError('E_EXT_LOAD', 'deployment index is invalid or too large')
    const references = [
      ...new Set(directories.flatMap((directory) => surfaceReferences(directory, id, extensions))),
    ].sort()
    return [
      ...(await options.runtime(profile, id, operation, extensions)),
      ...(references.length ? [{ code: 'deployment' as const, references }] : []),
    ]
  }
}
