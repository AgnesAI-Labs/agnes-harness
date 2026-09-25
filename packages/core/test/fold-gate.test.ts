import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SurfaceCache } from '../src/project/surface.js'
import { foldEvents } from '../src/reduce/reducer.js'
import type { Event } from '../src/types.js'

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
})
