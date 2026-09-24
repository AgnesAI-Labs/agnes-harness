import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type ResumeReport, reclaimExpired, tableReclaimStore } from '../src/lease/reclaim.js'
import { commandBinding } from '../src/local/command-binding.js'
import { PersistentCommandJournal } from '../src/storage/command-journal.js'
import { ensure } from '../src/storage/table.js'
import { sqliteTables } from './sqlite-tables.js'

const CLAIMS_DDL =
  'CREATE TABLE IF NOT EXISTS writer_claims (session_key TEXT PRIMARY KEY, run_id TEXT NOT NULL, until INTEGER NOT NULL, generation INTEGER NOT NULL)'
const REGISTERS_DDL =
  'CREATE TABLE IF NOT EXISTS registers (session_key TEXT, register TEXT, key TEXT, seq INTEGER, data TEXT, PRIMARY KEY (session_key, register, key))'

describe('daemon 0.1.0 local acceptance matrix', () => {
  it.each(['inference', 'tools'])(
    'resumes a persisted %s crash boundary and emits its last step',
    async (phase) => {
      const tables = sqliteTables()
      try {
        const claims = tables.table('writer_claims')
        const registers = tables.table('registers')
        ensure(claims, CLAIMS_DDL)
        ensure(registers, REGISTERS_DDL)
        claims.exec('INSERT INTO writer_claims VALUES (?, ?, ?, ?)', [`crashed-${phase}`, 'dead-run', 10, 3])
        registers.exec('INSERT INTO registers VALUES (?, ?, ?, ?, ?)', [
          `crashed-${phase}`,
          'op.state',
          'main',
          41,
          JSON.stringify({ step: 4, phase }),
        ])
        const resumed: string[] = []
        const notices: unknown[] = []
        const report: ResumeReport = {
          state: 'resumed',
          phase,
          actions: [{ effectId: `retry-${phase}`, action: 'retry' }],
        }
        await expect(
          reclaimExpired({
            store: tableReclaimStore(claims, registers),
            now: 11,
            openForResume: async (sessionKey) => {
              resumed.push(sessionKey)
              return { session: { resume: async () => report } }
            },
            notices: { emit: (kind, info) => notices.push({ kind, ...info }) },
          }),
        ).resolves.toEqual([{ sessionKey: `crashed-${phase}`, lastSeq: 41, resumed: true, lastStep: 4 }])
        expect(resumed).toEqual([`crashed-${phase}`])
        expect(notices).toEqual([
          {
            kind: 'resumed',
            sessionId: `crashed-${phase}`,
            detail: { lastStep: 4, pending: 1, phase },
          },
        ])
      } finally {
        await tables.close()
      }
    },
  )

  it('reopens durable submit state as replayed-or-uncertain, never as a fresh execution', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-acceptance-journal-'))
    const file = join(dir, 'daemon.db')
    const identity = (commandId: string) => ({
      principalId: 'local',
      clientId: 'stable-client',
      sessionId: 'agnes:local:default:cli:dm:acceptance',
      commandId,
    })
    const binding = commandBinding('followUp', identity('done').sessionId, 7, {
      content: [{ type: 'text', text: 'once' }],
    })
    try {
      const first = sqliteTables(file)
      const beforeDisconnect = new PersistentCommandJournal(first.table('command_journal'), () => 1)
      await beforeDisconnect.begin(identity('done'), binding)
      await beforeDisconnect.complete(identity('done'), { seq: 9 })
      await beforeDisconnect.begin(identity('uncertain'), binding)
      await first.close()

      const reopened = sqliteTables(file)
      try {
        const afterReconnect = new PersistentCommandJournal(reopened.table('command_journal'), () => 2)
        await expect(afterReconnect.begin(identity('done'), binding)).resolves.toEqual({
          state: 'complete',
          result: { seq: 9 },
        })
        await expect(afterReconnect.begin(identity('uncertain'), binding)).resolves.toEqual({
          state: 'uncertain',
        })
      } finally {
        await reopened.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
