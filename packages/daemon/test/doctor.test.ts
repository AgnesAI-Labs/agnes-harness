import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensure } from '../src/storage/table.js'
import { daemonDoctor } from '../src/supervisor/doctor.js'
import { sqliteTables } from './sqlite-tables.js'

describe('daemonDoctor', () => {
  it('reports real lock/socket state plus lease and scheduler signals', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-doctor-'))
    const tables = sqliteTables()
    try {
      const claims = tables.table('writer_claims')
      ensure(
        claims,
        'CREATE TABLE IF NOT EXISTS writer_claims (session_key TEXT PRIMARY KEY, run_id TEXT, until INTEGER, generation INTEGER)',
      )
      claims.exec('INSERT INTO writer_claims VALUES (?, ?, ?, ?)', ['k', 'r', 1, 1])
      const registers = tables.table('registers')
      ensure(
        registers,
        'CREATE TABLE IF NOT EXISTS registers (session_key TEXT, register TEXT, key TEXT, seq INTEGER, data TEXT, PRIMARY KEY (session_key, register, key))',
      )
      registers.exec('INSERT INTO registers VALUES (?, ?, ?, ?, ?)', [
        'k',
        'op.state',
        'main',
        1,
        '{"step":1}',
      ])
      const report = await daemonDoctor({
        dataDir: dir,
        tables,
        clock: () => 1000,
        scheduler: {
          doctor: () => ({ stalledForever: ['job-one'], waitingDepth: [] }),
        },
      })
      expect(report.sections.map((section) => [section.name, section.status])).toEqual([
        ['lock', 'warn'],
        ['socket', 'warn'],
        ['leases', 'warn'],
        ['jobs', 'fail'],
      ])
    } finally {
      await tables.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('distinguishes a healthy lease table from queued job pressure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-doctor-waiting-'))
    const tables = sqliteTables()
    try {
      const claims = tables.table('writer_claims')
      ensure(
        claims,
        'CREATE TABLE IF NOT EXISTS writer_claims (session_key TEXT PRIMARY KEY, run_id TEXT, until INTEGER, generation INTEGER)',
      )
      ensure(
        tables.table('registers'),
        'CREATE TABLE IF NOT EXISTS registers (session_key TEXT, register TEXT, key TEXT, seq INTEGER, data TEXT, PRIMARY KEY (session_key, register, key))',
      )
      claims.exec('INSERT INTO writer_claims VALUES (?, ?, ?, ?)', ['live', 'r', 2000, 1])
      const report = await daemonDoctor({
        dataDir: dir,
        tables,
        clock: () => 1000,
        scheduler: {
          doctor: () => ({ stalledForever: [], waitingDepth: [{ sessionKey: 'busy', depth: 11 }] }),
        },
      })
      expect(report.sections.slice(2)).toEqual([
        { name: 'leases', status: 'ok', detail: { expired: 0 } },
        {
          name: 'jobs',
          status: 'warn',
          detail: { stalledForever: [], waitingDepth: [{ sessionKey: 'busy', depth: 11 }] },
        },
      ])
    } finally {
      await tables.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not warn about lapsed leases of sessions with no turn open', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-doctor-idle-'))
    const tables = sqliteTables()
    try {
      const claims = tables.table('writer_claims')
      ensure(
        claims,
        'CREATE TABLE IF NOT EXISTS writer_claims (session_key TEXT PRIMARY KEY, run_id TEXT, until INTEGER, generation INTEGER)',
      )
      const registers = tables.table('registers')
      ensure(
        registers,
        'CREATE TABLE IF NOT EXISTS registers (session_key TEXT, register TEXT, key TEXT, seq INTEGER, data TEXT, PRIMARY KEY (session_key, register, key))',
      )
      claims.exec('INSERT INTO writer_claims VALUES (?, ?, ?, ?)', ['idle', 'r', 1, 1])
      registers.exec('INSERT INTO registers VALUES (?, ?, ?, ?, ?)', ['idle', 'op.state', 'main', 1, 'null'])
      const report = await daemonDoctor({ dataDir: dir, tables, clock: () => 1000 })
      expect(report.sections.find((s) => s.name === 'leases')).toEqual({
        name: 'leases',
        status: 'ok',
        detail: { expired: 0 },
      })
    } finally {
      await tables.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
