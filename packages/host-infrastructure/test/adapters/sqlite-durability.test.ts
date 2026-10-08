import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { syncCheckpointsToMedium } from '../../src/adapters/sqlite-durability.js'
import { createSqliteStorage } from '../../src/adapters/storage-sqlite.js'

type Os = 'darwin' | 'linux' | 'win32'
const state = vi.hoisted(() => ({
  os: 'darwin' as Os,
  opened: [] as Array<import('node:sqlite').DatabaseSync>,
}))

vi.mock('../../src/adapters/platform.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/adapters/platform.js')>()
  return { ...actual, createPlatform: () => ({ ...actual.createPlatform(), os: state.os }) }
})
// Records every connection the storage adapter opens, so the test can ask each one for its pragma.
vi.mock('node:sqlite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:sqlite')>()
  class TrackedDatabase extends actual.DatabaseSync {
    constructor(...args: ConstructorParameters<typeof actual.DatabaseSync>) {
      super(...args)
      state.opened.push(this)
    }
  }
  return { ...actual, DatabaseSync: TrackedDatabase }
})

const pragma = (db: DatabaseSync | undefined, name: string) =>
  Object.values(db?.prepare(`PRAGMA ${name}`).get() ?? {})[0]

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agnes-sqlite-durability-'))
  state.opened.length = 0
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('syncCheckpointsToMedium', () => {
  it.each([
    ['darwin', 1],
    ['linux', 0],
    ['win32', 0],
  ] as const)('on %s leaves checkpoint_fullfsync at %i and never turns on fullfsync', (os, expected) => {
    const db = new DatabaseSync(join(dir, 'probe.db'))
    try {
      syncCheckpointsToMedium(db, os)
      expect(pragma(db, 'checkpoint_fullfsync')).toBe(expected)
      expect(pragma(db, 'fullfsync')).toBe(0)
    } finally {
      db.close()
    }
  })
})

describe('ledger storage connections', () => {
  it.each([
    ['darwin', 1],
    ['linux', 0],
    ['win32', 0],
  ] as const)(
    'on %s open the ledger and a table store with checkpoint_fullfsync %i',
    async (os, expected) => {
      state.os = os
      const storage = createSqliteStorage({ file: join(dir, 'sessions.db'), tablesDir: join(dir, 'tables') })
      try {
        storage.tables('@agnes/durability-test')
        const [ledger, tables] = state.opened
        expect(state.opened).toHaveLength(2)
        // The table store's authorizer refuses PRAGMA; lift it so the test can read the setting.
        tables?.setAuthorizer(null)
        for (const db of [ledger, tables]) {
          expect(pragma(db, 'checkpoint_fullfsync')).toBe(expected)
          expect(pragma(db, 'fullfsync')).toBe(0)
        }
        // Commits stay unsynced: the ledger keeps synchronous = NORMAL.
        expect(pragma(ledger, 'synchronous')).toBe(1)
      } finally {
        await storage.close()
      }
    },
  )
})
