import { lstatSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fault, hash } from './content.js'

const fold = (path: string): string => path.toLowerCase()
export function inside(root: string, path: string): boolean {
  const rel = relative(fold(root), fold(path))
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep))
}
export function missing(error: unknown): boolean {
  return (error as { code?: string }).code === 'ENOENT'
}
export function canonical(path: string): string {
  const absolute = resolve(path)
  try {
    return realpathSync(absolute)
  } catch (error) {
    if (!missing(error)) throw error
    const parent = dirname(absolute)
    if (parent === absolute) throw error
    return join(canonical(parent), relative(parent, absolute))
  }
}
export function roots(
  home: string,
  workspace: string,
): { protectedRoot: string; root: string; userRoot: string } {
  const protectedRoot = join(canonical(home), 'memory')
  const root = join(protectedRoot, 'workspaces', hash(canonical(workspace)))
  return { protectedRoot, root, userRoot: join(protectedRoot, 'user') }
}

/** Refuse links in the provider-owned chain, including multiply linked regular files. */
export function safe(root: string, path: string): void {
  if (!inside(root, path)) throw fault('MEMORY_SCOPE_DENIED')
  let cursor = root
  const parts = relative(root, path).split(sep).filter(Boolean)
  for (const part of ['', ...parts]) {
    cursor = part ? join(cursor, part) : cursor
    try {
      const stat = lstatSync(cursor)
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)) throw fault('MEMORY_SCOPE_DENIED')
    } catch (error) {
      if (!missing(error)) throw error
    }
  }
}
export function name(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.md$/.test(value)) throw fault('MEMORY_SCOPE_DENIED')
  return value
}
