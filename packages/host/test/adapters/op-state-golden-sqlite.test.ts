import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readGolden, recordTransitions, TRANSITION_SCENARIOS } from '@agnes/core/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteStorage } from '../../src/adapters/storage-sqlite.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// The same reference as the in-memory run: the durable adapter must commit exactly what the
// reference implementation commits, commit by commit.
describe('program-counter transitions match the recorded reference (SQLite)', () => {
  it.each(TRANSITION_SCENARIOS)('%s', async (name) => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-op-golden-'))
    dirs.push(dir)
    const storage = createSqliteStorage({ file: join(dir, 'sessions.db'), tablesDir: join(dir, 'tables') })
    try {
      expect(await recordTransitions(name, storage)).toEqual(readGolden(name))
    } finally {
      await storage.close()
    }
  })
})
