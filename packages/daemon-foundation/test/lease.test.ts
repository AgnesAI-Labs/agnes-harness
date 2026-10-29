import { describe, expect, it } from 'vitest'
import { generationOf, listExpired, readClaim } from '../src/lease/lease.js'
import { ensure } from '../src/storage/table.js'
import { sqliteTables } from './sqlite-tables.js'

const DDL =
  'CREATE TABLE IF NOT EXISTS writer_claims (session_key TEXT PRIMARY KEY, run_id TEXT NOT NULL, until INTEGER NOT NULL, generation INTEGER NOT NULL)'

describe('writer_claims read/reclaim', () => {
  it('reads generation and lists expired claims', () => {
    const t = sqliteTables().table('writer_claims')
    ensure(t, DDL)
    t.exec('INSERT INTO writer_claims VALUES (?, ?, ?, ?)', ['k1', 'r1', 100, 3])
    t.exec('INSERT INTO writer_claims VALUES (?, ?, ?, ?)', ['k2', 'r2', 500, 1])

    expect(readClaim(t, 'k1')).toEqual({ runId: 'r1', until: 100, generation: 3 })
    expect(generationOf(t, 'k1')).toBe(3)
    expect(generationOf(t, 'nope')).toBe(0)
    expect(listExpired(t, 200).map((c) => c.sessionKey)).toEqual(['k1'])
  })
})
