import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { createPlatform } from '../../src/adapters/platform.js'
import { createSqliteStorage } from '../../src/adapters/storage-sqlite.js'
import { ev } from './events.js'

// The platform is the real one here; only the connections are recorded, so each can be asked.
const opened = vi.hoisted(() => [] as DatabaseSync[])
const transactions = vi.hoisted(
  () => [] as { db: DatabaseSync; boundary: string; synchronous: unknown; fullfsync: unknown }[],
)
vi.mock('node:sqlite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:sqlite')>()
  class TrackedDatabase extends actual.DatabaseSync {
    constructor(...args: ConstructorParameters<typeof actual.DatabaseSync>) {
      super(...args)
      opened.push(this)
    }
    override exec(sql: string): void {
      super.exec(sql)
      if (['BEGIN IMMEDIATE', 'COMMIT', 'ROLLBACK'].includes(sql))
        transactions.push({
          db: this,
          boundary: sql,
          synchronous: Object.values(this.prepare('PRAGMA synchronous').get() ?? {})[0],
          fullfsync: Object.values(this.prepare('PRAGMA fullfsync').get() ?? {})[0],
        })
    }
  }
  return { ...actual, DatabaseSync: TrackedDatabase }
})

describe('ledger checkpoint sync on the real platform', () => {
  it('uses native checkpoint sync and FULL/fullfsync for runtime commits, restoring Native defaults after success or failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-sqlite-durability-native-'))
    const storage = createSqliteStorage({ file: join(dir, 'sessions.db'), tablesDir: join(dir, 'tables') })
    try {
      const ledger = opened[0]
      expect(ledger).toBeDefined()
      const pragma = (name: string) => Object.values(ledger?.prepare(`PRAGMA ${name}`).get() ?? {})[0]
      expect(pragma('journal_mode')).toBe('wal')
      expect(pragma('checkpoint_fullfsync')).toBe(createPlatform().os === 'darwin' ? 1 : 0)
      expect(pragma('fullfsync')).toBe(0)
      expect(pragma('synchronous')).toBe(1)
      // A checkpoint through the ledger connection itself completes with the setting in force.
      expect(pragma('wal_checkpoint(TRUNCATE)')).toBe(0)
      await storage.open('durability', { writerRunId: 'writer', ttlMs: 60_000 })
      const observed = () =>
        transactions.filter((entry) => entry.db === ledger).map(({ db: _db, ...entry }) => entry)
      const normal = [
        { boundary: 'BEGIN IMMEDIATE', synchronous: 1, fullfsync: 0 },
        { boundary: 'COMMIT', synchronous: 1, fullfsync: 0 },
      ]
      transactions.length = 0
      await storage.commit('durability', {
        events: [ev('user/message', { content: [] })],
        expectedWriterRunId: 'writer',
      })
      expect(observed()).toEqual(normal)
      for (const type of ['runtime/record', 'runtime/cancel']) {
        const row = () =>
          ev(
            type,
            type === 'runtime/record'
              ? {
                  runtime: { id: 'jevloop', version: '1' },
                  record: {
                    version: 1,
                    id: 'record:1',
                    turn: 'turn:1',
                    kind: 'input.admitted',
                    input: {
                      id: 'input:1',
                      source: 'user',
                      content: [{ kind: 'text', text: 'durable input' }],
                    },
                  },
                }
              : {
                  runtime: { id: 'jevloop', version: '1' },
                  turnId: 'turn:1',
                  by: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
                },
          )
        transactions.length = 0
        await storage.commit('durability', { events: [row()], expectedWriterRunId: 'writer' })
        expect(observed()).toEqual([
          { boundary: 'BEGIN IMMEDIATE', synchronous: 2, fullfsync: 1 },
          { boundary: 'COMMIT', synchronous: 2, fullfsync: 1 },
        ])
        expect(pragma('synchronous')).toBe(1)
        expect(pragma('fullfsync')).toBe(0)
        const beforeFailure = await storage.scan('durability', { order: 'asc', limit: 16 })
        transactions.length = 0
        await expect(
          storage.commit('durability', { events: [row()], expectedWriterRunId: 'foreign-writer' }),
        ).rejects.toMatchObject({ code: 'E_WRITER_LEASE' })
        expect(observed()).toEqual([
          { boundary: 'BEGIN IMMEDIATE', synchronous: 2, fullfsync: 1 },
          { boundary: 'ROLLBACK', synchronous: 2, fullfsync: 1 },
        ])
        expect(await storage.scan('durability', { order: 'asc', limit: 16 })).toEqual(beforeFailure)
        expect(pragma('synchronous')).toBe(1)
        expect(pragma('fullfsync')).toBe(0)
        transactions.length = 0
        await storage.commit('durability', {
          events: [ev('user/message', { content: [] })],
          expectedWriterRunId: 'writer',
        })
        expect(observed()).toEqual(normal)
      }
    } finally {
      await storage.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
