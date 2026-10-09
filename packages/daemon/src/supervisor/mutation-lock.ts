import { closeSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  createPrivateFileSync,
  hasPrivateDaclSync,
  windowsEnsurePrivateDirectorySync,
  windowsProtectPrivateFileSync,
} from '@agnes/system-node'

export class DaemonMutationLockError extends Error {
  override name = 'DaemonMutationLockError'
  readonly code: 'E_DAEMON_BUSY' | 'E_DAEMON_LOCK'
  constructor(busy: boolean, detail?: string) {
    super(
      busy
        ? 'daemon or package mutation lock is held'
        : `daemon mutation lock unavailable${detail ? `: ${detail}` : ''}`,
    )
    this.code = busy ? 'E_DAEMON_BUSY' : 'E_DAEMON_LOCK'
  }
}
const hasCode = (error: unknown, code: string) =>
  error !== null && typeof error === 'object' && 'code' in error && error.code === code
const isBusy = (error: unknown) => {
  if (!error || typeof error !== 'object' || !('errcode' in error) || typeof error.errcode !== 'number')
    return false
  return [5, 6].includes(error.errcode & 255)
}

/** All participants retain the same database inode. Never unlink this file on release. */
export function acquireDaemonMutationLock(
  dataDir: string,
  lockFile = 'mutation-lock.db',
): { release(): void } {
  let db: DatabaseSync | undefined
  let stage = 'cannot prepare private daemon directory; check ownership and access permissions'
  try {
    const dir = join(dataDir, 'daemon')
    const windows = process.platform === 'win32' // guards-allow-platform: protect Windows daemon lock directory and file.
    if (windows) windowsEnsurePrivateDirectorySync(dir)
    else mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (!lstatSync(dir).isDirectory()) throw new Error()
    if (!/^[a-z][a-z0-9-]{0,63}\.db$/u.test(lockFile)) throw new Error()
    const file = join(dir, lockFile)
    stage = 'cannot create lock file; check directory access and free disk space'
    try {
      closeSync(windows ? createPrivateFileSync(file) : openSync(file, 'wx', 0o600))
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error
    }
    stage = 'lock path must be a regular file, not a link or directory'
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || (windows && stat.nlink !== 1)) throw new Error()
    stage = 'lock permissions are unsafe or cannot be verified; check owner and private access'
    if (windows && !hasPrivateDaclSync(file)) {
      if (!['startup-lock.db', 'mutation-lock.db'].includes(lockFile)) throw new Error()
      windowsProtectPrivateFileSync(file)
    }
    stage =
      'cannot open lock database; check file access and database integrity without deleting active lock files'
    db = new DatabaseSync(file)
    db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE')
    const held = db
    let released = false
    return {
      release() {
        if (released) return
        released = true
        try {
          try {
            held.exec('ROLLBACK')
          } finally {
            held.close()
          }
        } catch {
          throw new DaemonMutationLockError(false)
        }
      },
    }
  } catch (error) {
    try {
      db?.close()
    } catch {
      /* Preserve the fixed acquisition error. */
    }
    throw new DaemonMutationLockError(
      isBusy(error),
      hasCode(error, 'E_SYSTEM_NATIVE_UNAVAILABLE')
        ? 'Windows native helper unavailable; rebuild the complete local distribution'
        : stage,
    )
  }
}
