// Runs one batch against a file database until the parent kills this process.
import { batchHarness } from '../batch-fakes.js'
import { sqliteTables } from '../sqlite-tables.js'

const [database, root, transcripts, offset = '0'] = process.argv.slice(2) as [string, string, string, string?]
// A later run is started with its clock moved on, as a daemon restarted after the job lease ran out.
const offsetMs = Number(offset)
const h = batchHarness({
  root,
  tables: sqliteTables(database),
  dir: transcripts,
  clock: () => Date.now() + offsetMs,
  runMs: 20,
  model: (prompt) => ({ reply: JSON.stringify({ item: /Item (\d+)/u.exec(prompt)?.[1] ?? '?' }) }),
})
await h.engine.begin({
  batchId: 'b00000000c4a5',
  principalId: 'p',
  root,
  cwd: root,
  spec: {
    dir: 'items',
    prompt: 'Name {{name}}',
    schema: { type: 'object', properties: { item: { type: 'string' } }, required: ['item'] },
    concurrency: 4,
  },
})
// Progress goes to the parent on stdout, so the parent never opens the database while this process writes it.
for (;;) {
  await h.engine.tick()
  process.stdout.write(`done ${(await h.engine.status('p', 'b00000000c4a5')).counts.done}\n`)
  await h.scheduler.tick()
}
