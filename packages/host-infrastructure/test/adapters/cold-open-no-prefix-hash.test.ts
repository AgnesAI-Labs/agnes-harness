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
// Hashing the whole chain again is the explicit `verifyHistory({ rehashPrefix: true })`.

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
  it('with a checkpoint it reads each row once and nothing waits for a background rehash', async () => {
    const file = await built(5)
    const { storage, rows } = counting(sqlite(file))
    const rehashes: unknown[] = []
    const log = await SessionLogImpl.open(options(storage, 'r1', { onFullVerify: (r) => rehashes.push(r) }))
    expect(log.openStats.checkpoint).toEqual({ used: true, throughSeq: 50 })
    expect(log.historyVerified).toBe(true)
    // A model-side write is admitted at once: there is no execution gate to wait for.
    await expect(log.append([input('model-side write')])).resolves.toMatchObject({ firstSeq: 56 })
    await new Promise((r) => setTimeout(r, 20))
    // The open folds all 55 rows once; a rehash of the 50-row prefix would read them again.
    expect(rows()).toBe(55)
    expect(rehashes).toEqual([])
    await log.close()
  })

  it('a row changed before the checkpoint is accepted by a cold open and sealed by an explicit full verify', async () => {
    const file = await built()
    raw(file, TAMPER, 'k', 10)
    const storage = sqlite(file)
    const log = await SessionLogImpl.open(options(storage, 'r1'))
    expect(log.openStats.checkpoint).toEqual({ used: true, throughSeq: 50 })
    await log.fullVerified()
    expect(log.faulted).toBe(false)
    await expect(log.append([input('model-side write')])).resolves.toMatchObject({ firstSeq: 51 })
    // The write extended the chain from the stored head, so the full verify still fails at the changed row.
    await expect(log.verifyHistory({ rehashPrefix: true })).resolves.toBe(51)
    await expect(log.fullVerified()).rejects.toMatchObject({
      code: 'E_LEDGER_INTEGRITY',
      detail: { seq: 10 },
    })
    expect(log.faulted).toBe(true)
    await log.close()
  })

  it('a session without a checkpoint opens without a foreground full hash and without gating writes', async () => {
    const file = await built()
    raw(file, 'DELETE FROM ledger_verified_head_v1')
    // Row 10 is far before the last 32 rows, so only a full hash could notice it.
    raw(file, TAMPER, 'k', 10)
    const storage = sqlite(file)
    const pages: number[] = []
    const log = await SessionLogImpl.open(
      options(storage, 'r1', { replay: { page: (events) => pages.push(events.length) } }),
    )
    expect(log.openStats.checkpoint).toMatchObject({ used: false, reason: 'absent' })
    expect(pages.reduce((a, b) => a + b, 0)).toBe(50)
    expect(log.historyVerified).toBe(true)
    await expect(log.append([input('model-side write')])).resolves.toMatchObject({ firstSeq: 51 })
    await log.close()
    // The head it adopted is checkpointed for the next open.
    expect((await storage.readVerifiedHead('k'))?.throughSeq).toBe(51)
    const next = await SessionLogImpl.open(options(storage, 'r2'))
    expect(next.openStats.checkpoint).toEqual({ used: true, throughSeq: 51 })
    // Only the explicit full verify hashes the prefix again.
    await next.verifyHistory({ rehashPrefix: true })
    await expect(next.fullVerified()).rejects.toMatchObject({
      code: 'E_LEDGER_INTEGRITY',
      detail: { seq: 10 },
    })
    await next.close()
  })

  it('an explicit full verify without a usable checkpoint hashes from the first row', async () => {
    const file = await built()
    raw(file, 'DELETE FROM ledger_verified_head_v1')
    raw(file, TAMPER, 'k', 10)
    const storage = sqlite(file)
    const log = await SessionLogImpl.open(options(storage, 'r1'))
    expect(log.faulted).toBe(false)
    // The open checkpointed the head it adopted; with that gone nothing vouches for the prefix.
    for (let i = 0; i < 100 && !(await storage.readVerifiedHead('k')); i++)
      await new Promise((r) => setTimeout(r, 5))
    raw(file, 'DELETE FROM ledger_verified_head_v1')
    await expect(log.verifyHistory({ rehashPrefix: true })).rejects.toMatchObject({
      code: 'E_LEDGER_INTEGRITY',
      detail: { seq: 10 },
    })
    expect(log.faulted).toBe(true)
    await log.close()
  })

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
