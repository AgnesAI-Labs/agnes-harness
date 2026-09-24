import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { commandBinding } from '../src/local/command-binding.js'
import { PersistentCommandJournal } from '../src/storage/command-journal.js'
import { sqliteTables } from './sqlite-tables.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const identity = (commandId = 'command-one') => ({
  principalId: 'local',
  clientId: 'cli-one',
  sessionId: 'agnes:local:test:cli:dm:one',
  commandId,
})

describe('PersistentCommandJournal', () => {
  it('atomically admits one concurrent caller and reports the other as uncertain', async () => {
    const tables = sqliteTables()
    try {
      const journal = new PersistentCommandJournal(tables.table('command_journal'), () => 10)
      const bound = commandBinding('followUp', identity().sessionId, 1, { content: ['same'] })
      const states = await Promise.all([journal.begin(identity(), bound), journal.begin(identity(), bound)])
      expect(states).toEqual([{ state: 'new' }, { state: 'uncertain' }])
    } finally {
      await tables.close()
    }
  })

  it('binds content and generation and replays the original receipt', async () => {
    const tables = sqliteTables()
    try {
      const journal = new PersistentCommandJournal(tables.table('command_journal'), () => 10)
      const original = commandBinding('steer', identity().sessionId, 1, { content: ['one'] })
      expect(await journal.begin(identity(), original)).toEqual({ state: 'new' })
      const stored = tables
        .table('command_journal')
        .get<Record<string, unknown>>('SELECT * FROM command_journal WHERE command_id = ?', [
          identity().commandId,
        ])
      expect(stored).not.toHaveProperty('payload')
      expect(stored).not.toHaveProperty('credential')
      expect(stored?.binding_digest).toBe(original.digest)
      await journal.complete(identity(), { seq: 17, result: { accepted: true } })
      expect(await journal.begin(identity(), original)).toEqual({
        state: 'complete',
        result: { seq: 17, result: { accepted: true } },
      })
      expect(
        await journal.begin(
          identity(),
          commandBinding('steer', identity().sessionId, 1, { content: ['different'] }),
        ),
      ).toEqual({ state: 'conflict' })
      expect(
        await journal.begin(
          identity(),
          commandBinding('steer', identity().sessionId, 2, { content: ['one'] }),
        ),
      ).toEqual({ state: 'conflict' })
    } finally {
      await tables.close()
    }
  })

  it('survives a database reopen and leaves an incomplete command uncertain', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-command-journal-'))
    dirs.push(dir)
    const file = join(dir, 'journal.db')
    const first = sqliteTables(file)
    const bound = commandBinding('followUp', identity().sessionId, undefined, { content: ['persist'] })
    const journal = new PersistentCommandJournal(first.table('command_journal'), () => 10)
    await journal.begin(identity('complete'), bound)
    await journal.complete(identity('complete'), { seq: 3 })
    await journal.begin(identity('incomplete'), bound)
    await first.close()

    const reopened = sqliteTables(file)
    try {
      const afterRestart = new PersistentCommandJournal(reopened.table('command_journal'), () => 20)
      expect(await afterRestart.begin(identity('complete'), bound)).toEqual({
        state: 'complete',
        result: { seq: 3 },
      })
      expect(await afterRestart.begin(identity('incomplete'), bound)).toEqual({ state: 'uncertain' })
    } finally {
      await reopened.close()
    }
  })

  it('only collects acknowledged receipts after the retention boundary', async () => {
    const now = 100
    const tables = sqliteTables()
    try {
      const journal = new PersistentCommandJournal(tables.table('command_journal'), () => now, 50)
      const bound = commandBinding('followUp', identity().sessionId, undefined, {})
      await journal.begin(identity('acked'), bound)
      await journal.complete(identity('acked'), { seq: 1 })
      expect(await journal.ack(identity('missing'))).toBe(false)
      expect(await journal.ack(identity('acked'))).toBe(true)
      expect(await journal.ack(identity('acked'))).toBe(true)
      expect(
        tables
          .table('command_journal')
          .all<{ name: string }>("PRAGMA index_list('command_journal')")
          .map((row) => row.name),
      ).toContain('command_journal_acked_at')
      await journal.begin(identity('unacked'), bound)
      await journal.complete(identity('unacked'), { seq: 2 })
      expect(await journal.gc(150)).toBe(0)
      expect(await journal.gc(151)).toBe(1)
      expect(await journal.begin(identity('unacked'), bound)).toEqual({
        state: 'complete',
        result: { seq: 2 },
      })
    } finally {
      await tables.close()
    }
  })

  it('fails closed when stored binding or receipt evidence is corrupt', async () => {
    const tables = sqliteTables()
    try {
      const table = tables.table('command_journal')
      const journal = new PersistentCommandJournal(table, () => 10)
      const bound = commandBinding('followUp', identity().sessionId, undefined, {})
      await journal.begin(identity('bad-binding'), bound)
      table.exec("UPDATE command_journal SET binding_digest = 'bad' WHERE command_id = 'bad-binding'")
      expect(await journal.begin(identity('bad-binding'), bound)).toEqual({ state: 'corrupt' })
      await journal.begin(identity('bad-result'), bound)
      table.exec("UPDATE command_journal SET result = '[]' WHERE command_id = 'bad-result'")
      expect(await journal.begin(identity('bad-result'), bound)).toEqual({ state: 'corrupt' })
    } finally {
      await tables.close()
    }
  })
})
