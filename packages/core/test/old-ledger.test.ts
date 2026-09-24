import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { defaultIds } from '../src/ids.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { SessionLogImpl } from '../src/log/session-log.js'
import type { FoldCacheRecord } from '../src/log/storage.js'
import { decodeFoldCache, encodeFoldCache } from '../src/project/cache.js'
import { foldEvents } from '../src/reduce/reducer.js'
import { openTracked } from '../src/reduce/tracker.js'
import type { Event } from '../src/types.js'
import { noTimers } from './helpers/open-session.js'

/**
 * A ledger written before streamed text left the ledger holds `assistant/chunk` rows. That type no
 * longer exists, so such a ledger must fail to open rather than be folded around a row nobody
 * understands - whether or not a fold cache would let the tracker skip past it.
 */

const fixture = fileURLToPath(new URL('../fixtures/crash/04-checkpoint-may_finish.jsonl', import.meta.url))
const clock = () => 1_757_203_200_000

/** The fixture with its output marker turned back into the chunk row an older build wrote there. */
function oldLedger(): Event[] {
  const rows = readFileSync(fixture, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Event)
  const at = rows.findIndex((row) => row.type === 'assistant/output')
  const output = rows[at]
  if (!output) throw new Error('fixture has no output row to turn back into a chunk')
  const effectId = (output.data as { effectId: string }).effectId
  rows[at] = { ...output, type: 'assistant/chunk', data: { kind: 'text', delta: 'hello', effectId } }
  return rows
}

const open = (storage: MemoryStorage, writerRunId = 'r') =>
  openTracked({
    storage,
    key: 'k',
    writerRunId,
    ttlMs: 60_000,
    ids: defaultIds(clock),
    clock,
    timers: noTimers,
  })

describe('a ledger with the removed assistant/chunk type', () => {
  it('fails to open', async () => {
    await expect(open(MemoryStorage.fromEvents('k', oldLedger()))).rejects.toThrow('E_UNKNOWN_EVENT')
  })

  it('fails to open even with a fold cache written past the chunk row', async () => {
    const rows = oldLedger()
    const storage = MemoryStorage.fromEvents('k', rows)
    // The state an older build cached, stamped with the old cache version.
    const state = foldEvents(rows.filter((row) => row.type !== 'assistant/chunk'))
    const current = encodeFoldCache('k', state, {
      lastSeq: state.lastSeq,
      legacyThroughSeq: state.lastSeq,
      headDigest: null,
    })
    const old = { ...current, version: 1 } as unknown as typeof current
    ;(storage as unknown as { book(key: string): { foldCache?: unknown } }).book('k').foldCache = old
    expect(() => decodeFoldCache('k', old, state.lastSeq)).toThrow('fold cache envelope is invalid')
    await expect(open(storage)).rejects.toThrow('E_UNKNOWN_EVENT')
  })

  it('opens the same ledger once the row is one this build writes', async () => {
    const cells = JSON.parse(readFileSync(fixture.replace(/\.jsonl$/, '.op.json'), 'utf8'))
    await expect(open(MemoryStorage.fromEvents('k', readLedger(), { opCells: cells }))).resolves.toBeDefined()
  })
})

function readLedger(): Event[] {
  return readFileSync(fixture, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Event)
}

/**
 * A ledger written before the program counter left the rows holds `op.state` rows. That type no
 * longer exists either, so the same holds: the ledger does not open, and no fold cache written by
 * that build lets a replay step over the row.
 */
const opFixture = fileURLToPath(new URL('../fixtures/crash/05-checkpoint-need_assistant', import.meta.url))

function opLedger(): Event[] {
  const rows = readFileSync(`${opFixture}.jsonl`, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Event)
  const [cell] = JSON.parse(readFileSync(`${opFixture}.op.json`, 'utf8')) as Array<{ data: unknown }>
  const last = rows.at(-1) as Event
  // What that build wrote at the end of the batch: the program counter as a row.
  rows.push({ ...last, seq: last.seq + 1, type: 'op.state', register: 'op.state', data: cell?.data } as Event)
  return rows
}

/** A fold cache at the head of `rows`, stamped with `version`. */
function foldAt(rows: Event[], version: number): FoldCacheRecord {
  const state = foldEvents(rows.filter((row) => row.type !== 'op.state'))
  const record = encodeFoldCache(
    'k',
    { ...state, lastSeq: rows.length },
    {
      lastSeq: rows.length,
      legacyThroughSeq: rows.length,
      headDigest: null,
    },
  )
  return { ...record, version } as unknown as FoldCacheRecord
}

describe('a ledger with the removed op.state row type', () => {
  it('fails to open, and hands the lease straight back', async () => {
    const storage = MemoryStorage.fromEvents('k', opLedger())
    await expect(open(storage)).rejects.toThrow('E_UNKNOWN_EVENT')
    // A second writer is refused for the same reason, not for a lease the first one kept.
    await expect(open(storage, 'r2')).rejects.toThrow('E_UNKNOWN_EVENT')
  })

  it('refuses the fold cache that build wrote, so the replay starts from the first row', async () => {
    const rows = opLedger()
    const storage = MemoryStorage.fromEvents('k', rows)
    const book = (storage as unknown as { book(key: string): { foldCache?: unknown } }).book('k')
    const starts: unknown[] = []
    const openLog = (writerRunId: string) =>
      SessionLogImpl.open({
        storage,
        key: 'k',
        writerRunId,
        ttlMs: 60_000,
        ids: defaultIds(clock),
        clock,
        timers: noTimers,
        replay: { start: (fold) => starts.push(fold), page: () => undefined },
      })
    book.foldCache = foldAt(rows, 2)
    await (await openLog('old')).close()
    // The current version is accepted, which is what makes the refusal above the version's doing.
    book.foldCache = foldAt(rows, 3)
    await (await openLog('current')).close()
    expect(starts[0]).toBeUndefined()
    expect(starts[1]).toMatchObject({ seq: rows.length })
    await expect(open(storage)).rejects.toThrow('E_UNKNOWN_EVENT')
  })
})
