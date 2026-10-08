import { readdirSync, realpathSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const contains = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..')
}

/** Partition the read-only view around private trees, including trees not created yet.
 * Recomputed for each invocation: no cached existence check can expose a later private file.
 * Only namespace mount points are created; the host's missing directories stay missing.
 */
export function sandboxReadPaths(denyPaths: readonly string[], root = '/'): string[] {
  const paths: string[] = []
  let visited = 0
  const walk = (path: string) => {
    if (++visited > 4096)
      throw Object.assign(new Error('sandbox read view is too large'), { code: 'E_SANDBOX_WORKSPACE' })
    let real: string
    try {
      real = realpathSync(path)
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ENOENT') return
      throw error
    }
    if (denyPaths.some((deny) => contains(deny, real))) return
    if (denyPaths.some((deny) => contains(real, deny))) {
      for (const child of readdirSync(path).sort()) walk(join(path, child))
    } else paths.push(path)
  }
  walk(root)
  return paths
}
