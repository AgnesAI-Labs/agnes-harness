import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  decideCheckpoint,
  defaultIds,
  LEDGER_INTEGRITY_ALGORITHM,
  makeVerifiedHead,
  type OpenLogOptions,
  SessionLogImpl,
  type VerifiedHead,
} from '@agnes/core'
import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteStorage, DDL, type SqliteStorage } from '../../src/adapters/storage-sqlite.js'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const timers = { setTimeout: () => 0, clearTimeout: () => undefined }
const input = (text: string) => ({
  actor,
  origin: 'principal' as const,
  trust: 'trusted' as const,
  type: 'user/message',
  data: { content: [{ type: 'text', text }] },
})

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
const options = (storage: SqliteStorage, key: string, writerRunId: string): OpenLogOptions => ({
  storage,
  key,
  writerRunId,
  ttlMs: 60_000,
  ids: defaultIds(),
  clock: () => now,
  timers,
})

/** The checkpoint a full verification of `key` through `seq` would leave. */
async function headAt(storage: SqliteStorage, key: string, seq: number): Promise<VerifiedHead> {
  const [row] = await storage.scanIntegrity(key, { fromSeq: seq, toSeq: seq, limit: 1 })
  return makeVerifiedHead({
    sessionKey: key,
    throughSeq: seq,
    headDigest: row?.integrity?.digest as string,
    legacyThroughSeq: 0,
    algorithm: LEDGER_INTEGRITY_ALGORITHM,
    verifiedFullAtMs: 5,
    writtenAtMs: 6,
  })
}

/** A 12-row session 'k' on a file this test owns, with a checkpoint at its head. */
async function built(): Promise<{ file: string; storage: SqliteStorage; head: VerifiedHead }> {
  now = 1_000
  const dir = mkdtempSync(join(tmpdir(), 'agnes-verified-head-sqlite-'))
  dirs.push(dir)
  const file = join(dir, 'sessions.db')
  const storage = sqlite(file)
  const writer = await SessionLogImpl.open(options(storage, 'k', 'w0'))
  for (let i = 0; i < 12; i++) await writer.append([input(`m${i}`)])
  await writer.close()
  const head = await headAt(storage, 'k', 12)
  await storage.writeVerifiedHead(head)
  return { file, storage, head }
}

/** Runs SQL on the file directly, the way another process with the file open would. */
function raw<T>(file: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file)
  try {
    return fn(db)
  } finally {
    db.close()
  }
}
const count = (file: string, table: string, key: string): number =>
  raw(
    file,
    (db) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_key = ?`).get(key) as { n: number }).n,
  )

describe('ledger_verified_head_v1', () => {
  it('is created with the other core tables, again on every open, and keeps its rows', async () => {
    const { file, storage, head } = await built()
    expect(DDL.some((ddl) => ddl.includes('ledger_verified_head_v1'))).toBe(true)
    expect(storage.coreTableNames()).toContain('ledger_verified_head_v1')
    await storage.close()
    const again = sqlite(file)
    expect(await again.readVerifiedHead('k')).toEqual(head)
    // A database that predates the table gets it on open, without touching its ledger.
    await again.close()
    raw(file, (db) => db.exec('DROP TABLE ledger_verified_head_v1'))
    const upgraded = sqlite(file)
    expect(upgraded.coreTableNames()).toContain('ledger_verified_head_v1')
    expect(await upgraded.readVerifiedHead('k')).toBeUndefined()
    expect((await upgraded.open('k', { writerRunId: 'w1', ttlMs: 1000 })).lastSeq).toBe(12)
  })

  it('round-trips every field of a head', async () => {
    const { storage, head } = await built()
    const read = await storage.readVerifiedHead('k')
    expect(read).toEqual(head)
    expect(Object.keys(read as VerifiedHead).sort()).toEqual(Object.keys(head).sort())
    expect(await storage.readVerifiedHead('nobody')).toBeUndefined()
  })

  it('keeps one head per session and the furthest one a writer was given', async () => {
    const { storage, head } = await built()
    await storage.writeVerifiedHead({ ...head, throughSeq: 7 })
    expect((await storage.readVerifiedHead('k'))?.throughSeq).toBe(12)
    await storage.writeVerifiedHead({ ...head, throughSeq: 7, writtenAtMs: 77 }, { force: true })
    expect(await storage.readVerifiedHead('k')).toMatchObject({ throughSeq: 7, writtenAtMs: 77 })
    // Equal positions replace, so a re-verification can refresh the stored copy.
    await storage.writeVerifiedHead({ ...head, throughSeq: 7, writtenAtMs: 88 })
    expect((await storage.readVerifiedHead('k'))?.writtenAtMs).toBe(88)
    await storage.deleteVerifiedHead('k')
    expect(await storage.readVerifiedHead('k')).toBeUndefined()
  })

  it('never moves back when two connections to one file write', async () => {
    const { file, storage, head } = await built()
    const other = sqlite(file)
    await other.writeVerifiedHead({ ...head, throughSeq: 3 })
    await storage.writeVerifiedHead({ ...head, throughSeq: 5 })
    expect((await other.readVerifiedHead('k'))?.throughSeq).toBe(12)
    expect((await storage.readVerifiedHead('k'))?.throughSeq).toBe(12)
  })

  it('is removed with its session when a new session is discarded, and only then', async () => {
    const { file, storage, head } = await built()
    await storage.open('fresh', { writerRunId: 'r', ttlMs: 1000 })
    await storage.writeVerifiedHead({ ...head, sessionKey: 'fresh', throughSeq: 1 })
    expect(count(file, 'ledger_verified_head_v1', 'fresh')).toBe(1)
    await storage.discardNewSession('fresh', 'r')
    expect(count(file, 'ledger_verified_head_v1', 'fresh')).toBe(0)
    expect(count(file, 'sessions', 'fresh')).toBe(0)
    expect(count(file, 'ledger_verified_head_v1', 'k')).toBe(1)
  })
})

describe('decideCheckpoint against SQLite', () => {
  it('uses the checkpoint a full verification left', async () => {
    const { storage, head } = await built()
    expect(await decideCheckpoint(storage, 'k', 12)).toEqual({ use: true, head })
  })

  it('refuses a stored row whose own digest was edited', async () => {
    const { file, storage, head } = await built()
    raw(file, (db) =>
      db.prepare('UPDATE ledger_verified_head_v1 SET checkpoint_digest = ?').run('0'.repeat(64)),
    )
    expect(await decideCheckpoint(storage, 'k', 12)).toEqual({ use: false, reason: 'self-check' })
    await storage.writeVerifiedHead(head, { force: true })
    expect(await decideCheckpoint(storage, 'k', 12)).toMatchObject({ use: true })
    raw(file, (db) => db.prepare('UPDATE ledger_verified_head_v1 SET verified_full_at_ms = 99').run())
    expect(await decideCheckpoint(storage, 'k', 12)).toEqual({ use: false, reason: 'self-check' })
  })

  it('refuses a self-consistent checkpoint naming a digest the row does not carry', async () => {
    const { storage, head } = await built()
    await storage.writeVerifiedHead(makeVerifiedHead({ ...head, headDigest: 'a'.repeat(64) }), {
      force: true,
    })
    expect(await decideCheckpoint(storage, 'k', 12)).toEqual({ use: false, reason: 'row-mismatch' })
  })

  it('refuses a stored row whose digest was replaced after the checkpoint was taken', async () => {
    const { file, storage } = await built()
    raw(file, (db) =>
      db
        .prepare('UPDATE events SET integrity_digest = ? WHERE session_key = ? AND seq = ?')
        .run('b'.repeat(64), 'k', 12),
    )
    expect(await decideCheckpoint(storage, 'k', 12)).toEqual({ use: false, reason: 'row-mismatch' })
  })

  it('refuses a checkpoint past the head after rows were removed from the end', async () => {
    const { file, storage } = await built()
    raw(file, (db) => db.prepare('DELETE FROM events WHERE session_key = ? AND seq > ?').run('k', 9))
    expect(await decideCheckpoint(storage, 'k', 9)).toEqual({ use: false, reason: 'beyond-head' })
  })

  it('refuses a checkpoint under another ledger algorithm', async () => {
    const { file, storage } = await built()
    raw(file, (db) => db.prepare('UPDATE ledger_verified_head_v1 SET algorithm = ?').run('other'))
    expect(await decideCheckpoint(storage, 'k', 12)).toEqual({ use: false, reason: 'algorithm' })
  })

  it("never accepts another session's checkpoint copied under this key", async () => {
    const { file, storage } = await built()
    const twin = await SessionLogImpl.open(options(storage, 'twin', 'w1'))
    for (let i = 0; i < 12; i++) await twin.append([input(`m${i}`)])
    await twin.close()
    await storage.writeVerifiedHead(await headAt(storage, 'twin', 12))
    expect(await decideCheckpoint(storage, 'twin', 12)).toMatchObject({ use: true })
    // Moved to the other key by hand: the stored columns say 'twin', and the digest binds that.
    raw(file, (db) => {
      db.prepare('DELETE FROM ledger_verified_head_v1 WHERE session_key = ?').run('k')
      db.prepare('UPDATE ledger_verified_head_v1 SET session_key = ? WHERE session_key = ?').run('k', 'twin')
    })
    expect(await decideCheckpoint(storage, 'k', 12)).toEqual({ use: false, reason: 'self-check' })
    expect(await decideCheckpoint(storage, 'twin', 12)).toEqual({ use: false, reason: 'absent' })
  })
})

describe('integrityDigestAt against SQLite', () => {
  it('reads a stored digest, and says whether the row is absent or a legacy row', async () => {
    const { file, storage, head } = await built()
    expect(await storage.integrityDigestAt('k', 12)).toBe(head.headDigest)
    expect(await storage.integrityDigestAt('k', 13)).toBeUndefined()
    expect(await storage.integrityDigestAt('nobody', 1)).toBeUndefined()
    raw(file, (db) => db.prepare('UPDATE events SET integrity_digest = NULL WHERE seq = 4').run())
    expect(await storage.integrityDigestAt('k', 4)).toBeNull()
  })

  it("reads a child's inherited prefix from its parent, up to the boundary, through several levels", async () => {
    const { storage } = await built()
    const parentDigest = (seq: number) => storage.integrityDigestAt('k', seq)
    await storage.createChild('k', 8, 'child')
    expect(await storage.integrityDigestAt('child', 5)).toBe(await parentDigest(5))
    expect(await storage.integrityDigestAt('child', 8)).toBe(await parentDigest(8))
    expect(await storage.integrityDigestAt('child', 9)).toBeUndefined()
    await storage.createChild('child', 6, 'grandchild')
    expect(await storage.integrityDigestAt('grandchild', 6)).toBe(await parentDigest(6))
    expect(await storage.integrityDigestAt('grandchild', 7)).toBeUndefined()
    // A child checkpoint on its inherited prefix is accepted, and only that far.
    await storage.writeVerifiedHead({ ...(await headAt(storage, 'k', 6)), sessionKey: 'grandchild' })
    expect(await decideCheckpoint(storage, 'grandchild', 6)).toEqual({ use: false, reason: 'self-check' })
    await storage.writeVerifiedHead(
      makeVerifiedHead({ ...(await headAt(storage, 'k', 6)), sessionKey: 'grandchild' }),
      { force: true },
    )
    expect(await decideCheckpoint(storage, 'grandchild', 6)).toMatchObject({ use: true })
  })
})

describe('the checkpoint beside the append watermark', () => {
  it('advances after full verification or close, never an unverified append, and does not set the watermark', async () => {
    const { file, storage } = await built()
    const before = (await storage.readVerifiedHead('k')) as VerifiedHead
    const log = await SessionLogImpl.open(options(storage, 'k', 'w1'))
    await log.append([input('later')])
    // The append moved the ledger on; the checkpoint stays where the last full verification left it.
    expect((await storage.readVerifiedHead('k'))?.throughSeq).toBe(before.throughSeq)
    await log.fullVerified()
    await log.close()
    expect((await storage.readVerifiedHead('k'))?.throughSeq).toBe(before.throughSeq + 1)
    // A checkpoint for a session the ledger has never seen leaves no watermark or session behind.
    await storage.writeVerifiedHead({ ...(before as VerifiedHead), sessionKey: 'ghost' })
    expect(count(file, 'sessions', 'ghost')).toBe(0)
  })

  it('does not stand in for the watermark: a removed tail still fails the open', async () => {
    const { file, storage } = await built()
    await storage.close()
    raw(file, (db) => db.prepare('DELETE FROM events WHERE session_key = ? AND seq = ?').run('k', 12))
    const reopened = sqlite(file)
    // The checkpoint still names row 12, which is now gone; the watermark refuses the open first.
    expect((await reopened.readVerifiedHead('k'))?.throughSeq).toBe(12)
    await expect(reopened.open('k', { writerRunId: 'w1', ttlMs: 1000 })).rejects.toMatchObject({
      code: 'E_LEDGER_INTEGRITY',
    })
  })

  it('does not hide a removed watermark: a protected session without one still fails the open', async () => {
    const { file, storage } = await built()
    await storage.close()
    raw(file, (db) =>
      db.prepare('UPDATE sessions SET head_seq = NULL, head_digest = NULL WHERE session_key = ?').run('k'),
    )
    const reopened = sqlite(file)
    expect(await reopened.readVerifiedHead('k')).toBeDefined()
    await expect(reopened.open('k', { writerRunId: 'w1', ttlMs: 1000 })).rejects.toMatchObject({
      code: 'E_LEDGER_INTEGRITY',
    })
  })

  it('is not needed to open: losing it changes nothing about the ledger', async () => {
    const { file, storage } = await built()
    await storage.deleteVerifiedHead('k')
    await storage.close()
    const reopened = sqlite(file)
    const log = await SessionLogImpl.open(options(reopened, 'k', 'w1'))
    expect(log.lastSeq).toBe(12)
    await log.close()
  })
})
