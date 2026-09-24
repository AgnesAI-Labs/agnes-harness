import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  defaultIds,
  type Event,
  type FoldCacheRecord,
  foldEvents,
  openTracked,
  SessionLogImpl,
} from '@agnes/core'
import { encodeFoldCache, OP_CELL_CASES } from '@agnes/core/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteStorage } from '../../src/adapters/storage-sqlite.js'

const dirs: string[] = []
const opened: Array<{ close(): Promise<void> }> = []
afterEach(async () => {
  for (const storage of opened.splice(0)) await storage.close().catch(() => undefined)
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const make = () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-op-cell-'))
  dirs.push(dir)
  const storage = createSqliteStorage({ file: join(dir, 'sessions.db'), tablesDir: join(dir, 'tables') })
  opened.push(storage)
  return storage
}

// The same cases the in-memory reference passes, against the durable adapter.
describe('the program counter as a register cell (SQLite)', () => {
  for (const [name, run] of Object.entries(OP_CELL_CASES)) it(name, () => run(make))
})

const clock = () => 1_757_203_200_000
const noTimers = { setTimeout: () => 0, clearTimeout: () => undefined }
const fixture = fileURLToPath(
  new URL('../../../core/fixtures/crash/05-checkpoint-need_assistant', import.meta.url),
)

/** A ledger as the build before the switch wrote it, stored with a fold cache stamped `version`. */
async function oldLedger(storage: ReturnType<typeof make>, version = 2): Promise<Event[]> {
  const rows = readFileSync(`${fixture}.jsonl`, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Event)
  const [cell] = JSON.parse(readFileSync(`${fixture}.op.json`, 'utf8')) as Array<{ data: unknown }>
  const last = rows.at(-1) as Event
  rows.push({ ...last, seq: last.seq + 1, type: 'op.state', register: 'op.state', data: cell?.data } as Event)
  const state = foldEvents(rows.filter((row) => row.type !== 'op.state'))
  const head = rows.length
  const cache = encodeFoldCache(
    'k',
    { ...state, lastSeq: head },
    { lastSeq: head, legacyThroughSeq: head, headDigest: null },
  )
  await storage.open('k', { writerRunId: 'old', ttlMs: 60_000 })
  await storage.commit('k', {
    events: rows.map(({ seq: _seq, ...row }) => row),
    expectedWriterRunId: 'old',
    foldCache: { ...cache, version } as unknown as FoldCacheRecord,
  })
  await storage.release('k', 'old')
  return rows
}

describe('a SQLite ledger with the removed op.state row type', () => {
  const open = (storage: ReturnType<typeof make>, writerRunId: string) =>
    openTracked({
      storage,
      key: 'k',
      writerRunId,
      ttlMs: 60_000,
      ids: defaultIds(clock),
      clock,
      timers: noTimers,
    })
  const starts = async (storage: ReturnType<typeof make>) => {
    const seen: unknown[] = []
    const log = await SessionLogImpl.open({
      storage,
      key: 'k',
      writerRunId: 'probe',
      ttlMs: 60_000,
      ids: defaultIds(clock),
      clock,
      timers: noTimers,
      replay: { start: (fold) => seen.push(fold), page: () => undefined },
    })
    await log.close()
    return seen
  }

  it('fails to open, and hands the lease straight back', async () => {
    const storage = make()
    await oldLedger(storage)
    await expect(open(storage, 'r1')).rejects.toThrow('E_UNKNOWN_EVENT')
    await expect(open(storage, 'r2')).rejects.toThrow('E_UNKNOWN_EVENT')
  })

  it('refuses the fold cache that build wrote, so the replay starts from the first row', async () => {
    const old = make()
    await oldLedger(old, 2)
    expect(await starts(old)).toEqual([undefined])
    // The current version is accepted, which is what makes the refusal above the version's doing.
    const current = make()
    const rows = await oldLedger(current, 3)
    expect(await starts(current)).toEqual([expect.objectContaining({ seq: rows.length })])
    await expect(open(current, 'r1')).rejects.toThrow('E_UNKNOWN_EVENT')
  })
})
