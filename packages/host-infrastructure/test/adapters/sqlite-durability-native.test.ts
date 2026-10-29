import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { createPlatform } from '../../src/adapters/platform.js'
import { createSqliteStorage } from '../../src/adapters/storage-sqlite.js'

// The platform is the real one here; only the connections are recorded, so each can be asked.
const opened = vi.hoisted(() => [] as DatabaseSync[])
vi.mock('node:sqlite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:sqlite')>()
  class TrackedDatabase extends actual.DatabaseSync {
    constructor(...args: ConstructorParameters<typeof actual.DatabaseSync>) {
      super(...args)
      opened.push(this)
    }
  }
  return { ...actual, DatabaseSync: TrackedDatabase }
})

describe('ledger checkpoint sync on the real platform', () => {
  it('uses F_FULLFSYNC for checkpoints on darwin only, and never for commits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-sqlite-durability-native-'))
    const storage = createSqliteStorage({ file: join(dir, 'sessions.db'), tablesDir: join(dir, 'tables') })
    try {
      const ledger = opened[0]
      expect(ledger).toBeDefined()
      const pragma = (name: string) => Object.values(ledger?.prepare(`PRAGMA ${name}`).get() ?? {})[0]
      expect(pragma('journal_mode')).toBe('wal')
      expect(pragma('checkpoint_fullfsync')).toBe(createPlatform().os === 'darwin' ? 1 : 0)
      expect(pragma('fullfsync')).toBe(0)
      // A checkpoint through the ledger connection itself completes with the setting in force.
      expect(pragma('wal_checkpoint(TRUNCATE)')).toBe(0)
    } finally {
      await storage.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
