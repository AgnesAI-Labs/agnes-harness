import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { defaultIds } from '../src/ids.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { SessionLogImpl } from '../src/log/session-log.js'
import { openTracked } from '../src/reduce/tracker.js'
import type { Event } from '../src/types.js'
import { noTimers } from './helpers/open-session.js'

/**
 * A ledger written before streamed text left the ledger holds `assistant/chunk` rows. That type no
 * longer exists, so such a ledger must fail to open rather than be folded around a row nobody
 * understands.
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
 * longer exists either, so the same holds: the ledger does not open, and the replay reads every row.
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

describe('a ledger with the removed op.state row type', () => {
  it('fails to open, and hands the lease straight back', async () => {
    const storage = MemoryStorage.fromEvents('k', opLedger())
    await expect(open(storage)).rejects.toThrow('E_UNKNOWN_EVENT')
    // A second writer is refused for the same reason, not for a lease the first one kept.
    await expect(open(storage, 'r2')).rejects.toThrow('E_UNKNOWN_EVENT')
  })

  it("replays that build's ledger from the first row, the removed row included", async () => {
    const rows = opLedger()
    const storage = MemoryStorage.fromEvents('k', rows)
    const seen: number[] = []
    const log = await SessionLogImpl.open({
      storage,
      key: 'k',
      writerRunId: 'probe',
      ttlMs: 60_000,
      ids: defaultIds(clock),
      clock,
      timers: noTimers,
      replay: { page: (events) => seen.push(...events.map((event) => event.seq)) },
    })
    await log.close()
    expect(seen).toEqual(rows.map((row) => row.seq))
    await expect(open(storage)).rejects.toThrow('E_UNKNOWN_EVENT')
  })
})
