import { performance } from 'node:perf_hooks'
import { validateAgainst } from '@agnes/protocol-validation'
import { expect, it } from 'vitest'
import { UITimeline } from '../gen/ts/agnes-v1.js'

it('keeps large projection validation below the interpreted cost without changing the result', () => {
  const value = {
    sessionId: 'synthetic',
    upto: 800,
    generation: 1,
    opState: null,
    turns: [],
    nodes: Array.from({ length: 500 }, (_, i) => ({
      kind: 'assistant',
      id: `n${i}`,
      seq: i + 1,
      text: 'Synthetic history '.repeat(40),
      thinking: '',
      streaming: false,
    })),
  }
  const interpreted = { ...UITimeline }
  const elapsed = (schema: typeof UITimeline) => {
    const start = performance.now()
    for (let i = 0; i < 200; i++) expect(validateAgainst(schema, value).ok).toBe(true)
    return performance.now() - start
  }
  elapsed(UITimeline)
  elapsed(interpreted)
  const planned: number[] = []
  const baseline: number[] = []
  for (let i = 0; i < 5; i++) {
    // Alternate order to keep warmup and scheduler interference from favouring one implementation.
    if (i % 2) {
      baseline.push(elapsed(interpreted))
      planned.push(elapsed(UITimeline))
    } else {
      planned.push(elapsed(UITimeline))
      baseline.push(elapsed(interpreted))
    }
  }
  const median = (values: number[]) => values.sort((a, b) => a - b)[2] ?? Infinity
  expect(median(planned)).toBeLessThan(median(baseline) * 0.7)
}, 30_000)
