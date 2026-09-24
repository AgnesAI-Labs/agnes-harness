import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { defaultIds } from '../src/ids.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
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

const open = (storage: MemoryStorage) =>
  openTracked({
    storage,
    key: 'k',
    writerRunId: 'r',
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
    await expect(open(MemoryStorage.fromEvents('k', readLedger()))).resolves.toBeDefined()
  })
})

function readLedger(): Event[] {
  return readFileSync(fixture, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Event)
}
