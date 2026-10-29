import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { DATA_DIR_VERSION } from '../../src/adapters/storage-sqlite.js'

// Real processes: the first open of a data directory must serialise, not fail one of two daemons
// (or a daemon and a worker) that start at the same moment.
it('two processes opening one fresh data dir both succeed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agnes-data-dir-'))
  try {
    const file = join(dir, 'sessions.db')
    const tablesDir = join(dir, 'tables')
    const script = join(dir, 'open.mts')
    const entry = pathToFileURL(
      fileURLToPath(new URL('../../src/adapters/storage-sqlite.ts', import.meta.url)),
    )
    await writeFile(
      script,
      `import { createSqliteStorage } from ${JSON.stringify(entry.href)}
const s = createSqliteStorage({ file: ${JSON.stringify(file)}, tablesDir: ${JSON.stringify(tablesDir)}, clock: Date.now })
await s.close()
`,
    )
    const start = () => {
      const child = spawn(process.execPath, ['--import', 'tsx', script], {
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let stderr = ''
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk)
      })
      return once(child, 'exit').then(([code]) => ({ code: code as number | null, stderr }))
    }
    const [a, b] = await Promise.all([start(), start()])
    expect({ codes: [a.code, b.code], stderr: [a.stderr, b.stderr] }).toEqual({
      codes: [0, 0],
      stderr: ['', ''],
    })
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: DATA_DIR_VERSION })
    } finally {
      db.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 60_000)
