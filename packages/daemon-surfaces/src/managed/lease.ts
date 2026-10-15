import { createHash } from 'node:crypto'
import { closeSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  createPrivateFileSync,
  hasPrivateDaclSync,
  windowsEnsurePrivateDirectorySync,
} from '@agnes/system-node'

export class ManagedServiceError extends Error {
  constructor(readonly code: 'BUSY' | 'REFUSED' | 'PORT_IN_USE' | 'SHUTDOWN_UNCONFIRMED' | 'UNAVAILABLE') {
    super(code)
  }
}
/** Exclusive SQLite locking survives COMMIT; kernel release on crash cannot erase the durable active marker. */
export function acquireManagedLease(directory: string, key: string) {
  const windows = process.platform === 'win32' // guards-allow-platform: managed lease private storage protection.
  if (windows) windowsEnsurePrivateDirectorySync(directory)
  else mkdirSync(directory, { recursive: true, mode: 0o700 })
  const dir = lstatSync(directory)
  if (
    !dir.isDirectory() ||
    dir.isSymbolicLink() ||
    (!windows && ((dir.mode & 0o077) !== 0 || dir.uid !== process.getuid?.()))
  )
    throw new ManagedServiceError('REFUSED')
  const id = createHash('sha256').update(key).digest('hex')
  const file = join(directory, `${id}.db`)
  try {
    closeSync(windows ? createPrivateFileSync(file) : openSync(file, 'wx', 0o600))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const stat = lstatSync(file)
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (windows ? !hasPrivateDaclSync(file) : (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
  )
    throw new ManagedServiceError('REFUSED')
  const db = new DatabaseSync(file)
  try {
    db.exec(`PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;
      CREATE TABLE IF NOT EXISTS instance (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS diagnostics (seq INTEGER PRIMARY KEY, reason TEXT NOT NULL);
      COMMIT;`)
    const previous = db.prepare('SELECT state FROM instance WHERE id=1').get()?.state
    if (previous !== undefined && previous !== 'active' && previous !== 'stopped' && previous !== 'unknown')
      throw new ManagedServiceError('REFUSED')
    let released = false
    return {
      id,
      previous,
      record(state: 'active' | 'stopped' | 'unknown') {
        db.prepare('INSERT INTO instance VALUES(1,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state').run(
          state,
        )
      },
      diagnose(reason: string) {
        db.prepare('INSERT INTO diagnostics(reason) VALUES(?)').run(reason)
        db.exec('DELETE FROM diagnostics WHERE seq <= (SELECT COALESCE(MAX(seq),0)-100 FROM diagnostics)')
      },
      diagnostics(): readonly string[] {
        return db
          .prepare('SELECT reason FROM diagnostics ORDER BY seq')
          .all()
          .map((row) => String(row.reason))
      },
      release() {
        if (!released) {
          released = true
          db.close()
        }
      },
    }
  } catch (error) {
    db.close()
    if (
      error &&
      typeof error === 'object' &&
      'errcode' in error &&
      [5, 6].includes(Number(error.errcode) & 255)
    )
      throw new ManagedServiceError('BUSY')
    throw new ManagedServiceError('UNAVAILABLE')
  }
}
export type ManagedLease = ReturnType<typeof acquireManagedLease>
