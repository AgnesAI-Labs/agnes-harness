import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { defaultIds } from '@agnes/core-common/ids'
import { type OpenLogOptions, SessionLogImpl } from '@agnes/core-ledger/log/session-log'
import type { StorageAdapter } from '@agnes/core-ledger/log/storage'
import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteStorage, type SqliteStorage } from '../../src/adapters/storage-sqlite.js'

// A cold open folds the ledger and checks its structure and its tail; it does not hash the prefix.
// The prefix is hashed after open, without blocking ordinary work.

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
const open: StorageAdapter[] = []
afterEach(async () => {
  for (const s of open.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function sqlite(file: string): SqliteStorage {
  const s = createSqliteStorage({ file, clock: () => 1_000 })
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
  clock: () => 1_000,
  timers,
  ...extra,
})

/** A 50-row session whose checkpoint is at 50. `tail` more rows follow it, as after a killed process. */
async function built(tail = 0): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-cold-open-'))
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
  if (tail > 0) {
    const more = await SessionLogImpl.open(options(storage, 'r1'))
    for (let i = 0; i < tail; i++) await more.append([input(`tail${i}`)])
    // Killed: no close, so the checkpoint stays at 50.
    await storage.close()
  }
  return file
}

function raw(file: string, sql: string, ...params: Array<string | number | null>): void {
  const db = new DatabaseSync(file)
  try {
    db.prepare(sql).run(...params)
  } finally {
    db.close()
  }
}
const TAMPER = `UPDATE events SET data = json_set(data, '$.content[0].text', 'tampered') WHERE session_key = ? AND seq = ?`

/** Counts the rows every integrity scan returns. */
function counting(storage: StorageAdapter): { storage: StorageAdapter; rows: () => number } {
  let rows = 0
  const counted: StorageAdapter = Object.create(storage)
  counted.scanIntegrity = async (key, q) => {
    const page = await storage.scanIntegrity(key, q)
    rows += page.length
    return page
  }
  return { storage: counted, rows: () => rows }
}

describe('cold open does not hash the ledger prefix', () => {
  it('returns before background hashing and admits ordinary writes while sensitive evidence waits', async () => {
    const file = await built(5)
    const source = sqlite(file)
    let release!: () => void
    let reached!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      reached = resolve
    })
    const { storage } = counting(source)
    const scan = storage.scanIntegrity.bind(storage)
    let opening = true
    storage.scanIntegrity = async (key, q) => {
      if (!opening && q.fromSeq === 1) {
        reached()
        await gate
      }
      return scan(key, q)
    }
    const log = await SessionLogImpl.open(options(storage, 'r1'))
    opening = false
    expect(log.openStats.checkpoint).toEqual({ used: true, throughSeq: 50 })
    expect(log.historyVerified).toBe(false)
    await started
    await expect(log.append([input('model-side write')])).resolves.toMatchObject({ firstSeq: 56 })
    await expect(
      log.append([{ ...input('review'), type: 'x/approval/review', ignorable: true }], {
        beforeFullVerify: 'refuse',
      }),
    ).rejects.toMatchObject({ code: 'E_LANE_BUSY', message: expect.stringContaining('verifying history') })
    const approval = log.append([{ ...input('review'), type: 'x/approval/review', ignorable: true }])
    await Promise.resolve()
    expect(log.lastSeq).toBe(56)
    release()
    await approval
    expect(log.integrityStatus()).toMatchObject({ state: 'verified', verifiedThroughSeq: 57 })
    await log.close()
  })

  it('background verification finds a changed row before the checkpoint, seals, and retains evidence on reload', async () => {
    const file = await built()
    raw(file, TAMPER, 'k', 10)
    const storage = sqlite(file)
    const log = await SessionLogImpl.open(options(storage, 'r1'))
    expect(log.openStats.checkpoint).toEqual({ used: true, throughSeq: 50 })
    await expect(log.fullVerified()).rejects.toMatchObject({
      code: 'E_LEDGER_INTEGRITY',
      detail: { seq: 10 },
    })
    expect(log.integrityStatus()).toMatchObject({ state: 'failed', failureSeq: 10 })
    expect(await storage.readVerifiedHead('k')).toBeUndefined()
    await expect(log.append([input('after seal')])).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
    await log.close()
    await expect(SessionLogImpl.open(options(storage, 'r2'))).rejects.toMatchObject({
      code: 'E_LEDGER_INTEGRITY',
      detail: { seq: 10 },
    })
    const db = new DatabaseSync(file)
    expect(db.prepare('SELECT COUNT(*) AS n FROM events WHERE session_key = ?').get('k')).toEqual({ n: 50 })
    db.close()
  })

  it('never promotes an unverified prefix to a checkpoint, including on close', async () => {
    const file = await built()
    raw(file, 'DELETE FROM ledger_verified_head_v1')
    const source = sqlite(file)
    let release!: () => void
    let reached!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      reached = resolve
    })
    const storage: StorageAdapter = Object.create(source)
    let opening = true
    storage.scanIntegrity = async (key, q) => {
      if (!opening && q.fromSeq === 1) {
        reached()
        await gate
      }
      return source.scanIntegrity(key, q)
    }
    const log = await SessionLogImpl.open(options(storage, 'r1'))
    opening = false
    await started
    await log.append([input('ordinary')])
    expect(await source.readVerifiedHead('k')).toBeUndefined()
    const closing = log.close()
    release()
    await closing
    expect(await source.readVerifiedHead('k')).toBeUndefined()
    const next = await SessionLogImpl.open(options(source, 'r2'))
    await next.fullVerified()
    expect((await source.readVerifiedHead('k'))?.throughSeq).toBe(51)
    await next.close()
  })

  it.each(['before', 'during'] as const)(
    'a fresh audit finds bytes changed %s an earlier scan',
    async (when) => {
      const file = await built()
      const source = sqlite(file)
      let hold = false
      let release!: () => void
      let reached!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const paused = new Promise<void>((resolve) => {
        reached = resolve
      })
      const storage: StorageAdapter = Object.create(source)
      storage.scanIntegrity = async (key, q) => {
        if (hold && q.fromSeq > 10 && q.limit <= 32) {
          reached()
          await gate
        }
        return source.scanIntegrity(key, q)
      }
      const log = await SessionLogImpl.open(options(storage, 'r1'))
      await log.fullVerified()
      let first: ReturnType<typeof log.auditHistory> | undefined
      if (when === 'during') {
        hold = true
        first = log.auditHistory()
        await paused
      }
      raw(file, TAMPER, 'k', 10)
      const audit = expect(log.auditHistory()).rejects.toMatchObject({
        code: 'E_LEDGER_INTEGRITY',
        detail: { seq: 10 },
      })
      hold = false
      release()
      if (first) await expect(first).resolves.toMatchObject({ state: 'verified' })
      await audit
      expect(log.integrityStatus()).toMatchObject({ state: 'failed', failureSeq: 10 })
      await log.close()
    },
  )

  it.each(['checkpoint', 'no checkpoint'] as const)(
    'a sequence gap still fails a cold open (%s)',
    async (mode) => {
      const file = await built()
      if (mode === 'no checkpoint') raw(file, 'DELETE FROM ledger_verified_head_v1')
      raw(file, 'DELETE FROM events WHERE session_key = ? AND seq = ?', 'k', 7)
      await expect(
        SessionLogImpl.open(options(sqlite(file), 'r1', { replay: { page: () => undefined } })),
      ).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
    },
  )

  it('a changed row in the tail after the checkpoint still fails a cold open', async () => {
    const file = await built(5)
    raw(file, TAMPER, 'k', 53)
    await expect(SessionLogImpl.open(options(sqlite(file), 'r1'))).rejects.toMatchObject({
      code: 'E_LEDGER_INTEGRITY',
      detail: { seq: 53 },
    })
  })

  it('without a checkpoint the last 32 rows are still checked', async () => {
    const file = await built()
    raw(file, 'DELETE FROM ledger_verified_head_v1')
    raw(file, TAMPER, 'k', 45)
    await expect(
      SessionLogImpl.open(options(sqlite(file), 'r1', { replay: { page: () => undefined } })),
    ).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY', detail: { seq: 45 } })
  })
})
