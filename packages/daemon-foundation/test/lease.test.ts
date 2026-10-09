import { describe, expect, it } from 'vitest'
import { generationOf, listExpired, readClaim, releaseClaim } from '../src/lease/lease.js'
import { ensure } from '../src/storage/table.js'
import { sqliteTables } from './sqlite-tables.js'

const DDL =
  'CREATE TABLE IF NOT EXISTS writer_claims (session_key TEXT PRIMARY KEY, run_id TEXT NOT NULL, until INTEGER NOT NULL, generation INTEGER NOT NULL)'

describe('writer_claims read/reclaim', () => {
  it('reads generation, lists expired, releases only the matching run', () => {
    const t = sqliteTables().table('writer_claims')
    ensure(t, DDL)
    t.exec('INSERT INTO writer_claims VALUES (?, ?, ?, ?)', ['k1', 'r1', 100, 3])
    t.exec('INSERT INTO writer_claims VALUES (?, ?, ?, ?)', ['k2', 'r2', 500, 1])

    expect(readClaim(t, 'k1')).toEqual({ runId: 'r1', until: 100, generation: 3 })
    expect(generationOf(t, 'k1')).toBe(3)
    expect(generationOf(t, 'nope')).toBe(0)
    expect(listExpired(t, 200).map((c) => c.sessionKey)).toEqual(['k1'])

    expect(releaseClaim(t, 'k1', 'other')).toBe(false)
    expect(releaseClaim(t, 'k1', 'r1')).toBe(true)
    expect(readClaim(t, 'k1')).toBeUndefined()
  })

  // Reverse-verification of releaseClaim's core guarantee: it deletes a row only when the caller's
  // run_id still matches the row that is there. The positive half (original holder releases, row
  // gone) is covered above via k1/r1. This covers the half that actually protects another writer:
  // a stale run_id must not be able to delete a claim a newer writer has since taken over.
  describe('releaseClaim protects a claim a newer writer has taken over', () => {
    it('original holder releases: succeeds, row gone', () => {
      const t = sqliteTables().table('writer_claims')
      ensure(t, DDL)
      t.exec('INSERT INTO writer_claims VALUES (?, ?, ?, ?)', ['k9', 'r9', 100, 1])

      expect(releaseClaim(t, 'k9', 'r9')).toBe(true)
      expect(readClaim(t, 'k9')).toBeUndefined()
    })

    it('stale holder releases after a newer writer took over: fails, new claim untouched', () => {
      const t = sqliteTables().table('writer_claims')
      ensure(t, DDL)
      // r1 held k1 at generation 1.
      t.exec('INSERT INTO writer_claims VALUES (?, ?, ?, ?)', ['k1', 'r1', 100, 1])
      // r1's lease expired and a new writer, r2, took the session over (a bumped generation, a fresh
      // deadline). This package never grants claims itself, so the takeover is simulated directly
      // with the same UPDATE core would issue.
      t.exec('UPDATE writer_claims SET run_id = ?, until = ?, generation = ? WHERE session_key = ?', [
        'r2',
        900,
        2,
        'k1',
      ])

      // r1 does not yet know its lease was reclaimed and tries to release with its own, now-stale,
      // run_id. The call must fail and must not delete r2's row.
      expect(releaseClaim(t, 'k1', 'r1')).toBe(false)
      expect(readClaim(t, 'k1')).toEqual({ runId: 'r2', until: 900, generation: 2 })

      // r2 can release its own claim normally.
      expect(releaseClaim(t, 'k1', 'r2')).toBe(true)
      expect(readClaim(t, 'k1')).toBeUndefined()
    })
  })
})
