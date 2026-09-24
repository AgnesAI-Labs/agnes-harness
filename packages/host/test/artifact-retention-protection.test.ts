import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { DDL } from '../src/adapters/ddl.js'
import {
  catchUpArtifactRefIndex,
  openArtifactRefIndex,
  readIndexedActivity,
  verifyRootsUnderLedgerLock,
} from '../src/artifact-ref-index.js'
import {
  planRetentionProtection,
  readLastReferencedAt,
  recomputeRetentionProtectionLocked,
} from '../src/artifact-retention-protection.js'

const temporary: string[] = []
const open: DatabaseSync[] = []
afterEach(async () => {
  for (const database of open.splice(0)) if (database.isOpen) database.close()
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const digest = (n: number) => n.toString(16).padStart(2, '0').repeat(32)
const T0 = Date.UTC(2026, 8, 24)
const neverAborted = new AbortController().signal

async function ledgerFixture() {
  const dataDir = resolve(await mkdtemp(join(tmpdir(), 'agnes-retention-protection-')))
  temporary.push(dataDir)
  const file = join(dataDir, 'sessions.db')
  const writer = new DatabaseSync(file)
  open.push(writer)
  writer.exec('PRAGMA journal_mode = WAL')
  for (const ddl of DDL) writer.exec(ddl)
  const insert = writer.prepare(
    `INSERT INTO events (session_key, seq, ts, id, type, lane, actor, origin, trust, data, integrity_digest)
     VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)`,
  )
  /** A row whose event time is `T0 + seconds` (defaults to its seq). */
  const row = (key: string, seq: number, value: { seconds?: number; ts?: string } = {}) =>
    insert.run(
      key,
      seq,
      value.ts ?? new Date(T0 + (value.seconds ?? seq) * 1000).toISOString(),
      `${key}-${seq}`,
      'user/message',
      new TextEncoder().encode('main'),
      'user',
      'trusted',
      '{}',
      `d-${key}-${seq}`,
    )
  const shot = (key: string, seq: number, digests: readonly string[], seconds = seq) =>
    insert.run(
      key,
      seq,
      new Date(T0 + seconds * 1000).toISOString(),
      `${key}-${seq}`,
      'tool/result',
      new TextEncoder().encode('main'),
      'tool:computer_use',
      'untrusted',
      JSON.stringify({
        isError: false,
        content: digests.map((sha) => ({
          type: 'resource_link',
          uri: `artifact://${sha}`,
          mimeType: 'image/png',
          name: 'screenshot',
        })),
      }),
      `d-${key}-${seq}`,
    )
  const fork = (child: string, parent: string, boundarySeq: number) =>
    writer
      .prepare(
        "INSERT INTO sessions (session_key, parent_key, boundary_seq, created_at) VALUES (?, ?, ?, '')",
      )
      .run(child, parent, boundarySeq)
  const openOp = (key: string, until: number, data = '{"op":"open"}') => {
    writer
      .prepare(
        "INSERT INTO registers (session_key, register, key, seq, data) VALUES (?, 'op.state', ?, 1, ?)",
      )
      .run(key, new TextEncoder().encode('main'), data)
    writer
      .prepare(
        "INSERT INTO writer_claims (session_key, run_id, until, ttl_ms) VALUES (?, 'run', ?, 30000) ON CONFLICT (session_key) DO UPDATE SET until = excluded.until",
      )
      .run(key, until)
  }
  const refs = async () => {
    const ledger = new DatabaseSync(file, { readOnly: true })
    open.push(ledger)
    const index = await openArtifactRefIndex(dataDir)
    open.push(index)
    await catchUpArtifactRefIndex({ ledger, index, signal: neverAborted })
    return { ledger, index }
  }
  return { file, writer, row, shot, fork, openOp, refs }
}

async function plan(
  fixture: Awaited<ReturnType<typeof ledgerFixture>>,
  candidates: ReadonlySet<string>,
  settings: { nowMs: number; ttlMs?: number; maxRecent: number },
) {
  const { ledger, index } = await fixture.refs()
  return planRetentionProtection({
    ledger,
    index,
    activity: await readIndexedActivity(index),
    candidates,
    settings: { ttlMs: 60_000, ...settings },
  })
}

const all = (count: number) => new Set(Array.from({ length: count }, (_, i) => digest(i + 1)))

describe('Computer Use screenshot retention protection', () => {
  it('protects the newest three image rows whole even when the per-session count is one', async () => {
    const fixture = await ledgerFixture()
    for (let seq = 1; seq <= 5; seq += 1)
      fixture.shot('a', seq, seq === 3 ? [digest(3), digest(6)] : [digest(seq)])
    const protection = await plan(fixture, all(6), { nowMs: T0 + 10_000, maxRecent: 1 })
    expect(protection.digests).toEqual(new Set([digest(3), digest(4), digest(5), digest(6)]))
  })

  it('tops the newest rows up to the per-session count by latest image seq, among candidates only', async () => {
    const fixture = await ledgerFixture()
    for (let seq = 1; seq <= 6; seq += 1) fixture.shot('a', seq, [digest(seq)])
    // digest 1 appears again as the newest row, so its latest seq wins.
    fixture.shot('a', 7, [digest(1)])
    const candidates = new Set([digest(1), digest(2), digest(3), digest(4), digest(5)])
    const protection = await plan(fixture, candidates, { nowMs: T0 + 10_000, maxRecent: 4 })
    expect(protection.digests).toEqual(new Set([digest(1), digest(5), digest(4), digest(3)]))
  })

  it('counts a session active only while its newest event is inside the TTL (strictly)', async () => {
    const fixture = await ledgerFixture()
    fixture.shot('a', 1, [digest(1)], 5)
    const edge = T0 + 5_000 + 60_000
    expect((await plan(fixture, all(1), { nowMs: edge, maxRecent: 1 })).digests.size).toBe(0)
    expect((await plan(fixture, all(1), { nowMs: edge - 1, maxRecent: 1 })).digests).toEqual(all(1))
  })

  it('treats an unparseable newest event time as long ago', async () => {
    const fixture = await ledgerFixture()
    fixture.shot('a', 1, [digest(1)], 5)
    fixture.row('a', 2, { ts: 'not a time' })
    expect((await plan(fixture, all(1), { nowMs: T0 + 6_000, maxRecent: 1 })).digests.size).toBe(0)
  })

  it('counts an open op with a live writer lease as active, read from the registers alone', async () => {
    const fixture = await ledgerFixture()
    fixture.shot('a', 1, [digest(1)])
    const nowMs = T0 + 3_600_000
    fixture.openOp('a', nowMs + 1)
    expect((await plan(fixture, all(1), { nowMs, maxRecent: 1 })).digests).toEqual(all(1))
  })

  it('reclaims a crash leftover: an open op whose lease expired and whose events are old', async () => {
    const fixture = await ledgerFixture()
    fixture.shot('a', 1, [digest(1)])
    const nowMs = T0 + 3_600_000
    fixture.openOp('a', nowMs)
    expect((await plan(fixture, all(1), { nowMs, maxRecent: 1 })).digests.size).toBe(0)
  })

  it('does not count a closed op as active even under a live lease', async () => {
    const fixture = await ledgerFixture()
    fixture.shot('a', 1, [digest(1)])
    const nowMs = T0 + 3_600_000
    fixture.openOp('a', nowMs + 60_000, 'null')
    expect((await plan(fixture, all(1), { nowMs, maxRecent: 1 })).digests.size).toBe(0)
  })

  it("protects an ancestor's screenshots as the child sees them, not by their newest occurrence", async () => {
    const fixture = await ledgerFixture()
    for (let seq = 1; seq <= 90; seq += 1)
      if (seq === 10 || seq === 80) fixture.shot('p', seq, [digest(1)])
      else if (seq === 20) fixture.shot('p', seq, [digest(2)])
      else if (seq === 30) fixture.shot('p', seq, [digest(3)])
      else if (seq === 90) fixture.shot('p', seq, [digest(4)])
      else fixture.row('p', seq)
    fixture.fork('c', 'p', 50)
    for (let seq = 51; seq <= 60; seq += 1) fixture.row('c', seq, { seconds: 200 + seq })
    const protection = await plan(fixture, all(4), { nowMs: T0 + 270_000, maxRecent: 1 })
    expect(protection.digests).toEqual(new Set([digest(1), digest(2), digest(3)]))
  })

  it('bounds every ancestor by the smallest fork point along the chain', async () => {
    const fixture = await ledgerFixture()
    const images = new Map([
      [10, 1],
      [20, 2],
      [25, 3],
      [40, 4],
      [45, 5],
    ])
    for (let seq = 1; seq <= 50; seq += 1) {
      const image = images.get(seq)
      if (image) fixture.shot('g', seq, [digest(image)])
      else fixture.row('g', seq)
    }
    fixture.fork('p', 'g', 50)
    for (let seq = 51; seq <= 55; seq += 1) fixture.row('p', seq)
    fixture.fork('c', 'p', 30)
    for (let seq = 31; seq <= 35; seq += 1) fixture.row('c', seq, { seconds: 300 + seq })
    const protection = await plan(fixture, all(5), { nowMs: T0 + 340_000, maxRecent: 1 })
    expect(protection.digests).toEqual(new Set([digest(1), digest(2), digest(3)]))
  })

  it('reuses planned ancestors under the lock and gives up when a fork boundary row changed', async () => {
    const fixture = await ledgerFixture()
    for (let seq = 1; seq <= 5; seq += 1) fixture.shot('p', seq, [digest(seq)])
    // Rows past the fork point keep the boundary row off the index anchor, so only the ancestor
    // check can notice it changing.
    for (let seq = 6; seq <= 7; seq += 1) fixture.row('p', seq)
    fixture.fork('c', 'p', 5)
    fixture.row('c', 6, { seconds: 100 })
    const settings = { nowMs: T0 + 120_000, ttlMs: 60_000, maxRecent: 1 }
    const { ledger, index } = await fixture.refs()
    const planned = await planRetentionProtection({
      ledger,
      index,
      activity: await readIndexedActivity(index),
      candidates: all(5),
      settings,
    })
    expect(planned.digests).toEqual(new Set([digest(3), digest(4), digest(5)]))
    const locked = new DatabaseSync(fixture.file)
    open.push(locked)
    const recompute = async () => {
      locked.exec('BEGIN IMMEDIATE')
      try {
        const verified = await verifyRootsUnderLedgerLock({ ledger: locked, index, candidates: all(5) })
        if (!verified) throw new Error('declined')
        return await recomputeRetentionProtectionLocked({
          ledger: locked,
          index,
          activity: verified.activity,
          candidates: all(5),
          settings,
          planned,
        })
      } finally {
        locked.exec('ROLLBACK')
      }
    }
    expect((await recompute())?.digests).toEqual(planned.digests)
    fixture.writer.prepare("UPDATE events SET id = 'rewritten' WHERE session_key = 'p' AND seq = 5").run()
    await expect(recompute()).resolves.toBeUndefined()
  })

  it('reads the newest reference time of each candidate across sessions', async () => {
    const fixture = await ledgerFixture()
    fixture.shot('a', 1, [digest(1)], 10)
    fixture.shot('b', 1, [digest(1)], 30)
    fixture.shot('b', 2, [digest(2)], 20)
    const { index } = await fixture.refs()
    await expect(readLastReferencedAt(index, all(3))).resolves.toEqual(
      new Map([
        [digest(1), T0 + 30_000],
        [digest(2), T0 + 20_000],
      ]),
    )
  })
})
