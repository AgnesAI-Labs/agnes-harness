import { lstatSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'
import { nativeRealpathSync } from '@agnes/system-node/realpath'
import { PackageError } from './errors.js'

export function contained(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

export function workspacePath(
  profileDir: string,
  deployDir: string,
): { deployDir: string; relative: string } {
  let root: string
  let deploy: string
  try {
    root = nativeRealpathSync(profileDir)
    if (lstatSync(deployDir).isSymbolicLink()) throw new Error('symlink')
    deploy = nativeRealpathSync(deployDir)
  } catch {
    throw new PackageError('E_WORKSPACE_UNTRUSTED', 'workspace directory is not readable', {
      detail: { reason: 'unreadable' },
    })
  }
  if (!contained(root, deploy) || deploy === root)
    throw new PackageError('E_WORKSPACE_UNTRUSTED', 'workspace must be contained by the profile directory', {
      detail: { reason: 'outside-profile' },
    })
  const portable = relative(root, deploy).split(sep).join('/')
  return { deployDir: deploy, relative: portable }
}
