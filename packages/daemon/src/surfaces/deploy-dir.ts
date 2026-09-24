import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { verifyWorkspace } from '@agnes/package-manager'

/** Recovers the customer deploy directory a profile has signed off on. The lockfile is the only
 * durable record of it: `agnes profile trust <dir>` pins both the relative path and a tree hash,
 * and verifyWorkspace re-checks that hash here. A profile that never trusted a deploy directory
 * has no Surfaces to coordinate, so this returns undefined rather than throwing -- no deployment
 * is a normal state, not a failure. verifyWorkspace's ok branch already hands back the resolved,
 * contained absolute path (its `deployDir`), so it is used as-is rather than re-joined here. */
export function resolveDeployDir(profileDir: string): string | undefined {
  const lockFile = join(profileDir, 'agnes.lock')
  if (!existsSync(lockFile)) return undefined
  let lock: unknown
  try {
    lock = JSON.parse(readFileSync(lockFile, 'utf8'))
  } catch {
    return undefined
  }
  const verification = verifyWorkspace(lock as Parameters<typeof verifyWorkspace>[0], profileDir)
  return verification.ok ? verification.deployDir : undefined
}
