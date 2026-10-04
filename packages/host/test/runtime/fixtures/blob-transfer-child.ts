import { DatabaseSync, StatementSync } from 'node:sqlite'
import { report } from './artifact-world.js'
import {
  call,
  type Directory,
  openCohort,
  openWorld,
  PARTS_KEPT,
  type Service,
  type Step,
  sides,
} from './blob-transfer-world.js'

/**
 * Takes one transfer step of a service on the stores under a root and blocks at a durable point
 * inside it, for the parent to kill:
 * `blob-transfer-child <root> <step> <point> <request json> <directory json> [blob|artifacts]`.
 */

type Halt = Readonly<{
  /** The first words of the statement, as the store prepares or executes it. */
  statement: string
  /** Its occurrence in this process, from 1. */
  nth?: number
  /** Before it runs, after it runs, or after the commit of the transaction it ran in. */
  at: 'before' | 'after' | 'commit'
}>

/** Points in the transfer engine every store shares. */
const SHARED: Readonly<Record<string, Halt>> = {
  // The role is fenced inside the open transaction; the fence record is not written.
  'fence-open': { statement: 'INSERT INTO maintenance_transfers', at: 'before' },
  'fence-committed': { statement: 'INSERT INTO maintenance_transfers', at: 'commit' },
  'export-recorded': { statement: 'INSERT INTO maintenance_exports', at: 'after' },
  // The next part's rows are inserted in its open transaction, before or after its checkpoint.
  'import-part-rows': {
    statement: 'UPDATE maintenance_imports SET manifest',
    nth: PARTS_KEPT + 1,
    at: 'before',
  },
  'import-part-checkpoint': {
    statement: 'UPDATE maintenance_imports SET manifest',
    nth: PARTS_KEPT + 1,
    at: 'after',
  },
  'import-part-committed': {
    statement: 'UPDATE maintenance_imports SET manifest',
    nth: PARTS_KEPT,
    at: 'commit',
  },
  // Every row and asset is in; the import result is not recorded.
  'import-walked': { statement: 'UPDATE maintenance_imports SET result', at: 'before' },
  // The role and epoch are updated inside the open transaction; the activation record is not written.
  'activate-open': { statement: 'UPDATE maintenance_imports SET activate_fingerprint', at: 'before' },
  'activate-committed': { statement: 'UPDATE maintenance_imports SET activate_fingerprint', at: 'commit' },
  'abort-open': { statement: 'UPDATE maintenance_transfers SET abort_fingerprint', at: 'before' },
  'abort-committed': { statement: 'UPDATE maintenance_transfers SET abort_fingerprint', at: 'commit' },
}

const HALTS: Readonly<Record<Service, Readonly<Record<string, Halt>>>> = {
  blob: {
    ...SHARED,
    // The parts of the tables before the chunk table are stored; the export is not recorded.
    'export-partial': { statement: 'SELECT upload_id, at, bytes FROM upload_chunks', at: 'before' },
    // The second asset's bytes are staged in rows; its content file is not written.
    'import-asset': { statement: 'SELECT bytes FROM maintenance_asset_chunks', nth: 2, at: 'before' },
  },
  artifacts: {
    ...SHARED,
    // The required assets are staged for the index; no part is stored.
    'export-staged': { statement: 'INSERT OR IGNORE INTO maintenance_export_assets', at: 'commit' },
    // The parts of the tables before the reservations are in the blob store's content; the rest are not.
    'export-partial': { statement: 'SELECT publication_id, artifact_id', at: 'before' },
    // Both indexes are stored and the staged assets are cleared; the export is not recorded.
    'export-cleared': { statement: 'DELETE FROM maintenance_export_assets', nth: 2, at: 'after' },
    // The import is recorded with empty checkpoints; nothing is walked.
    'import-recorded': { statement: 'INSERT INTO maintenance_imports', at: 'commit' },
    // The first required asset is checked off; the second is not.
    'import-asset': { statement: 'UPDATE maintenance_imports SET assets', at: 'after' },
    // A verify writes nothing; it is stopped before it reads the rows it checks.
    'verify-reading': { statement: 'SELECT * FROM artifacts', at: 'before' },
  },
}

const [root, step, point, request, directory, service = 'blob'] = process.argv.slice(2)
const halt = point === undefined ? undefined : HALTS[service as Service]?.[point]
if (root === undefined || step === undefined || !halt || request === undefined || directory === undefined) {
  process.stderr.write(
    'usage: blob-transfer-child <root> <step> <point> <request json> <directory json> [blob|artifacts]\n',
  )
  process.exit(2)
}

const routes = JSON.parse(directory) as Directory
const cohort = service === 'artifacts' ? openCohort(root, routes) : undefined
const world = cohort ? { ...sides(cohort, 'artifacts'), close: cohort.close } : openWorld(root, routes)

/** Reports the point, then blocks the whole process, inside whatever the store was doing. */
const block = () => {
  report('paused', { point, data: null })
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
}
let seen = 0
let committing = false
/** Counts the statement and blocks before it when it is the halt's; returns whether it is. */
const enter = (sql: string) => {
  const hit = sql.replace(/\s+/g, ' ').trim().startsWith(halt.statement) && ++seen === (halt.nth ?? 1)
  if (hit && halt.at === 'before') block()
  return hit
}
const leave = (hit: boolean) => {
  if (hit && halt.at === 'after') block()
  if (hit && halt.at === 'commit') committing = true
}
for (const method of ['run', 'iterate'] as const) {
  const original = StatementSync.prototype[method] as (...args: unknown[]) => unknown
  StatementSync.prototype[method] = function (this: StatementSync, ...args: unknown[]) {
    const hit = enter(this.sourceSQL)
    const result = original.apply(this, args)
    leave(hit)
    return result
  } as never
}
const exec = DatabaseSync.prototype.exec
DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
  const hit = enter(sql)
  exec.call(this, sql)
  leave(hit)
  // Transaction bodies are synchronous, so the next commit is the one the statement ran in.
  if (committing && sql === 'COMMIT') block()
}

const outcome = await call(world, step as Step, JSON.parse(request))
world.close()
report('returned', outcome)
