import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  createPrivateFileSync,
  hasPrivateDaclSync,
  renameWriteThroughSync,
  windowsEnsurePrivateDirectorySync,
  windowsOpenPrivateFileSync,
} from '@agnes/system-node'
import type { JournalStore } from './journal.js'
import { decodeJournal, freshJournal, type JournalState, storedJournal } from './journal-state.js'

const codeIs = (error: unknown, code: string) =>
  error !== null && typeof error === 'object' && 'code' in error && error.code === code
const failure = () => new Error('journal persistence unavailable')
const windows = process.platform === 'win32' // guards-allow-platform: SDK Node private journal backend.

/** JSON remains the durable format. A permanent SQLite sidecar serializes every read/modify/write,
 * including distinct instances and processes; the lock inode is never removed. */
export function fileJournal(directory: string, initialClientId?: string): JournalStore {
  const dir = resolve(directory)
  const file = join(dir, 'journal.json')
  const lock = join(dir, 'journal-lock.db')
  const save = (state: JournalState) => {
    const temp = join(dir, `journal.${randomUUID()}.tmp`)
    let fd: number | undefined = windows ? createPrivateFileSync(temp) : openSync(temp, 'wx', 0o600)
    try {
      writeFileSync(fd, JSON.stringify(state))
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      renameWriteThroughSync(temp, file)
    } finally {
      if (fd !== undefined) closeSync(fd)
      try {
        unlinkSync(temp)
      } catch {
        // A failed cleanup leaves only a private temporary file, never the authoritative journal.
      }
    }
  }
  return storedJournal((change, write) => {
    let db: DatabaseSync | undefined
    let result: ReturnType<typeof change> | undefined
    let failed = false
    try {
      if (windows) windowsEnsurePrivateDirectorySync(dir)
      else mkdirSync(dir, { recursive: true, mode: 0o700 })
      const parent = lstatSync(dir)
      if (!parent.isDirectory() || (!windows && (parent.mode & 0o777) !== 0o700)) throw failure()
      try {
        closeSync(windows ? createPrivateFileSync(lock) : openSync(lock, 'wx', 0o600))
      } catch (error) {
        if (!codeIs(error, 'EEXIST')) throw error
      }
      const lockStat = lstatSync(lock)
      if (
        !lockStat.isFile() ||
        lockStat.nlink !== 1 ||
        (windows ? !hasPrivateDaclSync(lock) : (lockStat.mode & 0o777) !== 0o600)
      )
        throw failure()
      db = new DatabaseSync(lock)
      db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE')
      let state: JournalState
      let needsSave = write
      let raw: Buffer | undefined
      try {
        const fd = windows
          ? windowsOpenPrivateFileSync(file)
          : openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        try {
          const stat = fstatSync(fd)
          if (!stat.isFile() || stat.nlink !== 1 || (!windows && (stat.mode & 0o777) !== 0o600))
            throw failure()
          raw = readFileSync(fd)
        } finally {
          closeSync(fd)
        }
      } catch (error) {
        if (!codeIs(error, 'ENOENT')) throw error
      }
      if (raw === undefined) {
        state = freshJournal(initialClientId)
        needsSave = true
      } else {
        try {
          state = decodeJournal(new TextDecoder('utf-8', { fatal: true }).decode(raw))
        } catch {
          // Resetting counters under a pinned identity would reuse command IDs.
          if (initialClientId !== undefined) throw failure()
          // Only decoding/shape failure reaches here. I/O and access failures never become fresh identity.
          renameWriteThroughSync(file, join(dir, `journal.json.corrupt-${Date.now()}-${randomUUID()}`))
          state = freshJournal(initialClientId)
          needsSave = true
        }
      }
      if (initialClientId !== undefined && state.clientId !== initialClientId) throw failure()
      result = change(state)
      if (needsSave) save(state)
    } catch {
      failed = true
    } finally {
      if (db) {
        try {
          db.exec('ROLLBACK')
        } catch {
          /* No transaction if lock acquisition failed. */
        }
        try {
          db.close()
        } catch {
          failed = true
        }
      }
    }
    if (failed) throw failure()
    return result as ReturnType<typeof change>
  })
}
