import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { expect, it } from 'vitest'
import { createSqliteStorage } from '../../src/adapters/storage-sqlite.js'

// Serial SQLite throughput gate. No external provider, daemon, or private home. The 150 ms
// ceiling allows ample shared-runner headroom over the measured ~5 ms for 3,000 owner reads.
it('keeps repeated owner reads bounded and observes writes and schema changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-table-reads-'))
  const storage = createSqliteStorage({ file: join(dir, 'sessions.db'), tablesDir: join(dir, 'tables') })
  try {
    const table = storage.tables('synthetic').table('rows')
    table.exec('CREATE TABLE rows (id INTEGER PRIMARY KEY, value INTEGER)')
    table.transaction(() => {
      for (let id = 0; id < 50; id++) table.run('INSERT INTO rows VALUES (?, ?)', [id, id])
    })
    const query = 'SELECT value FROM rows WHERE id = ?'
    const samples: number[] = []
    for (let run = 0; run < 5; run++) {
      const start = performance.now()
      let sum = 0
      for (let id = 0; id < 3000; id++) sum += table.get<{ value: number }>(query, [id % 50])?.value ?? -1
      samples.push(performance.now() - start)
      expect(sum).toBe(73_500)
    }
    // Query diversity must not change results when an older plan is needed again.
    for (let id = 0; id < 160; id++) expect(table.get(`SELECT ${id} AS value`)).toEqual({ value: id })
    table.exec('ALTER TABLE rows ADD COLUMN note TEXT')
    table.run('UPDATE rows SET value = ? WHERE id = ?', [99, 0])
    expect(table.get(query, [0])).toEqual({ value: 99 })
    expect(() => table.get(query, ['\u0000'])).toThrow(/bind parameter/)
    expect(() => table.get('SELECT * FROM pragma_database_list')).toThrow()
    console.info({ dataset: { rows: 50, readsPerSample: 3000 }, samplesMs: samples })
    expect(Math.max(...samples)).toBeLessThan(150)
  } finally {
    await storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
