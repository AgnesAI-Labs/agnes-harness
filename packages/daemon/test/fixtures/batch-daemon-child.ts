// One daemon process for the batch crash test: the real supervisor, worker pool, scheduler and batch
// engine over one SQLite file, until the parent kills it. It prints `ready <socket>` once serving.
import { join } from 'node:path'
import { startBatchDaemon } from '../batch-daemon-harness.js'
import { sqliteTables } from '../sqlite-tables.js'

const [root, lockMs] = process.argv.slice(2) as [string, string]
const supervisor = await startBatchDaemon({
  dir: root,
  tables: sqliteTables(join(root, 'daemon.sqlite')),
  limits: { jobsLockMs: Number(lockMs) },
})
process.stdout.write(`ready ${supervisor.socketPath}\n`)
