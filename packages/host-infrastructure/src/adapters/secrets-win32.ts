import { lstatSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { HostError } from '@agnes/host-common/errors'
import { hasPrivateDaclSync, windowsReadPrivateTextSync } from '@agnes/system-node'

/** Checks only the configured store and its namespace; reads never repair permissions. */
export function readWindowsSecret(dir: string, ns: string, name: string, ref: string): string {
  let part: 'store' | 'namespace' | 'file' = 'store'
  let check: 'symlink' | 'not-directory' | 'not-private' | undefined
  let missingEligible = false
  try {
    const root = resolve(dir)
    for (const entry of [
      { part: 'store', path: root },
      { part: 'namespace', path: join(root, ns) },
    ] as const) {
      part = entry.part
      missingEligible = true
      const stat = lstatSync(entry.path)
      missingEligible = false
      check = stat.isSymbolicLink() ? 'symlink' : !stat.isDirectory() ? 'not-directory' : undefined
      if (!check && !hasPrivateDaclSync(entry.path)) check = 'not-private'
      if (check) throw new Error('unsafe directory')
    }
    part = 'file'
    missingEligible = true
    return windowsReadPrivateTextSync(join(root, ns, name), 1024 * 1024)
  } catch (error) {
    const missing = missingEligible && (error as NodeJS.ErrnoException).code === 'ENOENT'
    throw new HostError(
      'E_SECRET_UNRESOLVED',
      missing
        ? 'secret file is unavailable'
        : 'Secret permissions refused. Directories require private access with inheritance turned off (icacls /inheritance:r).',
      {
        detail: {
          ref,
          kind: 'file',
          ...(missing ? {} : { reason: 'private-file', part, ...(check ? { check } : {}) }),
        },
      },
    )
  }
}
