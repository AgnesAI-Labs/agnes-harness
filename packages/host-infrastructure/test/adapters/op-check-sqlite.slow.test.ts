import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { StorageAdapter } from '@agnes/core'
import {
  OP_CHECK_CASES,
  type SweepStore,
  sweepOpenPoints,
  type Tamperable,
  TRANSITION_SCENARIOS,
} from '@agnes/core/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteStorage } from '../../src/adapters/storage-sqlite.js'

const dirs: string[] = []
const files = new Map<StorageAdapter, string>()
afterEach(async () => {
  for (const storage of files.keys()) await storage.close().catch(() => undefined)
  files.clear()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const sqlite: Tamperable = {
  make() {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-op-check-'))
    dirs.push(dir)
    const file = join(dir, 'sessions.db')
    const storage = createSqliteStorage({ file, tablesDir: join(dir, 'tables') })
    files.set(storage, file)
    return storage
  },
  // A second connection writes the register table the adapter reads, as someone editing the file would.
  async setOpCell(storage, key, lane, cell) {
    const db = new DatabaseSync(files.get(storage) as string)
    try {
      const where = [key, 'op.state', Buffer.from(lane, 'utf8')] as const
      db.prepare('DELETE FROM registers WHERE session_key = ? AND register = ? AND key = ?').run(...where)
      if (cell)
        db.prepare(
          'INSERT INTO registers (session_key, register, key, seq, data) VALUES (?, ?, ?, ?, ?)',
        ).run(...where, cell.seq, JSON.stringify(cell.data))
    } finally {
      db.close()
    }
  },
}

describe('the open-time check of the program-counter cells (SQLite)', () => {
  for (const [name, run] of Object.entries(OP_CHECK_CASES)) it(name, () => run(sqlite))
})

const fresh = (): { storage: StorageAdapter; dir: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-op-sweep-'))
  const file = join(dir, 'sessions.db')
  const storage = createSqliteStorage({ file, tablesDir: join(dir, 'tables') })
  files.set(storage, file)
  return { storage, dir }
}
const sweepDirs = new Map<StorageAdapter, string>()
// A copy of the database file as committed, with every writer claim dropped.
const sqliteSweep: SweepStore = {
  make() {
    const { storage, dir } = fresh()
    sweepDirs.set(storage, dir)
    return storage
  },
  snapshot(live) {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-op-sweep-'))
    const file = join(dir, 'sessions.db')
    const source = new DatabaseSync(files.get(live) as string)
    try {
      source.prepare('VACUUM INTO ?').run(file)
    } finally {
      source.close()
    }
    const copy = new DatabaseSync(file)
    try {
      copy.exec('DELETE FROM writer_claims')
    } finally {
      copy.close()
    }
    const storage = createSqliteStorage({ file, tablesDir: join(dir, 'tables') })
    files.set(storage, file)
    sweepDirs.set(storage, dir)
    return storage
  },
  async dispose(storage) {
    await storage.close()
    files.delete(storage)
    rmSync(sweepDirs.get(storage) as string, { recursive: true, force: true })
    sweepDirs.delete(storage)
  },
}

describe('no legal state is refused (SQLite)', () => {
  it.each(TRANSITION_SCENARIOS)(
    'every session at every commit and child creation of %s',
    async (name) => {
      const result = await sweepOpenPoints(name, sqliteSweep)
      expect(result.failures).toEqual([])
      expect(result.points).toBeGreaterThan(0)
      if (name.endsWith('-child')) expect(result.childOpens).toBeGreaterThan(0)
    },
    60_000,
  )
})
