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
    db.exec('PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;')
    // The lease file holds runtime state only: a file left by an older layout is rebuilt, not migrated.
    const tables = new Set(
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .all()
        .map((row) => String(row.name)),
    )
    const current =
      !tables.has('process_owner') &&
      !tables.has('diagnostics') &&
      (!tables.has('instance') ||
        db
          .prepare('PRAGMA table_info(instance)')
          .all()
          .some((column) => column.name === 'pid'))
    if (!current)
      db.exec(
        'DROP TABLE IF EXISTS instance; DROP TABLE IF EXISTS process_owner; DROP TABLE IF EXISTS diagnostics;',
      )
    db.exec(`CREATE TABLE IF NOT EXISTS instance (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL, pid INTEGER, start_id TEXT);
      COMMIT;`)
    const previous = db.prepare('SELECT state FROM instance WHERE id=1').get()?.state
    if (previous !== undefined && previous !== 'active' && previous !== 'stopped' && previous !== 'unknown')
      throw new ManagedServiceError('REFUSED')
    let released = false
    return {
      id,
      previous,
      owner() {
        const row = db.prepare('SELECT pid, start_id FROM instance WHERE id=1').get()
        return row && typeof row.pid === 'number' && typeof row.start_id === 'string'
          ? { pid: row.pid, startId: row.start_id }
          : undefined
      },
      recordOwner(pid: number, startId: string | null) {
        db.prepare('UPDATE instance SET pid = ?, start_id = ? WHERE id = 1').run(pid, startId)
      },
      record(state: 'active' | 'stopped' | 'unknown') {
        // An active marker without its own identity must never inherit an old process identity.
        if (state === 'active')
          db.exec(
            `INSERT INTO instance (id, state, pid, start_id) VALUES (1, 'active', NULL, NULL)
              ON CONFLICT(id) DO UPDATE SET state = excluded.state, pid = NULL, start_id = NULL`,
          )
        else
          db.prepare(
            'INSERT INTO instance (id, state) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state',
          ).run(state)
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
