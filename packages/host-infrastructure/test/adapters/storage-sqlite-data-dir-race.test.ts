import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// The hook runs inside the first look at the package tables, i.e. exactly where another process can
// create the data directory between a process's checks.
const hook = vi.hoisted(() => ({ run: undefined as undefined | (() => void) }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readdirSync: ((...args: Parameters<typeof actual.readdirSync>) => {
      const run = hook.run
      hook.run = undefined
      run?.()
      return actual.readdirSync(...args)
    }) as typeof actual.readdirSync,
  }
})

import { createSqliteStorage, DATA_DIR_VERSION } from '../../src/adapters/storage-sqlite.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agnes-data-dir-race-'))
})
afterEach(() => {
  hook.run = undefined
  rmSync(dir, { recursive: true, force: true })
})

it.each([1, DATA_DIR_VERSION])(
  'never removes a concurrently created format %s data directory',
  async (version) => {
    const file = join(dir, 'sessions.db')
    const tablesDir = join(dir, 'tables')
    // Process A: creates and stamps the directory, then (like the daemon) creates a package table.
    hook.run = () => {
      if (version === DATA_DIR_VERSION) void createSqliteStorage({ file, tablesDir }).close()
      else {
        const ledger = new DatabaseSync(file)
        ledger.exec(`CREATE TABLE events (x); PRAGMA user_version = ${version}`)
        ledger.close()
      }
      mkdirSync(tablesDir, { recursive: true })
      const table = new DatabaseSync(join(tablesDir, '_40agnes_2fdaemon.db'))
      table.exec('CREATE TABLE jobs (id TEXT)')
      table.close()
    }
    if (version === DATA_DIR_VERSION) {
      const b = createSqliteStorage({ file, tablesDir })
      await b.close()
    } else {
      expect(() => createSqliteStorage({ file, tablesDir })).toThrow(
        expect.objectContaining({ code: 'E_DATA_DIR_STALE' }),
      )
    }
    expect(hook.run).toBeUndefined()
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(join(tablesDir, '_40agnes_2fdaemon.db')).length).toBeGreaterThan(0)
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: version })
    } finally {
      db.close()
    }
  },
)
