import { describe, expect, it } from 'vitest'
import { defaultIds } from '../src/ids.js'
import { replacePageYieldForTest } from '../src/log/fork-seed.js'
import { verifyLedger } from '../src/log/integrity.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { type OpenLogOptions, SessionLogImpl } from '../src/log/session-log.js'
import type { StorageAdapter } from '../src/log/storage.js'
import { openTracked } from '../src/reduce/tracker.js'
import type { EventInput } from '../src/types.js'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const timers = { setTimeout: () => 0, clearTimeout: () => undefined }
const note = (n: number): EventInput => ({
  actor,
  origin: 'principal',
  trust: 'trusted',
  type: 'user/message',
  data: { content: [{ type: 'text', text: `n${n}` }] },
})

function options(storage: StorageAdapter, writerRunId = 'writer'): OpenLogOptions {
  return {
    storage,
    key: 'k',
    writerRunId,
    ttlMs: 60_000,
    ids: defaultIds(),
    clock: () => Date.parse('2026-09-24T00:00:00.000Z'),
    timers,
  }
}

/** 1,234 rows: three integrity pages and three replay pages of 500. */
async function seeded(): Promise<MemoryStorage> {
  const storage = new MemoryStorage()
  const log = await SessionLogImpl.open(options(storage))
  for (let i = 0; i < 1_234; i += 200)
    await log.append(Array.from({ length: Math.min(200, 1_234 - i) }, (_, j) => note(i + j)))
  await log.close()
  return storage
}

function counting() {
  let yields = 0
  const restore = replacePageYieldForTest(() => {
    yields++
  })
  return { count: () => yields, restore }
}

describe('page yields while a ledger is verified and replayed', () => {
  it('verifyLedger yields between pages only when asked to', async () => {
    const storage = await seeded()
    const probe = counting()
    try {
      await verifyLedger(storage, 'k', 1_234)
      expect(probe.count()).toBe(0)
      let passed = 0
      await verifyLedger(storage, 'k', 1_234, () => {
        passed++
      })
      expect(passed).toBe(2)
    } finally {
      probe.restore()
    }
  })

  it('opening a log yields between its integrity pages', async () => {
    const storage = await seeded()
    const probe = counting()
    try {
      const log = await SessionLogImpl.open(options(storage, 'again'))
      expect(probe.count()).toBe(2)
      await log.close()
    } finally {
      probe.restore()
    }
  })

  it('opening a tracked session folds while it verifies, yielding between those pages only', async () => {
    const storage = await seeded()
    const probe = counting()
    try {
      const { log } = await openTracked({ ...options(storage, 'again'), pageSize: 500 })
      expect(probe.count()).toBe(2)
      await log.close()
    } finally {
      probe.restore()
    }
  })

  it('a second writer arriving while the first is still verifying is refused', async () => {
    const storage = await seeded()
    let hold!: () => void
    const held = new Promise<void>((resolve) => {
      hold = resolve
    })
    let integrityPages = 0
    let reached!: () => void
    const atSecondPage = new Promise<void>((resolve) => {
      reached = resolve
    })
    const slow: StorageAdapter = Object.create(storage, {
      scanIntegrity: {
        value: async (...args: Parameters<StorageAdapter['scanIntegrity']>) => {
          if (++integrityPages === 2) {
            reached()
            await held
          }
          return storage.scanIntegrity(...args)
        },
      },
    })
    const first = SessionLogImpl.open(options(slow, 'first'))
    await atSecondPage
    await expect(SessionLogImpl.open(options(storage, 'second'))).rejects.toMatchObject({
      code: 'E_WRITER_LEASE',
    })
    hold()
    const log = await first
    await log.append([note(9_999)])
    const tail = await storage.scan('k', { fromSeq: 1_235, toSeq: 1_235, limit: 1 })
    expect(tail.map((e) => e.seq)).toEqual([1_235])
    await log.close()
  })
})
