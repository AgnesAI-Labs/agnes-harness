import { createHash } from 'node:crypto'
import { closeSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ARTIFACT_REF_EXTRACTOR_VERSION } from '../artifact-ledger-refs.js'

/** Immutable archive roots are published atomically with the body, before any live-ledger purge. */
export function readComparisonArchiveRoots(
  dataDir: string,
  candidates: ReadonlySet<string>,
): ReadonlySet<string> {
  const directory = join(dataDir, 'comparisons')
  const file = join(directory, 'index.sqlite')
  try {
    const dir = lstatSync(directory)
    if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error('Comparison archive directory is invalid')
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Comparison archive database is invalid')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
    throw error
  }
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return readRoots(db, candidates)
  } finally {
    db.close()
  }
}

/** Acquire after the ledger lock; archive publishers take only this database's write lock. */
export async function withComparisonArchiveRootsLock<T>(
  dataDir: string,
  candidates: ReadonlySet<string>,
  waitMs: number,
  operation: (roots: ReadonlySet<string>) => Promise<T>,
): Promise<T> {
  const data = lstatSync(dataDir)
  if (!data.isDirectory() || data.isSymbolicLink())
    throw new Error('Comparison archive data directory is invalid')
  const directory = join(dataDir, 'comparisons')
  try {
    mkdirSync(directory, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const dir = lstatSync(directory)
  if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error('Comparison archive directory is invalid')
  const file = join(directory, 'index.sqlite')
  // Materialize even an absent database before checking roots. An empty-set read alone would
  // let a publisher create the database between the final proof and physical deletion.
  try {
    closeSync(openSync(file, 'wx', 0o600))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Comparison archive database is invalid')
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error('Comparison archive lock budget is invalid')
  const db = new DatabaseSync(file)
  try {
    db.exec(`PRAGMA busy_timeout=${Math.floor(waitMs)}; BEGIN IMMEDIATE`)
    try {
      const result = await operation(readRoots(db, candidates))
      db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // Preserve the root proof or deletion failure.
      }
      throw error
    }
  } finally {
    db.close()
  }
}

function readRoots(db: DatabaseSync, candidates: ReadonlySet<string>): ReadonlySet<string> {
  const found = new Set<string>()
  const tables = ['comparison_archives', 'comparison_tree_archives'].filter((table) =>
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table),
  )
  for (const table of tables)
    for (const row of db.prepare(`SELECT digest,roots,roots_digest,roots_version FROM ${table}`).iterate()) {
      if (row.roots_version !== ARTIFACT_REF_EXTRACTOR_VERSION)
        throw new Error('Comparison archive root extractor version is unsupported')
      const roots = String(row.roots)
      const expected = createHash('sha256')
        .update(`${ARTIFACT_REF_EXTRACTOR_VERSION}\n${String(row.digest)}\n${roots}`)
        .digest('hex')
      if (expected !== row.roots_digest) throw new Error('Comparison archive root receipt is invalid')
      const values: unknown = JSON.parse(roots)
      if (
        !Array.isArray(values) ||
        values.some((value) => typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
      )
        throw new Error('Comparison archive roots are malformed')
      for (const value of values as string[]) if (candidates.has(value)) found.add(value)
    }
  return found
}
