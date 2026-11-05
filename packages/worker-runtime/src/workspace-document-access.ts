import { lstat, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { AGH_DIR, rpcError } from '@agnes/protocol'

export type DocumentReadScope = Readonly<{
  root: string
  legacyManagedRoot?: string
  legacyDirectoryIdentity?: string
}>
const inside = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
const denied = () =>
  rpcError('SEMANTIC_REJECTED', { code: 'WORKSPACE_PATH_DENIED', reason: 'WORKSPACE_PATH_DENIED' })

/** A document-only exception; filesystem and sandbox capabilities are never widened. */
export async function assertDocumentPath(scope: DocumentReadScope | undefined, abs: string): Promise<void> {
  if (abs.split(sep).includes('.agh-managed-root.json')) throw denied()
  if (process.env.AGNES_HOME?.trim())
    throw new Error(
      'AGNES_HOME is no longer supported; unset it and select a new, empty AGH_HOME (clean home).',
    )
  const legacy = scope?.legacyManagedRoot
  if (!legacy) {
    const home = resolve(process.env.AGH_HOME || join(process.env.HOME || homedir(), AGH_DIR))
    const canonical = await realpath(home).catch(() => home)
    if (!inside(home, abs) && !inside(canonical, abs)) return
    throw denied()
  }
  if (scope.root !== legacy || !inside(legacy, abs)) throw denied()
  const identity = await lstat(legacy, { bigint: true })
  if (
    !scope.legacyDirectoryIdentity ||
    `${identity.dev}:${identity.ino}` !== scope.legacyDirectoryIdentity ||
    identity.isSymbolicLink() ||
    (await realpath(legacy)) !== legacy
  )
    throw denied()
  const actual = await realpath(abs)
  if (!inside(legacy, actual)) throw denied()
}
