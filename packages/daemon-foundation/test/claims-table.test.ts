import { afterEach, describe, expect, it, vi } from 'vitest'
import { NonceTable, startClaimsGc, TableClaims } from '../src/storage/claims-table.js'
import { sqliteTables } from './sqlite-tables.js'

describe('TableClaims', () => {
  afterEach(() => vi.useRealTimers())
  it('persists single-use claims across instances and frees them exactly at expiry', async () => {
    const tables = sqliteTables()
    const first = new TableClaims(tables.table('auth_claims'))

    expect(await first.once('source:p1:event', 'm1', 2_000, 1_000)).toBe(true)

    const restarted = new TableClaims(tables.table('auth_claims'))
    expect(await restarted.once('source:p1:event', 'm1', 3_000, 1_999)).toBe(false)
    expect(await restarted.once('source:p1:event', 'm1', 9_000, 2_000)).toBe(true)

    // The server-derived bucket remains part of the identity. Equal values in different claim
    // kinds or principals must not consume one another's grant.
    expect(await restarted.once('source:p1:other', 'm1', 9_000, 2_000)).toBe(true)
    expect(await restarted.once('source:p2:event', 'm1', 9_000, 2_000)).toBe(true)
    await tables.close()
  })

  it('persists a sliding rate window and removes only expired rows during gc', async () => {
    const tables = sqliteTables()
    const claims = new TableClaims(tables.table('auth_claims'))

    expect(await claims.withinRateLimit('source:p1:send', 'u1', 2, 1_000, 3_000)).toEqual({
      granted: true,
      slot: 1,
    })
    const restarted = new TableClaims(tables.table('auth_claims'))
    expect(await restarted.withinRateLimit('source:p1:send', 'u1', 2, 1_000, 3_100)).toEqual({
      granted: true,
      slot: 2,
    })
    expect(await restarted.withinRateLimit('source:p1:send', 'u1', 2, 1_000, 3_200)).toEqual({
      granted: false,
      slot: 2,
    })
    expect(await restarted.withinRateLimit('source:p1:send', 'u1', 2, 1_000, 4_100)).toEqual({
      granted: true,
      slot: 1,
    })

    expect(await restarted.once('source:p1:event', 'old', 5_000, 4_000)).toBe(true)
    expect(await restarted.once('source:p1:event', 'live', 5_001, 4_000)).toBe(true)
    expect(restarted.gc(5_000)).toBe(3) // two old rate hits plus the once row expiring now
    expect(await restarted.once('source:p1:event', 'old', 9_000, 5_000)).toBe(true)
    expect(await restarted.once('source:p1:event', 'live', 9_000, 5_000)).toBe(false)
    await tables.close()
  })

  it('sweeps at startup and periodically, then stops sweeping after supervisor shutdown', () => {
    vi.useFakeTimers()
    let now = 1_000
    const gc = vi.fn()
    const stop = startClaimsGc({ gc }, () => now, 100)
    expect(gc).toHaveBeenCalledWith(1_000)
    now = 1_100
    vi.advanceTimersByTime(100)
    expect(gc).toHaveBeenLastCalledWith(1_100)
    stop()
    stop()
    now = 1_200
    vi.advanceTimersByTime(500)
    expect(gc).toHaveBeenCalledTimes(2)
  })
})

describe('NonceTable', () => {
  it('persists replay refusal per client and accepts the nonce after the window', async () => {
    const tables = sqliteTables()
    const first = new NonceTable(tables.table('auth_nonces'))

    expect(first.consume('c1', 'abc', 10_000)).toBe(true)
    const restarted = new NonceTable(tables.table('auth_nonces'))
    expect(restarted.consume('c1', 'abc', 20_000)).toBe(false)
    expect(restarted.consume('c2', 'abc', 20_000)).toBe(true)
    expect(restarted.consume('c1', 'abc', 310_000)).toBe(false)
    expect(restarted.consume('c1', 'abc', 310_001)).toBe(true)
    await tables.close()
  })
})
