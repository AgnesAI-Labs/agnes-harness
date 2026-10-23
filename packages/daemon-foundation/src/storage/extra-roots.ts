import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { rpcError } from '@agnes/protocol'

/** Most extra directories one session may carry. */
export const MAX_EXTRA_DIRECTORIES = 8

const refused = (reason: string): never => {
  throw rpcError('SEMANTIC_REJECTED', { code: 'EXTRA_DIRECTORY_REFUSED', reason })
}

/** `outer` itself or anything below it. Case is folded off Linux, so a refusal is never missed. */
export function containsPath(outer: string, inner: string): boolean {
  const fold = (path: string): string => (process.platform === 'linux' ? path : path.toLowerCase()) // guards-allow-platform: the daemon's own file system decides whether paths compare case-sensitively.
  const rel = relative(fold(outer), fold(inner))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Real path of the nearest existing ancestor plus the missing tail, for a protected path that may not exist yet. */
async function realLoose(path: string): Promise<string> {
  const tail: string[] = []
  let current = path
  for (;;) {
    try {
      return join(await realpath(current), ...tail)
    } catch {
      const parent = dirname(current)
      if (parent === current) return path
      tail.unshift(basename(current))
      current = parent
    }
  }
}

/**
 * Canonical extra directories for a session rooted at `workspaceRoot`: absolute, resolved by
 * `resolve`, deduplicated, sorted, and without any directory the workspace root already covers.
 * Throws a refusal for the first path that is not absolute or cannot be resolved.
 */
export async function canonicalExtraRoots(
  workspaceRoot: string,
  paths: readonly string[],
  resolve: (path: string) => Promise<{ path: string }>,
): Promise<string[]> {
  if (!Array.isArray(paths) || paths.length > MAX_EXTRA_DIRECTORIES)
    refused(`at most ${MAX_EXTRA_DIRECTORIES} extra directories are allowed`)
  const roots = new Set<string>()
  for (const path of paths) {
    if (typeof path !== 'string' || !isAbsolute(path)) refused('extra directory must be an absolute path')
    const directory = await resolve(path).catch(() =>
      refused('extra directory does not exist or is not a readable directory'),
    )
    if (!containsPath(workspaceRoot, directory.path)) roots.add(directory.path)
  }
  return [...roots].sort()
}

/** Refuses a root that is, contains, or lies inside a path no session may reach. */
export async function assertNotProtected(
  roots: readonly string[],
  protectedRoots: readonly string[],
): Promise<void> {
  // Both spellings: the one configured and the one the file system resolves it to.
  const guarded = [...protectedRoots, ...(await Promise.all(protectedRoots.map(realLoose)))]
  for (const root of roots)
    for (const path of guarded)
      if (containsPath(root, path) || containsPath(path, root))
        refused('extra directory overlaps the data directory or credentials')
}
