import { describe, expect, it } from 'vitest'
import { defaultIds } from '../src/ids.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { SessionLogImpl } from '../src/log/session-log.js'
import type { EventInput } from '../src/types.js'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const timers = { setTimeout: () => 0, clearTimeout: () => undefined }
const note = (i: number): EventInput => ({
  actor,
  origin: 'principal',
  trust: 'trusted',
  type: 'user/message',
  data: { content: [{ type: 'text', text: `row ${i}` }] },
})

const open = (storage: MemoryStorage, writerRunId: string) =>
  SessionLogImpl.open({
    storage,
    key: 'k',
    writerRunId,
    ttlMs: 60_000,
    ids: defaultIds(),
    clock: () => Date.parse('2026-09-12T00:00:00.000Z'),
    timers,
  })

describe('session open statistics', () => {
  it('reports the ledger size and the time spent in each phase of opening', async () => {
    const storage = new MemoryStorage()
    const writer = await open(storage, 'w1')
    for (let i = 0; i < 1200; i += 100)
      await writer.append(Array.from({ length: 100 }, (_, j) => note(i + j)))
    await writer.close()

    const log = await open(storage, 'w2')
    const stats = log.openStats
    expect(stats.lastSeq).toBe(1200)
    expect(stats.storedBytes).toBeGreaterThan(0)
    expect(stats.maxRowBytes).toBeGreaterThan(0)
    expect(stats.maxRowBytes).toBeLessThanOrEqual(stats.storedBytes ?? 0)
    for (const field of ['read', 'verify', 'fold', 'registers', 'total'] as const)
      expect(stats.ms[field]).toBeGreaterThanOrEqual(0)
    expect(stats.ms.total).toBeGreaterThanOrEqual(stats.ms.verify)
    expect(stats.checkpoint.used).toBe(false)
    await log.close()
  })

  it('still opens when the size query fails, and only leaves the sizes out', async () => {
    class SizeQueryFails extends MemoryStorage {
      override async ledgerStats(): Promise<never> {
        throw new Error('database is locked')
      }
    }
    const storage = new SizeQueryFails()
    const writer = await open(storage, 'w1')
    await writer.append([note(1)])
    await writer.close()
    const log = await open(storage, 'w2')
    expect(log.lastSeq).toBe(1)
    expect(log.openStats.lastSeq).toBe(1)
    expect(log.openStats.storedBytes).toBeUndefined()
    expect(log.openStats.maxRowBytes).toBeUndefined()
    await log.close()
  })
})
