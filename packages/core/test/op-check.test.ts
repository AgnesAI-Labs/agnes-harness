import { describe, expect, it } from 'vitest'
import { defaultIds } from '../src/ids.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { RegisterMap, type RegisterRow, type StorageAdapter } from '../src/log/storage.js'
import { openTracked } from '../src/reduce/tracker.js'
import { OP_CHECK_CASES, type Tamperable } from '../testkit/op-check-cases.js'
import { type SweepStore, sweepOpenPoints } from '../testkit/op-check-sweep.js'
import { TRANSITION_SCENARIOS } from '../testkit/record-transitions.js'
import { crashFixtures, crashStorage } from './helpers/crash-fixtures.js'

type Book = { registers: RegisterMap; opCells?: Map<string, RegisterRow> }
const memory: Tamperable = {
  make: () => new MemoryStorage(),
  async setOpCell(storage, key, lane, cell) {
    const book = (storage as unknown as { book(key: string): Book }).book(key)
    book.opCells ??= new Map()
    const row = { register: 'op.state', key: lane, seq: cell?.seq ?? 0, data: cell?.data ?? null }
    if (cell) book.opCells.set(lane, row)
    else book.opCells.delete(lane)
    book.registers.apply(row)
  },
}

describe('the open-time check of the program-counter cells (MemoryStorage)', () => {
  for (const [name, run] of Object.entries(OP_CHECK_CASES)) it(name, () => run(memory))
})

const open = (storage: StorageAdapter, key = 'k') =>
  openTracked({
    storage,
    key,
    writerRunId: 'check',
    ttlMs: 60_000,
    ids: defaultIds(() => 0),
    clock: () => 0,
    timers: { setTimeout: () => 0, clearTimeout: () => undefined },
  })

type Books = { books: Map<string, Book & Record<string, unknown>> }
// A copy of every book, register maps rebuilt rather than shared, and no lease held.
const memorySweep: SweepStore = {
  make: () => new MemoryStorage(),
  snapshot(live) {
    const copy = new MemoryStorage()
    const into = (copy as unknown as Books).books
    for (const [key, book] of (live as unknown as Books).books) {
      const registers = new RegisterMap()
      registers.replaceAll(book.registers.values())
      into.set(key, {
        ...book,
        events: [...(book.events as unknown[])],
        integrity: new Map(book.integrity as Map<number, unknown>),
        registers,
        ...(book.opCells ? { opCells: new Map(book.opCells) } : {}),
        lease: undefined,
      })
    }
    return copy
  },
  dispose: (storage) => storage.close(),
}

// Every legal path must pass: a check that refuses a state the code writes turns a crash into a
// session that never opens again.
describe('no legal state is refused', () => {
  it.each(crashFixtures())('crash fixture %s', async (f) => {
    const { log } = await open(crashStorage(f))
    await log.close()
  })

  it.each(TRANSITION_SCENARIOS)(
    'every session at every commit and child creation of %s',
    async (name) => {
      const result = await sweepOpenPoints(name, memorySweep)
      expect(result.failures).toEqual([])
      expect(result.points).toBeGreaterThan(0)
      if (name.endsWith('-child')) expect(result.childOpens).toBeGreaterThan(0)
    },
    30_000,
  )
})
