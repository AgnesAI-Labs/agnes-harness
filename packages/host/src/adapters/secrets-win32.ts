import { lstatSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { hasPrivateDaclSync, windowsReadPrivateTextSync } from '@agnes/system-node'
import { HostError } from '../errors.js'

/** What a refused secret read is about: the configured store, its namespace, or the secret file. */
export type SecretPart = 'store' | 'namespace' | 'file'
/** Which test a directory failed. `not-private` is the native owner, access list and inheritance check. */
export type SecretCheck = 'symlink' | 'not-directory' | 'not-private'

const NOT_PRIVATE =
  'a private Windows directory has an owner we trust, an access list that names only trusted principals, ' +
  'and inheritance turned off (icacls <directory> /inheritance:r); a child of a private directory is not private until then'

const refused = (ref: string, part: SecretPart, check?: SecretCheck): HostError =>
  new HostError(
    'E_SECRET_UNRESOLVED',
    check === 'not-private'
      ? `secret ${part} directory is unsafe: ${NOT_PRIVATE}`
      : check
        ? `secret ${part} directory is unsafe (${check})`
        : 'secret file is unavailable or unsafe',
    // `reason` makes the refusal final (the next store is not asked); `part` and `check` say what failed.
    { detail: { ref, kind: 'file', reason: 'private-file', part, ...(check ? { check } : {}) } },
  )

/** Checks only the configured store and its namespace; reads never repair permissions. */
export function readWindowsSecret(dir: string, ns: string, name: string, ref: string): string {
  const root = resolve(dir)
  const directories: ReadonlyArray<readonly [SecretPart, string]> = [
    ['store', root],
    ['namespace', join(root, ns)],
  ]
  for (const [part, path] of directories) {
    let stat: ReturnType<typeof lstatSync>
    try {
      stat = lstatSync(path)
    } catch (error) {
      // A directory that is not there is a miss, as a missing secret file is; anything else is not.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new HostError('E_SECRET_UNRESOLVED', 'secret file is unavailable or unsafe', {
          detail: { ref, kind: 'file' },
        })
      throw refused(ref, part)
    }
    if (stat.isSymbolicLink()) throw refused(ref, part, 'symlink')
    if (!stat.isDirectory()) throw refused(ref, part, 'not-directory')
    let privateDacl: boolean
    try {
      privateDacl = hasPrivateDaclSync(path)
    } catch {
      throw refused(ref, part)
    }
    if (!privateDacl) throw refused(ref, part, 'not-private')
  }
  try {
    return windowsReadPrivateTextSync(join(root, ns, name), 1024 * 1024)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new HostError('E_SECRET_UNRESOLVED', 'secret file is unavailable or unsafe', {
        detail: { ref, kind: 'file' },
      })
    throw refused(ref, 'file')
  }
}
