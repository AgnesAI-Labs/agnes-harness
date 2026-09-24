import { lstatSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { hasPrivateDaclSync, windowsReadPrivateTextSync } from '@agnes/system-node'
import { HostError } from '../errors.js'

/** Checks only the configured store and its namespace; reads never repair permissions. */
export function readWindowsSecret(dir: string, ns: string, name: string, ref: string): string {
  try {
    const root = resolve(dir)
    for (const path of [root, join(root, ns)]) {
      const stat = lstatSync(path)
      if (!stat.isDirectory() || stat.isSymbolicLink() || !hasPrivateDaclSync(path))
        throw Object.assign(new Error('unsafe secret directory'), { code: 'EACCES' })
    }
    return windowsReadPrivateTextSync(join(root, ns, name), 1024 * 1024)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    throw new HostError('E_SECRET_UNRESOLVED', 'secret file is unavailable or unsafe', {
      detail: { ref, kind: 'file', ...(code === 'ENOENT' ? {} : { reason: 'private-file' }) },
    })
  }
}
