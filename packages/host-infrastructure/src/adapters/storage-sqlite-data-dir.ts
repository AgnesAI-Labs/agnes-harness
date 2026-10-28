import { readdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { CoreError } from '@agnes/core'

/**
 * The version of everything persisted under one data directory. It is stamped in `sessions.db`
 * only, in `PRAGMA user_version` of the raw connection, because the SQL gateway refuses `PRAGMA`
 * on `tables/*.db`; those files have no version of their own and are covered by this one. It also
 * replaces the downgrade guard `child_control_meta` used to give: a build refuses a directory a
 * newer one stamped, instead of reading tables it no longer understands.
 *
 * Raise this by one in the same change whenever the persisted shape of a table that an existing
 * stamped directory already contains changes. Adding or dropping a table that only new code reads
 * or writes does not need a bump.
 */
export const DATA_DIR_VERSION = 2

export type DataDirPaths = { file: string; tablesDir: string }

function resetInstructions({ file, tablesDir }: DataDirPaths): string {
  return (
    `Stop AGH, back up ${dirname(file)}, then delete ${file}, ${file}-wal, ${file}-shm and the directory ${tablesDir}. ` +
    'Sessions, schedules, workspace bindings and plugin settings are lost; plugins you installed yourself must be reinstalled. Nothing was changed.'
  )
}

/** Read-only. Throws E_DATA_DIR_STALE / E_DATA_DIR_NEWER; never writes. */
export function assertDataDirVersion(db: DatabaseSync, paths: DataDirPaths): 'fresh' | 'current' {
  const { file, tablesDir } = paths
  const dataDir = dirname(file)
  // Look at the package tables BEFORE the snapshot. Package tables are only created after
  // sessions.db has committed, so a table seen here means the snapshot below is not empty. Read in
  // the other order, a process that creates the directory in between makes a live ledger look like
  // an orphan, and the caller would then delete the file that process just stamped.
  const packageTables = hasPackageTables(tablesDir)
  // One statement, so one snapshot: another process committing between two reads would show tables
  // with a version that does not yet include them.
  const row = db
    .prepare(
      `SELECT user_version,
        (SELECT count(*) FROM sqlite_master) AS objects,
        (SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name IN ('ledger_heads', 'child_control_meta')) AS legacy
      FROM pragma_user_version`,
    )
    .get() as { user_version: number; objects: number; legacy: number }
  const found = row.user_version
  const empty = row.objects === 0
  // Builds from before the version stamp never read it, yet re-create these two tables when they
  // open a directory. Seeing either in a stamped directory means such a build has written to it,
  // and what it wrote is not understood here.
  const olderBuildWrote = row.legacy > 0
  const stale = (reason: 'older' | 'orphan-tables') => ({
    reason,
    dataDir,
    file,
    tablesDir,
    found,
    supported: DATA_DIR_VERSION,
  })
  if (found > DATA_DIR_VERSION)
    throw new CoreError(
      'E_DATA_DIR_NEWER',
      `data directory ${dataDir} was written by a newer AGH (data format ${found}; this build supports ${DATA_DIR_VERSION}); upgrade AGH. Nothing was changed.`,
      { dataDir, file, found, supported: DATA_DIR_VERSION },
    )
  if (empty) {
    if (packageTables)
      throw new CoreError(
        'E_DATA_DIR_STALE',
        `data directory ${dataDir} has package tables in ${tablesDir} but no ledger at ${file}. ${resetInstructions(paths)}`,
        stale('orphan-tables'),
      )
    return 'fresh'
  }
  if (found < DATA_DIR_VERSION || olderBuildWrote) {
    // A stamped directory reads as the current format, so "(data format N; this build supports N)"
    // would say the two match while refusing.
    const origin =
      found >= DATA_DIR_VERSION
        ? `was created by an older AGH and cannot be used (data format ${found}; an older AGH wrote into it after it was stamped)`
        : `was created by an older AGH (data format ${found}; this build supports ${DATA_DIR_VERSION})`
    throw new CoreError(
      'E_DATA_DIR_STALE',
      `data directory ${dataDir} ${origin}. ${resetInstructions(paths)}`,
      stale('older'),
    )
  }
  return 'current'
}

function hasPackageTables(tablesDir: string): boolean {
  try {
    return readdirSync(tablesDir).some((name) => name.endsWith('.db'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Creates the core tables and stamps a new directory, in one write transaction. The version is
 * checked again once the lock is held: a second process may have finished creating the directory
 * while this one waited.
 */
export function prepareDataDir(db: DatabaseSync, paths: DataDirPaths, ddl: readonly string[]): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    const state = assertDataDirVersion(db, paths)
    for (const statement of ddl) db.exec(statement)
    if (state === 'fresh') db.exec(`PRAGMA user_version = ${DATA_DIR_VERSION}`)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

const SQLITE_BUSY = 5
const WAL_WAIT_MS = 5000

/**
 * Switches the file to WAL. SQLite does not run the busy handler for this switch, so two processes
 * creating the same data directory at once make one fail with SQLITE_BUSY instead of waiting. The
 * wait is synchronous, like `busy_timeout`, and bounded by the same 5 s.
 */
export function enableWal(db: DatabaseSync): void {
  const deadline = Date.now() + WAL_WAIT_MS
  for (;;) {
    try {
      db.exec('PRAGMA journal_mode = WAL')
      return
    } catch (error) {
      if ((error as { errcode?: number }).errcode !== SQLITE_BUSY || Date.now() >= deadline) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
  }
}
