import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  defaultIds,
  type FullVerifyReport,
  makeVerifiedHead,
  type OpenLogOptions,
  prepareIntegrity,
  SessionLogImpl,
  type StorageAdapter,
} from '@agnes/core'
import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteStorage, type SqliteStorage } from '../../src/adapters/storage-sqlite.js'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const timers = { setTimeout: () => 0, clearTimeout: () => undefined }
const input = (text: string) => ({
  actor,
  origin: 'principal' as const,
  trust: 'trusted' as const,
  type: 'user/message',
  data: { content: [{ type: 'text', text }] },
})
const turnEnd = () => ({
  ...input('end'),
  type: 'turn/end',
  data: { reason: 'completed', lastAssistantSeq: null },
})
const opener = {
  actor,
  agnesVersion: '0.0.1',
  preset: 'standard',
  resolvedProfileHash: null,
  writerRunId: 'child-run',
  lane: 'main',
}

const dirs: string[] = []
const open: SqliteStorage[] = []
afterEach(async () => {
  for (const s of open.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

let now = 1_000
function sqlite(file: string): SqliteStorage {
  const s = createSqliteStorage({ file, clock: () => now })
  open.push(s)
  return s
}

const options = (
  storage: StorageAdapter,
  writerRunId: string,
  extra: Partial<OpenLogOptions> = {},
): OpenLogOptions => ({
  storage,
  key: 'k',
  writerRunId,
  ttlMs: 60_000,
  ids: defaultIds(),
  clock: () => now,
  timers,
  ...extra,
})

/** A 50-row session whose verified head is at 50, on a file this test owns. */
async function built(): Promise<string> {
  now = 1_000
  const dir = mkdtempSync(join(tmpdir(), 'agnes-verified-head-'))
  dirs.push(dir)
  const file = join(dir, 'sessions.db')
  const storage = sqlite(file)
  const writer = await SessionLogImpl.open(options(storage, 'w0'))
  for (let i = 0; i < 50; i++) await writer.append([input(`m${i}`)])
  await writer.close()
  const verifier = await SessionLogImpl.open(options(storage, 'w1'))
  await verifier.fullVerified()
  await verifier.close()
  expect((await storage.readVerifiedHead('k'))?.throughSeq).toBe(50)
  return file
}

/** Edits the file directly, the way another process with the file open would. */
function raw(file: string, sql: string, ...params: Array<string | number | null>): void {
  const db = new DatabaseSync(file)
  try {
    db.prepare(sql).run(...params)
  } finally {
    db.close()
  }
}
function rowCount(file: string, table: string, key = 'k'): number {
  const db = new DatabaseSync(file)
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_key = ?`).get(key) as { n: number })
      .n
  } finally {
    db.close()
  }
}
const TAMPER = `UPDATE events SET data = json_set(data, '$.content[0].text', 'tampered') WHERE session_key = ? AND seq = ?`

describe('verified-head checkpoint against a tampered SQLite ledger', () => {
  it('a row changed before the checkpoint: opens from it, then the background verify seals the session and drops it', async () => {
    const file = await built()
    raw(file, TAMPER, 'k', 10)
    const storage = sqlite(file)
    const log = await SessionLogImpl.open(options(storage, 'r1'))
    expect(log.openStats.checkpoint).toEqual({ used: true, throughSeq: 50 })
    expect(log.historyVerified).toBe(false)
    // Issued while the verification is still running: held, then refused, and nothing lands.
    const held = log.append([input('model-side write')])
    await expect(log.fullVerified()).rejects.toMatchObject({
      code: 'E_LEDGER_INTEGRITY',
      detail: { seq: 10 },
    })
    await expect(held).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
    await expect(log.append([input('after')], { beforeFullVerify: 'allow' })).rejects.toMatchObject({
      code: 'E_LEDGER_INTEGRITY',
    })
    expect(log.faulted).toBe(true)
    expect(rowCount(file, 'events')).toBe(50)
    expect(rowCount(file, 'ledger_verified_head_v1')).toBe(0)
    await log.close()
    expect(rowCount(file, 'ledger_verified_head_v1')).toBe(0)
    await expect(SessionLogImpl.open(options(storage, 'r2'))).rejects.toMatchObject({
      code: 'E_LEDGER_INTEGRITY',
    })
  })

  it('a row changed after the checkpoint: the unverified tail is hashed at open, which fails', async () => {
    const file = await built()
    const storage = sqlite(file)
    const writer = await SessionLogImpl.open(options(storage, 'w2'))
    await writer.fullVerified()
    for (let i = 0; i < 5; i++) await writer.append([input(`tail${i}`)])
    // Killed: no close, so the checkpoint stays at 50.
    await storage.close()
    expect(rowCount(file, 'events')).toBe(55)
    raw(file, TAMPER, 'k', 53)
    const again = sqlite(file)
    expect((await again.readVerifiedHead('k'))?.throughSeq).toBe(50)
    await expect(SessionLogImpl.open(options(again, 'w2'))).rejects.toMatchObject({
      code: 'E_LEDGER_INTEGRITY',
      detail: { seq: 53 },
    })
  })

  it('a checkpoint whose own digest is wrong is not used; the full verify passes and writes a good one', async () => {
    const file = await built()
    raw(file, `UPDATE ledger_verified_head_v1 SET checkpoint_digest = ?`, '0'.repeat(64))
    const storage = sqlite(file)
    const log = await SessionLogImpl.open(options(storage, 'r1'))
    expect(log.openStats.checkpoint).toEqual({ used: false, reason: 'self-check' })
    await log.fullVerified()
    await log.close()
    const next = await SessionLogImpl.open(options(storage, 'r2'))
    expect(next.openStats.checkpoint).toEqual({ used: true, throughSeq: 50 })
    await next.fullVerified()
    await next.close()
  })

  it('a self-consistent checkpoint naming the wrong digest is not used', async () => {
    const file = await built()
    const storage = sqlite(file)
    const head = (await storage.readVerifiedHead('k'))!
    await storage.writeVerifiedHead(makeVerifiedHead({ ...head, headDigest: 'a'.repeat(64) }), {
      force: true,
    })
    const log = await SessionLogImpl.open(options(storage, 'r1'))
    expect(log.openStats.checkpoint).toEqual({ used: false, reason: 'row-mismatch' })
    await log.fullVerified()
    await log.close()
    expect((await storage.readVerifiedHead('k'))?.headDigest).toBe(head.headDigest)
  })

  it('a deleted row fails the open exactly as it does without a checkpoint', async () => {
    const file = await built()
    raw(file, 'DELETE FROM events WHERE session_key = ? AND seq = ?', 'k', 7)
    const storage = sqlite(file)
    await expect(SessionLogImpl.open(options(storage, 'r1'))).rejects.toMatchObject({
      code: 'E_LEDGER_INTEGRITY',
    })
    raw(file, 'DELETE FROM ledger_verified_head_v1')
    await expect(SessionLogImpl.open(options(storage, 'r2'))).rejects.toMatchObject({
      code: 'E_LEDGER_INTEGRITY',
    })
  })

  it('rows removed from the end leave the checkpoint past the head: not used, the rest verifies as before', async () => {
    const file = await built()
    raw(file, 'DELETE FROM events WHERE session_key = ? AND seq > ?', 'k', 45)
    const storage = sqlite(file)
    const log = await SessionLogImpl.open(options(storage, 'r1'))
    expect(log.openStats.checkpoint).toEqual({ used: false, reason: 'beyond-head' })
    expect(log.lastSeq).toBe(45)
    await log.fullVerified()
    await log.close()
    // Replaced by the verified head that matches the rows there are.
    expect((await storage.readVerifiedHead('k'))?.throughSeq).toBe(45)
  })

  it('a self-consistent checkpoint ahead of the ledger is not used', async () => {
    const file = await built()
    const storage = sqlite(file)
    const head = (await storage.readVerifiedHead('k'))!
    await storage.writeVerifiedHead(makeVerifiedHead({ ...head, throughSeq: 55 }), { force: true })
    const log = await SessionLogImpl.open(options(storage, 'r1'))
    expect(log.openStats.checkpoint).toEqual({ used: false, reason: 'beyond-head' })
    await log.fullVerified()
    await log.close()
  })

  it("a fork child's checkpoint does not hide a changed parent prefix from the child's background verify", async () => {
    const file = await built()
    const storage = sqlite(file)
    const parent = await SessionLogImpl.open(options(storage, 'p1'))
    await parent.fullVerified()
    const child = await parent.forkInto(30, 'child', opener)
    expect(child.lastSeq).toBeGreaterThan(30)
    await child.close()
    await parent.close()
    expect((await storage.readVerifiedHead('child'))?.throughSeq).toBe(child.lastSeq)
    raw(file, TAMPER, 'k', 12)
    const reopened = await SessionLogImpl.open({ ...options(storage, 'c2'), key: 'child' })
    expect(reopened.openStats.checkpoint).toEqual({ used: true, throughSeq: child.lastSeq })
    await expect(reopened.fullVerified()).rejects.toMatchObject({
      code: 'E_LEDGER_INTEGRITY',
      detail: { seq: 12 },
    })
    await reopened.close()
    expect(await storage.readVerifiedHead('child')).toBeUndefined()
    await expect(SessionLogImpl.open({ ...options(storage, 'c3'), key: 'child' })).rejects.toMatchObject({
      code: 'E_LEDGER_INTEGRITY',
    })
  })

  it('a kill right after a checkpoint write leaves it at or before the head, and it is used', async () => {
    const file = await built()
    const storage = sqlite(file)
    const log = await SessionLogImpl.open(options(storage, 'w3'))
    await log.fullVerified()
    await log.append([input('q')])
    await log.append([turnEnd() as never])
    await new Promise((r) => setTimeout(r, 0))
    await log.append([input('after the turn, never checkpointed')])
    // Killed: the file is closed under the open log.
    await storage.close()
    const again = sqlite(file)
    const head = (await again.readVerifiedHead('k'))!
    expect(head.throughSeq).toBe(52)
    const reopened = await SessionLogImpl.open(options(again, 'w3'))
    expect(reopened.lastSeq).toBe(53)
    expect(reopened.openStats.checkpoint).toEqual({ used: true, throughSeq: 52 })
    await reopened.fullVerified()
    await reopened.close()
  })

  it('a replaced row digest with a checkpoint rewritten to match is caught by the chain', async () => {
    const file = await built()
    const storage = sqlite(file)
    const head = (await storage.readVerifiedHead('k'))!
    const forged = 'b'.repeat(64)
    raw(file, 'UPDATE events SET integrity_digest = ? WHERE session_key = ? AND seq = ?', forged, 'k', 50)
    await storage.writeVerifiedHead(makeVerifiedHead({ ...head, headDigest: forged }), { force: true })
    // At the head: the checkpoint is used and the background verify finds the row.
    const log = await SessionLogImpl.open(options(storage, 'r1'))
    expect(log.openStats.checkpoint).toEqual({ used: true, throughSeq: 50 })
    await expect(log.fullVerified()).rejects.toMatchObject({
      code: 'E_LEDGER_INTEGRITY',
      detail: { seq: 50 },
    })
    await log.close()
  })

  it('a replaced row digest below rows written after it fails the open at the next row', async () => {
    const file = await built()
    const storage = sqlite(file)
    const writer = await SessionLogImpl.open(options(storage, 'w4'))
    await writer.fullVerified()
    await writer.append([input('51')])
    await storage.close()
    const forged = 'c'.repeat(64)
    raw(file, 'UPDATE events SET integrity_digest = ? WHERE session_key = ? AND seq = ?', forged, 'k', 50)
    const again = sqlite(file)
    const head = (await again.readVerifiedHead('k'))!
    await again.writeVerifiedHead(makeVerifiedHead({ ...head, headDigest: forged }), { force: true })
    await expect(SessionLogImpl.open(options(again, 'w4'))).rejects.toMatchObject({
      code: 'E_LEDGER_INTEGRITY',
      detail: { seq: 51 },
    })
  })

  it('a changed row whose own digest was recomputed is caught where the chain continues', async () => {
    const file = await built()
    const storage = sqlite(file)
    const [nine] = await storage.scanIntegrity('k', { fromSeq: 9, toSeq: 9, limit: 1 })
    const [ten] = await storage.scanIntegrity('k', { fromSeq: 10, toSeq: 10, limit: 1 })
    const changed = { ...ten!.event, data: { content: [{ type: 'text', text: 'tampered' }] } }
    const recomputed = prepareIntegrity('k', [changed], {
      lastSeq: 9,
      legacyThroughSeq: 0,
      headDigest: nine!.integrity!.digest,
    }).entries[0]!.digest
    raw(file, TAMPER, 'k', 10)
    raw(file, 'UPDATE events SET integrity_digest = ? WHERE session_key = ? AND seq = ?', recomputed, 'k', 10)
    const log = await SessionLogImpl.open(options(storage, 'r1'))
    expect(log.openStats.checkpoint).toEqual({ used: true, throughSeq: 50 })
    await expect(log.fullVerified()).rejects.toMatchObject({
      code: 'E_LEDGER_INTEGRITY',
      detail: { seq: 11 },
    })
    await log.close()
  })

  it('two writers on one file never move the checkpoint back', async () => {
    const file = await built()
    const first = sqlite(file)
    const second = sqlite(file)
    const a = await SessionLogImpl.open({ ...options(first, 'a'), ttlMs: 1_000 })
    await a.fullVerified()
    await expect(SessionLogImpl.open({ ...options(second, 'b'), ttlMs: 1_000 })).rejects.toMatchObject({
      code: 'E_WRITER_LEASE',
    })
    // The first writer's lease lapses and the second takes the session over.
    now += 5_000
    const b = await SessionLogImpl.open({ ...options(second, 'b'), ttlMs: 1_000 })
    await b.fullVerified()
    for (let i = 0; i < 3; i++) await b.append([input(`b${i}`)])
    await b.close()
    expect((await first.readVerifiedHead('k'))?.throughSeq).toBe(53)
    await expect(a.append([input('stale writer')])).rejects.toMatchObject({ code: 'E_WRITER_LEASE' })
    await a.close()
    expect((await first.readVerifiedHead('k'))?.throughSeq).toBe(53)
    // The SQL itself keeps the furthest of two racing writes.
    const head = (await first.readVerifiedHead('k'))!
    await second.writeVerifiedHead(makeVerifiedHead({ ...head, throughSeq: 50 }))
    expect((await first.readVerifiedHead('k'))?.throughSeq).toBe(53)
  })

  it('a failure found after user input was let through: only that input lands, the rest is refused', async () => {
    const file = await built()
    raw(file, TAMPER, 'k', 10)
    const storage = sqlite(file)
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    let folded = false
    const held: StorageAdapter = Object.create(storage)
    held.scanIntegrity = async (key, q) => {
      if (q.fromSeq === 1 && folded) await gate
      folded = true
      return storage.scanIntegrity(key, q)
    }
    const reports: FullVerifyReport[] = []
    const faults: string[] = []
    const log = await SessionLogImpl.open(options(held, 'r1', { onFullVerify: (r) => reports.push(r) }))
    log.onFault((e) => faults.push(e.code))
    await expect(log.append([input('typed')], { beforeFullVerify: 'allow' })).resolves.toMatchObject({
      firstSeq: 51,
    })
    const waiting = log.append([input('model-side')])
    release()
    await expect(waiting).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
    expect(rowCount(file, 'events')).toBe(51)
    expect(rowCount(file, 'ledger_verified_head_v1')).toBe(0)
    expect(faults).toEqual(['E_LEDGER_INTEGRITY'])
    expect(reports).toEqual([expect.objectContaining({ outcome: 'failed', seq: 10 })])
    await log.close()
    expect(rowCount(file, 'ledger_verified_head_v1')).toBe(0)
  })

  it('a session closed before its verify finished writes no checkpoint and refuses the writes it held', async () => {
    const file = await built()
    const storage = sqlite(file)
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    let folded = false
    const held: StorageAdapter = Object.create(storage)
    held.scanIntegrity = async (key, q) => {
      if (q.fromSeq === 1 && folded) await gate
      folded = true
      return storage.scanIntegrity(key, q)
    }
    const log = await SessionLogImpl.open(options(held, 'r1'))
    await log.append([input('typed')], { beforeFullVerify: 'allow' })
    const waiting = log.append([input('model-side')])
    const closing = log.close()
    release()
    await closing
    await expect(waiting).rejects.toMatchObject({ code: 'E_CLOSED' })
    await expect(log.fullVerified()).rejects.toMatchObject({ code: 'E_CLOSED' })
    expect(rowCount(file, 'events')).toBe(51)
    expect((await storage.readVerifiedHead('k'))?.throughSeq).toBe(50)
  })
})
