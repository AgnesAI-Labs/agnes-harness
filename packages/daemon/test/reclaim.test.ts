import { describe, expect, it } from 'vitest'
import { type ResumeReport, reclaimExpired, tableReclaimStore } from '../src/lease/reclaim.js'
import { ensure } from '../src/storage/table.js'
import { sqliteTables } from './sqlite-tables.js'

const CLAIMS_DDL =
  'CREATE TABLE IF NOT EXISTS writer_claims (session_key TEXT PRIMARY KEY, run_id TEXT NOT NULL, until INTEGER NOT NULL, generation INTEGER NOT NULL)'
const REGISTERS_DDL =
  'CREATE TABLE IF NOT EXISTS registers (session_key TEXT, register TEXT, key TEXT, seq INTEGER, data TEXT, PRIMARY KEY (session_key, register, key))'

/** A fresh `{claims, registers}` pair sharing one connection, DDL already applied. */
function fixture() {
  const tables = sqliteTables()
  const claims = tables.table('writer_claims')
  const registers = tables.table('registers')
  ensure(claims, CLAIMS_DDL)
  ensure(registers, REGISTERS_DDL)
  return { tables, claims, registers, store: tableReclaimStore(claims, registers) }
}

describe('reclaimExpired', () => {
  it('releases idle sessions and resumes sessions with an open turn, leaving live claims alone', async () => {
    const { tables, claims, registers, store } = fixture()
    claims.exec('INSERT INTO writer_claims VALUES (?, ?, ?, ?)', ['idle', 'r1', 10, 1])
    claims.exec('INSERT INTO writer_claims VALUES (?, ?, ?, ?)', ['busy', 'r2', 10, 4])
    claims.exec('INSERT INTO writer_claims VALUES (?, ?, ?, ?)', ['live', 'r3', 99_999, 1])
    registers.exec('INSERT INTO registers VALUES (?, ?, ?, ?, ?)', [
      'busy',
      'op.state',
      'main',
      42,
      JSON.stringify({ step: 4 }),
    ])
    registers.exec('INSERT INTO registers VALUES (?, ?, ?, ?, ?)', ['idle', 'op.state', 'main', 9, 'null'])

    const notices: unknown[] = []
    const opened: string[] = []
    const report: ResumeReport = {
      state: 'resumed',
      phase: 'tools',
      actions: [{ effectId: 'e1', action: 'retry' }],
    }
    const out = await reclaimExpired({
      store,
      now: 100,
      openForResume: async (k) => {
        opened.push(k)
        return { session: { resume: async () => report } }
      },
      notices: { emit: (kind, info) => notices.push({ kind, ...info }) },
    })

    // 'idle' has no open turn: only released, openForResume never reached for it.
    // 'busy' has an open turn: resumed via openForResume -> resume().
    // 'live' has not expired at all: reclaimExpired never looks at it.
    expect(opened).toEqual(['busy'])
    expect(out).toEqual([
      { sessionKey: 'idle', lastSeq: 9, resumed: false },
      { sessionKey: 'busy', lastSeq: 42, resumed: true, lastStep: 4 },
    ])
    expect(notices).toEqual([
      { kind: 'resumed', sessionId: 'busy', detail: { lastStep: 4, pending: 1, phase: 'tools' } },
    ])
    expect(claims.get('SELECT run_id FROM writer_claims WHERE session_key = ?', ['idle'])).toBeUndefined()
    expect(claims.get('SELECT run_id FROM writer_claims WHERE session_key = ?', ['live'])).toBeDefined()
    await tables.close()
  })

  it('a session with a claim but no registers row at all is treated as idle (no open turn) and released', async () => {
    const { tables, claims, store } = fixture()
    claims.exec('INSERT INTO writer_claims VALUES (?, ?, ?, ?)', ['neverwrote', 'r1', 10, 1])
    const opened: string[] = []
    const out = await reclaimExpired({
      store,
      now: 100,
      openForResume: async (k) => {
        opened.push(k)
        return { session: { resume: async () => ({ state: 'resumed', actions: [] }) } }
      },
      notices: { emit: () => {} },
    })
    expect(opened).toEqual([])
    expect(out).toEqual([{ sessionKey: 'neverwrote', lastSeq: 0, resumed: false }])
    expect(
      claims.get('SELECT run_id FROM writer_claims WHERE session_key = ?', ['neverwrote']),
    ).toBeUndefined()
    await tables.close()
  })

  // Reverse-verification: the whole point of not releasing an open-turn claim first is that the new
  // worker's own open() is what supersedes the row (core bumps generation inside its own
  // transaction). If reclaimExpired released the claim before calling openForResume, this would be
  // observable as the row being gone by the time openForResume is even invoked.
  it('does not release the claim before resuming an open turn: the row is still there both during and after openForResume', async () => {
    const { tables, claims, registers, store } = fixture()
    claims.exec('INSERT INTO writer_claims VALUES (?, ?, ?, ?)', ['busy', 'r2', 10, 4])
    registers.exec('INSERT INTO registers VALUES (?, ?, ?, ?, ?)', [
      'busy',
      'op.state',
      'main',
      7,
      JSON.stringify({ step: 1 }),
    ])
    let rowSeenInsideOpenForResume: unknown
    await reclaimExpired({
      store,
      now: 100,
      openForResume: async (k) => {
        rowSeenInsideOpenForResume = claims.get('SELECT run_id FROM writer_claims WHERE session_key = ?', [k])
        return { session: { resume: async () => ({ state: 'resumed', actions: [] }) } }
      },
      notices: { emit: () => {} },
    })
    expect(rowSeenInsideOpenForResume).toEqual({ run_id: 'r2' })
    // Still there afterwards too: reclaimExpired itself never deletes an open-turn claim, in any
    // branch - only a real core `open()` (not exercised by this unit test) would overwrite it.
    expect(claims.get('SELECT run_id FROM writer_claims WHERE session_key = ?', ['busy'])).toEqual({
      run_id: 'r2',
    })
    await tables.close()
  })

  // Reverse-verification of the resume()-throws path: no notice, resumed:false, and - the part that
  // actually matters for a crash-continuation sweep - the failure of one session must not stop the
  // rest of the batch from being processed. 'ok' sorts after 'busy' by `until` (its deadline is
  // later), so it is only reached if the loop survives 'busy' throwing.
  it('resume() throwing is recorded as resumed:false with no notice, and does not stop the rest of the batch', async () => {
    const { tables, claims, registers, store } = fixture()
    claims.exec('INSERT INTO writer_claims VALUES (?, ?, ?, ?)', ['busy', 'r2', 10, 4])
    claims.exec('INSERT INTO writer_claims VALUES (?, ?, ?, ?)', ['ok', 'r3', 20, 1])
    registers.exec('INSERT INTO registers VALUES (?, ?, ?, ?, ?)', [
      'busy',
      'op.state',
      'main',
      7,
      JSON.stringify({ step: 1 }),
    ])
    registers.exec('INSERT INTO registers VALUES (?, ?, ?, ?, ?)', [
      'ok',
      'op.state',
      'main',
      3,
      JSON.stringify({ step: 2 }),
    ])
    const notices: unknown[] = []
    const opened: string[] = []
    const out = await reclaimExpired({
      store,
      now: 100,
      openForResume: async (k) => {
        opened.push(k)
        if (k === 'busy') throw new Error('worker did not come up')
        return { session: { resume: async () => ({ state: 'resumed', actions: [] }) } }
      },
      notices: { emit: (kind, info) => notices.push({ kind, ...info }) },
    })
    expect(opened).toEqual(['busy', 'ok'])
    expect(out).toEqual([
      { sessionKey: 'busy', lastSeq: 7, resumed: false },
      { sessionKey: 'ok', lastSeq: 3, resumed: true, lastStep: 2 },
    ])
    expect(notices).toEqual([{ kind: 'resumed', sessionId: 'ok', detail: { lastStep: 2, pending: 0 } }])
    // The claim is left exactly as it was - reclaimExpired neither releases it (open turn) nor
    // crashes the process; it is simply left for the next 30s pass to try again.
    expect(claims.get('SELECT run_id FROM writer_claims WHERE session_key = ?', ['busy'])).toEqual({
      run_id: 'r2',
    })
    await tables.close()
  })

  it('does not let an aborted late resume release, notify, or continue through the remaining batch', async () => {
    const { tables, claims, registers, store } = fixture()
    claims.exec('INSERT INTO writer_claims VALUES (?, ?, ?, ?)', ['busy', 'r1', 10, 1])
    claims.exec('INSERT INTO writer_claims VALUES (?, ?, ?, ?)', ['idle', 'r2', 20, 1])
    registers.exec('INSERT INTO registers VALUES (?, ?, ?, ?, ?)', [
      'busy',
      'op.state',
      'main',
      7,
      JSON.stringify({ step: 1 }),
    ])
    const controller = new AbortController()
    let rejectResume!: (error: Error) => void
    let markResumeStarted!: () => void
    const resumeStarted = new Promise<void>((resolve) => {
      markResumeStarted = resolve
    })
    const notices: unknown[] = []
    const reclaiming = reclaimExpired({
      store,
      now: 100,
      signal: controller.signal,
      openForResume: async () => ({
        session: {
          resume: () => {
            markResumeStarted()
            return new Promise<ResumeReport>((_resolve, reject) => {
              rejectResume = reject
            })
          },
        },
      }),
      notices: { emit: (kind, info) => notices.push({ kind, ...info }) },
    })

    await resumeStarted
    controller.abort(new Error('shutdown grace expired'))
    rejectResume(new Error('late worker rejection'))
    await expect(reclaiming).resolves.toEqual([])
    expect(notices).toEqual([])
    expect(claims.get('SELECT run_id FROM writer_claims WHERE session_key = ?', ['busy'])).toEqual({
      run_id: 'r1',
    })
    expect(claims.get('SELECT run_id FROM writer_claims WHERE session_key = ?', ['idle'])).toEqual({
      run_id: 'r2',
    })
    await tables.close()
  })

  it('leaves a claim alone that its writer took back between the listing and the reclaim', async () => {
    const { tables, claims, registers, store } = fixture()
    claims.exec('INSERT INTO writer_claims VALUES (?, ?, ?, ?)', ['woke', 'r1', 10, 1])
    claims.exec('INSERT INTO writer_claims VALUES (?, ?, ?, ?)', ['quiet', 'r2', 20, 1])
    // The writer claims again on its next write, and that write opened a turn.
    const racing = {
      ...store,
      listExpired: (now: number) => {
        const listed = store.listExpired(now)
        claims.exec('UPDATE writer_claims SET until = ? WHERE session_key = ?', [99_999, 'woke'])
        claims.exec('UPDATE writer_claims SET until = ? WHERE session_key = ?', [99_999, 'quiet'])
        registers.exec('INSERT INTO registers VALUES (?, ?, ?, ?, ?)', [
          'woke',
          'op.state',
          'main',
          5,
          JSON.stringify({ step: 1 }),
        ])
        return listed
      },
    }
    const opened: string[] = []
    const out = await reclaimExpired({
      store: racing,
      now: 100,
      openForResume: async (k) => {
        opened.push(k)
        return { session: { resume: async () => ({ state: 'resumed', actions: [] }) } }
      },
      notices: { emit: () => {} },
    })
    expect(opened).toEqual([])
    expect(out).toEqual([])
    expect(claims.get('SELECT until FROM writer_claims WHERE session_key = ?', ['woke'])).toEqual({
      until: 99_999,
    })
    expect(claims.get('SELECT until FROM writer_claims WHERE session_key = ?', ['quiet'])).toEqual({
      until: 99_999,
    })
    await tables.close()
  })

  it('treats an open turn on any lane as a turn to resume', async () => {
    const { tables, claims, registers, store } = fixture()
    claims.exec('INSERT INTO writer_claims VALUES (?, ?, ?, ?)', ['side', 'r1', 10, 1])
    registers.exec('INSERT INTO registers VALUES (?, ?, ?, ?, ?)', ['side', 'op.state', 'main', 4, 'null'])
    registers.exec('INSERT INTO registers VALUES (?, ?, ?, ?, ?)', [
      'side',
      'op.state',
      'lane-b',
      6,
      JSON.stringify({ step: 2 }),
    ])
    const opened: string[] = []
    await reclaimExpired({
      store,
      now: 100,
      openForResume: async (k) => {
        opened.push(k)
        return { session: { resume: async () => ({ state: 'resumed', actions: [] }) } }
      },
      notices: { emit: () => {} },
    })
    expect(opened).toEqual(['side'])
    await tables.close()
  })

  it('does not resume a session that is already open in this daemon', async () => {
    const { tables, claims, registers, store } = fixture()
    claims.exec('INSERT INTO writer_claims VALUES (?, ?, ?, ?)', ['live', 'r1', 10, 1])
    registers.exec('INSERT INTO registers VALUES (?, ?, ?, ?, ?)', [
      'live',
      'op.state',
      'main',
      3,
      JSON.stringify({ step: 1 }),
    ])
    const notices: unknown[] = []
    const out = await reclaimExpired({
      store,
      now: 100,
      openForResume: async () => null,
      notices: { emit: (kind, info) => notices.push({ kind, ...info }) },
    })
    expect(out).toEqual([])
    expect(notices).toEqual([])
    expect(claims.get('SELECT run_id FROM writer_claims WHERE session_key = ?', ['live'])).toEqual({
      run_id: 'r1',
    })
    await tables.close()
  })
})
