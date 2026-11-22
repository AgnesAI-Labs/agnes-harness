import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { chmod } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'

const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'utf8')
const unsafeLock = () => Object.assign(new Error('E_HOME_UNSAFE'), { code: 'E_HOME_UNSAFE' })

/** Read-only check for an existing SQLite configuration lock file without altering permissions. */
export function isValidConfigurationLockFileSync(file: string): boolean {
  let fd: number
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  } catch {
    return false
  }
  try {
    const stat = fstatSync(fd)
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid())
    )
      return false
    if (stat.size === 0) return true
    if (stat.size < SQLITE_HEADER.length) return false
    const header = Buffer.alloc(SQLITE_HEADER.length)
    let read = 0
    while (read < header.length) {
      const chunk = readSync(fd, header, read, header.length - read, read)
      if (chunk === 0) break
      read += chunk
    }
    return read === SQLITE_HEADER.length && header.equals(SQLITE_HEADER)
  } finally {
    closeSync(fd)
  }
}

function preparePosixLockFileSync(file: string): void {
  if (typeof process.getuid !== 'function') return
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const created = openSync(
        file,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
        0o600,
      )
      closeSync(created)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    let fd: number
    try {
      fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw unsafeLock()
    }
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid()) throw unsafeLock()
      if (stat.size > 0) {
        if (stat.size < SQLITE_HEADER.length) throw unsafeLock()
        const header = Buffer.alloc(SQLITE_HEADER.length)
        let read = 0
        while (read < header.length) {
          const chunk = readSync(fd, header, read, header.length - read, read)
          if (chunk === 0) break
          read += chunk
        }
        if (read !== SQLITE_HEADER.length || !header.equals(SQLITE_HEADER)) throw unsafeLock()
      }
      return
    } finally {
      closeSync(fd)
    }
  }
}

async function tightenPosixLockMode(file: string): Promise<void> {
  if (typeof process.getuid !== 'function') return
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid())
    throw unsafeLock()
  // Use path-based chmod(2) here: opening and closing another fd on the same inode would release SQLite's POSIX fcntl lock.
  if ((stat.mode & 0o7777) !== 0o600) await chmod(file, 0o600)
}

/** Kernel-owned transaction lock: a crashed setup process cannot leave a permanent busy marker. */
export async function withConfigurationLock<T>(
  file: string,
  action: () => Promise<T>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  options.signal?.throwIfAborted()
  preparePosixLockFileSync(file)
  const db = new DatabaseSync(file)
  const deadline = Date.now() + (options.timeoutMs ?? 5_000)
  try {
    for (;;) {
      options.signal?.throwIfAborted()
      try {
        db.exec('BEGIN EXCLUSIVE')
        break
      } catch (error) {
        const code = (error as { errcode?: number }).errcode
        if ((code !== 5 && code !== 6) || Date.now() >= deadline) throw error
        await delay(25, undefined, { signal: options.signal })
      }
    }
    await tightenPosixLockMode(file)
    try {
      const result = await action()
      db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* Closing also releases the transaction lock. */
      }
      throw error
    }
  } finally {
    db.close()
  }
}
