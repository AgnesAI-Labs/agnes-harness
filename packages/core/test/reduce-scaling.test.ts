import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { UIProjectionCell } from '../src/project/ui.js'
import { foldEvents, reduce } from '../src/reduce/reducer.js'
import type { LedgerState } from '../src/reduce/state.js'
import type { Event } from '../src/types.js'
import { toolHeavyLedger } from '../testkit/tool-heavy-ledger.js'

// Timing guards. The copy budget is what gates a merge; these back it up with wall-clock evidence
// and give up as soon as one run is over budget, so a regression fails fast instead of timing out.

/** Rows of a `calls`-call session that stop with an error once `budgetMs` has passed. */
function* within(calls: number, budgetMs: number): Generator<Event> {
  const start = performance.now()
  let n = 0
  for (const row of toolHeavyLedger({ calls })) {
    if (++n % 1000 === 0 && performance.now() - start > budgetMs)
      throw new Error(`${calls} calls: over the ${budgetMs} ms budget after ${n} rows`)
    yield row
  }
}

/** The fastest of `runs` runs of `work`, each held to `budgetMs`. */
function fastest(runs: number, budgetMs: number, work: (budgetMs: number) => void): number {
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i < runs; i++) {
    const start = performance.now()
    work(budgetMs)
    best = Math.min(best, performance.now() - start)
  }
  return best
}

const fold = (calls: number) => (budgetMs: number) => {
  foldEvents(within(calls, budgetMs))
}

const uiFold = (calls: number) => (budgetMs: number) => {
  const cell = new UIProjectionCell('tool-heavy', 'main')
  for (const row of within(calls, budgetMs)) cell.apply([row])
  cell.sealReplay()
}

describe('folding scales linearly with the session', () => {
  it('folds 16k calls in at most eight times the time of 4k', { timeout: 120_000 }, () => {
    const small = fastest(3, 1_000, fold(4000))
    const large = fastest(3, 3_000, fold(16_000))
    expect(large / small).toBeLessThan(8)
  })

  it('appends one more tool step at the head of a 16k-call session in a bounded time', {
    timeout: 120_000,
  }, () => {
    const head = foldEvents(within(16_000, 3_000))
    const rows = [...toolHeavyLedger({ calls: 16_001 })]
    const step = rows.filter((row) => row.seq > head.lastSeq)
    const times: number[] = []
    for (let i = 0; i < 21; i++) {
      const start = performance.now()
      // The relation check's trial, the tracker and the UI cell each fold the batch once.
      for (let pass = 0; pass < 3; pass++) {
        let s: LedgerState = head
        for (const row of step) s = reduce(s, row)
      }
      times.push(performance.now() - start)
    }
    times.sort((a, b) => a - b)
    expect(times[10]).toBeLessThan(5)
  })

  it('builds the UI cell of 16k calls in at most eight times the time of 4k', {
    timeout: 120_000,
  }, () => {
    // Alone these take about 0.3 s and 1.1 s; the budgets leave room for a loaded parallel run.
    const small = fastest(3, 2_000, uiFold(4000))
    const large = fastest(3, 6_000, uiFold(16_000))
    expect(large / small).toBeLessThan(8)
  })
})
