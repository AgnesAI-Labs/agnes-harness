import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { defaultIds } from '../src/ids.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import type { StorageAdapter } from '../src/log/storage.js'
import { SurfaceCache } from '../src/project/surface.js'
import { foldEvents } from '../src/reduce/reducer.js'
import { openTracked } from '../src/reduce/tracker.js'
import type { Event, EventInput } from '../src/types.js'

const events = readFileSync(new URL('../fixtures/reduce/long-session.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as Event)

const best = (run: () => void): number => {
  let elapsed = Number.POSITIVE_INFINITY
  for (let attempt = 0; attempt < 3; attempt++) {
    const startedAt = performance.now()
    run()
    elapsed = Math.min(elapsed, performance.now() - startedAt)
  }
  return elapsed
}

// Wall-clock regression gates are opt-in because a normal package/root run fans out workers and
// measures scheduler contention instead of fold cost. Run this file with AGNES_CORE_PERF=1 and
// --maxWorkers=1; the exploratory 500/50 ms thresholds stay unchanged.
describe.runIf(process.env.AGNES_CORE_PERF === '1')('fold wall-clock regression gate', () => {
  it('folds 10,000 events under 500 ms, best of three', () => {
    expect(best(() => foldEvents(events))).toBeLessThan(500)
  })

  it('pushes a 20-event tail under 50 ms, best of three', () => {
    const caches = Array.from({ length: 3 }, () => {
      const cache = new SurfaceCache('main')
      cache.push(events)
      return cache
    })
    const tail = events.slice(0, 20).map((event) => ({ ...event, seq: event.seq + 20_000 }))
    let next = 0
    expect(best(() => caches[next++]?.push(tail))).toBeLessThan(50)
  })

  it('opens a storage-backed warm ledger in less than half the cold time', async () => {
    const storage = new MemoryStorage()
    const options = {
      key: 'perf',
      storage,
      writerRunId: 'seed',
      ttlMs: 60_000,
      clock: () => Date.now(),
      ids: defaultIds(),
      relationCheck: () => undefined,
    }
    const seeded = await openTracked(options)
    await seeded.log.append(events.map(({ seq: _seq, id: _id, ts: _ts, ...event }) => event as EventInput))
    await seeded.log.close()

    const withoutCache = new Proxy(storage, {
      get(target, property, receiver) {
        if (property === 'foldCache') return undefined
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as StorageAdapter
    const measure = async (candidate: StorageAdapter, prefix: string): Promise<number> => {
      let fastest = Number.POSITIVE_INFINITY
      for (let attempt = 0; attempt < 3; attempt++) {
        const startedAt = performance.now()
        const opened = await openTracked({
          ...options,
          storage: candidate,
          writerRunId: `${prefix}-${attempt}`,
        })
        fastest = Math.min(fastest, performance.now() - startedAt)
        expect(opened.surface.nodes()).toHaveLength(3_500)
        await opened.log.close()
      }
      return fastest
    }
    const cold = await measure(withoutCache, 'cold')
    const warm = await measure(storage, 'warm')
    console.info(
      `storage fold open: cold=${cold.toFixed(2)}ms warm=${warm.toFixed(2)}ms ratio=${(warm / cold).toFixed(3)}`,
    )
    expect(warm).toBeLessThan(cold / 2)
  }, 30_000)
})
