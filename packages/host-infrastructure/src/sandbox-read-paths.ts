import { readdirSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { nativeRealpathSync } from '@agnes/system-node/realpath'

const contains = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function canonicalDeny(path: string): string {
  let parent = resolve(path)
  const missing: string[] = []
  for (;;) {
    try {
      return join(nativeRealpathSync(parent), ...missing)
    } catch (error) {
      // Private trees need protection before creation, too. Resolve their existing ancestor with
      // the same resolver as walk(), rather than comparing a JS/lexical alias to a native path.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(parent) === parent) throw error
      missing.unshift(basename(parent))
      parent = dirname(parent)
    }
  }
}

/** Partition the read-only view around private trees, including trees not created yet.
 * Recomputed for each invocation: no cached existence check can expose a later private file.
 * Only namespace mount points are created; the host's missing directories stay missing.
 */
export function sandboxReadPaths(denyPaths: readonly string[], root = '/'): string[] {
  const denied = denyPaths.map(canonicalDeny)
  const paths: string[] = []
  let visited = 0
  const walk = (path: string) => {
    if (++visited > 4096)
      throw Object.assign(new Error('sandbox read view is too large'), { code: 'E_SANDBOX_WORKSPACE' })
    let real: string
    try {
      real = nativeRealpathSync(path)
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ENOENT') return
      throw error
    }
    if (denied.some((deny) => contains(deny, real))) return
    if (denied.some((deny) => contains(real, deny))) {
      for (const child of readdirSync(path).sort()) walk(join(path, child))
    } else paths.push(path)
  }
  walk(root)
  return paths
}
