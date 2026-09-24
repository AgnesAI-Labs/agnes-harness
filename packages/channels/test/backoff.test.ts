import { expect, it } from 'vitest'
import { backoffDelays } from '../src/runner/backoff.js'

it('doubles to the cap and applies deterministic twenty-percent jitter', () => {
  const delays = backoffDelays({ baseMs: 1_000, maxMs: 8_000, jitter: () => 0.5 })
  expect(Array.from({ length: 5 }, () => delays.next().value)).toEqual([1_000, 2_000, 4_000, 8_000, 8_000])
  expect(backoffDelays({ baseMs: 1_000, maxMs: 8_000, jitter: () => 0 }).next().value).toBe(800)
  expect(backoffDelays({ baseMs: 1_000, maxMs: 8_000, jitter: () => 1 }).next().value).toBe(1_200)
})
