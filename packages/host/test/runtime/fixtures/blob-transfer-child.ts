import { DatabaseSync, StatementSync } from 'node:sqlite'
import { report } from './artifact-world.js'
import { call, type Directory, openWorld, PARTS_KEPT, type Step } from './blob-transfer-world.js'

/**
 * Takes one transfer step on the stores under a root and blocks at a durable point inside it, for
 * the parent to kill: `blob-transfer-child <root> <step> <point> <request json> <directory json>`.
 */

type Halt = Readonly<{
  /** The first words of the statement, as the store prepares it. */
  statement: string
  /** Its occurrence in this process, from 1. */
  nth?: number
  /** Before it runs, after it runs, or after the commit of the transaction it ran in. */
  at: 'before' | 'after' | 'commit'
}>

const HALTS: Readonly<Record<string, Halt>> = {
  // The role is fenced inside the open transaction; the fence record is not written.
  'fence-open': { statement: 'INSERT INTO maintenance_transfers', at: 'before' },
  'fence-committed': { statement: 'INSERT INTO maintenance_transfers', at: 'commit' },
  // The parts of the tables before the chunk table are stored; the export is not recorded.
  'export-partial': { statement: 'SELECT upload_id, at, bytes FROM upload_chunks', at: 'before' },
  'export-recorded': { statement: 'INSERT INTO maintenance_exports', at: 'after' },
  // The second asset's bytes are staged in rows; its content file is not written.
  'import-asset': { statement: 'SELECT bytes FROM maintenance_asset_chunks', nth: 2, at: 'before' },
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

const [root, step, point, request, directory] = process.argv.slice(2)
const halt = point === undefined ? undefined : HALTS[point]
if (root === undefined || step === undefined || !halt || request === undefined || directory === undefined) {
  process.stderr.write('usage: blob-transfer-child <root> <step> <point> <request json> <directory json>\n')
  process.exit(2)
}

const world = openWorld(root, JSON.parse(directory) as Directory)

/** Reports the point, then blocks the whole process, inside whatever the store was doing. */
const block = () => {
  report('paused', { point, data: null })
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
}
let seen = 0
let committing = false
for (const method of ['run', 'iterate'] as const) {
  const original = StatementSync.prototype[method] as (...args: unknown[]) => unknown
  StatementSync.prototype[method] = function (this: StatementSync, ...args: unknown[]) {
    const hit =
      this.sourceSQL.replace(/\s+/g, ' ').trim().startsWith(halt.statement) && ++seen === (halt.nth ?? 1)
    if (hit && halt.at === 'before') block()
    const result = original.apply(this, args)
    if (hit && halt.at === 'after') block()
    if (hit && halt.at === 'commit') committing = true
    return result
  } as never
}
const exec = DatabaseSync.prototype.exec
DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
  exec.call(this, sql)
  // Transaction bodies are synchronous, so the next commit is the one the statement ran in.
  if (committing && sql === 'COMMIT') block()
}

const outcome = await call(world, step as Step, JSON.parse(request))
world.close()
report('returned', outcome)
